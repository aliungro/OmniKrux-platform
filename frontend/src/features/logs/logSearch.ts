import { useMemo, useRef } from "react";
import { isMarker, type LogBuffer } from "./logBuffer";

export interface SearchOptions {
  caseSensitive: boolean;
}

const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** The query as a regular expression that matches it literally. */
function pattern(query: string, caseSensitive: boolean, global: boolean): RegExp {
  return new RegExp(query.replace(SPECIAL, "\\$&"), (global ? "g" : "") + (caseSensitive ? "" : "i"));
}

/** Indices of the items whose text contains `query`, from index `from` on. Markers never match. */
export function searchLines(buf: LogBuffer, query: string, opts: SearchOptions, from = 0): number[] {
  if (query === "") return [];
  const re = pattern(query, opts.caseSensitive, false);
  const hits: number[] = [];
  for (let i = Math.max(0, from); i < buf.length; i++) {
    const item = buf.get(i)!;
    if (!isMarker(item) && re.test(item.text)) hits.push(i);
  }
  return hits;
}

/**
 * Which match to go to from position `at` (in the same numbering as `matches`, which is sorted):
 * the first one after it (dir 1) or the last one before it (dir -1), wrapping round at the ends.
 * Returns an index into `matches`, or -1 when there are none.
 */
export function stepMatch(matches: readonly number[], at: number, dir: 1 | -1): number {
  if (matches.length === 0) return -1;
  // First match greater than `at` (dir 1) or at least `at` (dir -1).
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dir === 1 ? matches[mid] <= at : matches[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  if (dir === 1) return lo === matches.length ? 0 : lo;
  return lo === 0 ? matches.length - 1 : lo - 1;
}

let lastSplit: { query: string; caseSensitive: boolean; re: RegExp } | null = null;

/** The text cut into plain and matching parts: even indices are plain, odd ones match. */
export function splitMatches(text: string, query: string, caseSensitive: boolean): string[] {
  if (query === "") return [text];
  if (lastSplit === null || lastSplit.query !== query || lastSplit.caseSensitive !== caseSensitive) {
    const re = pattern(query, caseSensitive, true);
    lastSplit = { query, caseSensitive, re: new RegExp(`(${re.source})`, re.flags) };
  }
  return text.split(lastSplit.re);
}

interface SearchCache {
  buffer: LogBuffer;
  query: string;
  caseSensitive: boolean;
  /** Sequence numbers of the matching items still in the buffer, oldest first. */
  seqs: number[];
  /** The first sequence number not searched yet. */
  next: number;
}

/**
 * The sequence numbers of matching items, kept up to date as the buffer changes: only items that
 * arrived since the last call are searched, and evicted ones fall off the front. Re-renders when
 * `version` changes.
 */
export function useLogSearch(
  buffer: LogBuffer,
  version: number,
  query: string,
  caseSensitive: boolean,
): readonly number[] {
  const cache = useRef<SearchCache | null>(null);
  return useMemo(() => {
    void version; // the buffer mutates in place; its version says when to look again
    let c = cache.current;
    if (c === null || c.buffer !== buffer || c.query !== query || c.caseSensitive !== caseSensitive) {
      c = { buffer, query, caseSensitive, seqs: [], next: 0 };
    }
    const len = buffer.length;
    if (query === "" || len === 0) {
      c.seqs = [];
      c.next = len === 0 ? 0 : buffer.get(len - 1)!.seq + 1;
    } else {
      const first = buffer.get(0)!.seq;
      let gone = 0;
      while (gone < c.seqs.length && c.seqs[gone] < first) gone++;
      const fresh = searchLines(buffer, query, { caseSensitive }, c.next - first).map((i) => i + first);
      if (gone > 0 || fresh.length > 0) c.seqs = c.seqs.slice(gone).concat(fresh);
      c.next = buffer.get(len - 1)!.seq + 1;
    }
    cache.current = c;
    return c.seqs;
  }, [buffer, version, query, caseSensitive]);
}
