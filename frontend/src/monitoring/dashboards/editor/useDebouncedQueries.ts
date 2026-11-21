// The queries a panel runs while its draft is being typed into: they follow the draft `delayMs`
// after its last query change, so a run leaves once the typing stops (D1). `flush` applies the
// draft at once (Ctrl+Enter). A different panel, or no delay (outside edit mode), applies at once.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelSpec, QuerySpec } from "../schema";

export interface DebouncedQueries {
  queries: QuerySpec[];
  /** Run the draft's queries now. */
  flush(): void;
  /** The draft's queries differ from the ones run: the typing hasn't stopped yet. */
  pending: boolean;
}

type Applied = { id: string; queries: QuerySpec[]; text: string };
const applied = (p: PanelSpec): Applied => ({ id: p.id, queries: p.queries, text: JSON.stringify(p.queries) });

export function useDebouncedQueries(panel: PanelSpec, delayMs = 300): DebouncedQueries {
  const [ran, setRan] = useState<Applied>(() => applied(panel));
  const latest = useRef(panel);
  latest.current = panel;
  const text = JSON.stringify(panel.queries);
  // Same text: nothing to wait for (a JSON edit may hand over equal queries as new objects).
  const same = ran.id === panel.id && ran.text === text;
  const immediate = delayMs <= 0 || ran.id !== panel.id;

  useEffect(() => {
    if (same) return;
    if (immediate) {
      setRan(applied(latest.current));
      return;
    }
    const timer = setTimeout(() => setRan(applied(latest.current)), delayMs);
    return () => clearTimeout(timer);
  }, [text, same, immediate, delayMs]);

  const flush = useCallback(() => {
    const p = latest.current;
    setRan((was) => (was.id === p.id && was.queries === p.queries ? was : applied(p)));
  }, []);

  return { queries: same || immediate ? panel.queries : ran.queries, flush, pending: !same && !immediate };
}
