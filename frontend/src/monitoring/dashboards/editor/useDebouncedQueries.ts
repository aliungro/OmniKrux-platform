// The queries a panel runs while its draft is being typed into: they follow the draft `delayMs`
// after its last query change, so a run leaves once the typing stops (D1). A logs panel's Lines
// (`limit`, part of its request) lags with them. `flush` applies the draft at once (Ctrl+Enter).
// A different panel, another chart type, or no delay (outside edit mode) applies at once.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelSpec, PanelType, QuerySpec } from "../schema";

export interface DebouncedQueries {
  queries: QuerySpec[];
  /** A logs panel's Lines as last applied (null for other types). */
  limit: number | null;
  /** Run the draft's queries now. */
  flush(): void;
  /** The draft's queries (or Lines) differ from the ones run: the typing hasn't stopped yet. */
  pending: boolean;
}

type Applied = { id: string; type: PanelType; queries: QuerySpec[]; limit: number | null; text: string };
const limitOf = (p: PanelSpec) => (p.type === "logs" ? p.options.limit : null);
const textOf = (p: PanelSpec) => JSON.stringify([p.queries, limitOf(p)]);
const applied = (p: PanelSpec): Applied => ({ id: p.id, type: p.type, queries: p.queries, limit: limitOf(p), text: textOf(p) });

export function useDebouncedQueries(panel: PanelSpec, delayMs = 300): DebouncedQueries {
  const [ran, setRan] = useState<Applied>(() => applied(panel));
  const latest = useRef(panel);
  latest.current = panel;
  const text = textOf(panel);
  // Same text: nothing to wait for (a JSON edit may hand over equal queries as new objects).
  const same = ran.id === panel.id && ran.text === text;
  // A new chart type changes the request's shape: it runs at once, with the draft as it is.
  const immediate = delayMs <= 0 || ran.id !== panel.id || ran.type !== panel.type;

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
    setRan((was) => (was.id === p.id && was.text === textOf(p) ? was : applied(p)));
  }, []);

  const now = same || immediate;
  return { queries: now ? panel.queries : ran.queries, limit: now ? limitOf(panel) : ran.limit, flush, pending: !now };
}
