// The trail: the project's last queries as a toolbar of chips. One tab stop (the current query, or
// the newest); ← and → move between them; Enter or a click brings one back with its source. Each
// chip's title names its source; a chip from another source says so on its face, and the page says
// when picking one switched the source (`note`, a polite status beside the chips).

import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { normalizeQuery, type TrailEntry } from "./trailStore";
import s from "./ExplorePage.module.css";

const SHORT = 38;
/** One chip per query: the trail keeps each text once, whatever source it ran on. */
export const trailKey = (e: Pick<TrailEntry, "expr">) => normalizeQuery(e.expr);
const short = (text: string) => (text.length > SHORT ? `${text.slice(0, SHORT)}…` : text);

/**
 * A chip's words: its (cut) text, plus ` · {source}` when it ran on another source than the one
 * shown; its title is the whole text and its source. A source the project no longer links says so,
 * by the name the trail kept when there is one.
 */
export function trailWords(entry: Pick<TrailEntry, "expr">, sourceName: string | null, here: boolean, linked = true): { text: string; title: string } {
  const named = linked
    ? (sourceName === null ? "" : ` · ${sourceName}`)
    : (sourceName === null ? " · source not linked" : ` · ${sourceName} (not linked)`);
  return { text: here ? short(entry.expr) : `${short(entry.expr)}${named}`, title: `${entry.expr}${named}` };
}

interface Props {
  /** Oldest first, already cut to the ones shown. */
  entries: TrailEntry[];
  /** The key of the entry equal to the query being shown (its text, on the source shown). */
  currentKey: string;
  /** The source shown, and the names of the project's sources by id. */
  sourceId: string | null;
  sourceNames: Record<string, string>;
  /** What the last pick did that the page didn't show by itself ("Switched to …"); `null` for nothing. */
  note: string | null;
  onPick(entry: TrailEntry): void;
  onClear(): void;
}

export function Trail({ entries, currentKey, sourceId, sourceNames, note, onPick, onClear }: Props) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const [cursor, setCursor] = useState<string | null>(null);
  // The chip the keyboard was on when one was picked: picking moves it to the end, so it is
  // focused again where it lands (moving a focused node can drop the keyboard to <body>).
  const keep = useRef<string | null>(null);
  const keys = entries.map(trailKey);
  const stop = (cursor !== null && keys.includes(cursor) ? cursor : null)
    ?? (keys.includes(currentKey) ? currentKey : null)
    ?? keys[keys.length - 1];

  useLayoutEffect(() => {
    const k = keep.current;
    keep.current = null;
    if (k && document.activeElement !== refs.current.get(k)) refs.current.get(k)?.focus();
  });

  if (entries.length === 0) return null;

  const move = (to: number) => {
    const k = keys[Math.max(0, Math.min(keys.length - 1, to))];
    setCursor(k);
    refs.current.get(k)?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft") move(i - 1);
    else if (e.key === "ArrowRight") move(i + 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(keys.length - 1);
    else return;
    e.preventDefault();
  };
  const pick = (entry: TrailEntry, fromKeyboard: boolean) => {
    const k = trailKey(entry);
    setCursor(k);
    if (fromKeyboard || document.activeElement === refs.current.get(k)) keep.current = k;
    onPick(entry);
  };

  return (
    <div className={s.trailRow}>
      <div role="toolbar" aria-label="Recent queries" aria-orientation="horizontal" className={s.trail}>
        {entries.map((entry, i) => {
          const k = keys[i];
          const here = entry.sourceId === sourceId;
          const linked = Object.hasOwn(sourceNames, entry.sourceId);
          const words = trailWords(entry, linked ? sourceNames[entry.sourceId] : (entry.sourceName ?? null), here, linked);
          return (
            <button
              key={k}
              ref={(el) => { if (el) refs.current.set(k, el); else refs.current.delete(k); }}
              type="button"
              className={s.trailChip}
              tabIndex={k === stop ? 0 : -1}
              aria-current={k === currentKey ? "true" : undefined}
              aria-label={here ? entry.expr : words.title}
              title={words.title}
              onFocus={() => setCursor(k)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.repeat) { e.preventDefault(); pick(entry, true); return; }
                onKey(e, i);
              }}
              onClick={(e) => pick(entry, e.detail === 0)}
            >
              {words.text}
            </button>
          );
        })}
      </div>
      <button type="button" className={s.clear} onClick={onClear}>Clear</button>
      <p className={s.trailNote} role="status">{note}</p>
    </div>
  );
}
