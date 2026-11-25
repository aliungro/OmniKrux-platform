import { useEffect, useState } from "react";
import { checkFilter } from "../api/client";
import { validFilter } from "./FilterField";

/** How long a filter must stop changing before the source is asked whether anything matches it. */
export const FILTER_CHECK_AFTER_MS = 600;

export const filterMatchesNothing = (source: string) =>
  `Nothing in ${source} matches this filter. Check the label names and values.`;

/**
 * Whether the source is known to hold nothing the filter selects. Only a proven "nothing" says
 * so: a filter that can't be read, an empty one, a check that is still waiting, one that failed or
 * a source that couldn't say all read as `false`, and an answer for an older text never shows.
 * A plain call (nothing is cached).
 */
export function useFilterCheck(sourceId: string | null | undefined, filter: string): boolean {
  const text = filter.trim();
  const key = sourceId && text !== "" && validFilter(text) === null ? `${sourceId}|${text}` : null;
  const [empty, setEmpty] = useState<string | null>(null);
  useEffect(() => {
    if (key === null || !sourceId) return;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      checkFilter(sourceId, text, ctl.signal).then(
        (out) => { if (!ctl.signal.aborted) setEmpty(out.matches === false ? key : null); },
        () => { if (!ctl.signal.aborted) setEmpty(null); },
      );
    }, FILTER_CHECK_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [key, sourceId, text]);
  return key !== null && empty === key;
}
