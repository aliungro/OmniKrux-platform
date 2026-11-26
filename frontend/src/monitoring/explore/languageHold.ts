// A query never runs in the wrong language (C1). When the source's language changes under a text
// (another source, another project), the text is held: nothing runs, nothing is kept, and the page
// says why, until the text changes or a source of its language is back. A trail pick can hold a
// text itself when it can't bring that text's own source back.

import { useEffect, useRef, useState } from "react";
import type { LinkOut } from "../api/types";
import { metricNames } from "../build/promql";

export type Language = "PromQL" | "LogQL";
export type Held = { expr: string; from: Language };

export const LANGUAGE_HELD = "This query is {from}, and {source} reads {to}, so it wasn't run. Write a {to} query, or pick a {fromType} source.";
const LANGUAGE_SOURCES: Record<Language, string> = { PromQL: "Prometheus-compatible", LogQL: "Loki" };

/** The language a source reads. */
export const languageOf = (type: LinkOut["source_type"]): Language => (type === "loki" ? "LogQL" : "PromQL");

/** The held note: what the text is, what the source reads, and the two ways on. */
export function heldWords(held: Held, sourceName: string, to: Language): string {
  return LANGUAGE_HELD.replace("{from}", held.from).replace("{source}", sourceName).replaceAll("{to}", to)
    .replace("{fromType}", LANGUAGE_SOURCES[held.from]);
}

/** Outside quotes and backticks: what is left to read the text's shape from. */
const unquoted = (expr: string) => expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""');

/**
 * A text's language when only one can read it: a log pipeline after a selector (`} |=`, `} | json`,
 * `} != "x"`) is LogQL; a text that names a metric is PromQL. A bare selector reads in both: `null`.
 */
export function textLanguage(expr: string): Language | null {
  const text = unquoted(expr);
  if (/\}\s*(\||(!=|!~)\s*"")/.test(text)) return "LogQL";
  if (text.trim() !== "" && metricNames(expr).length > 0) return "PromQL";
  return null;
}

/**
 * The hold for this source and text. It is worked out while rendering, in one step, so the frame
 * that first shows a source of the other language is already held (and a new text arriving in the
 * same render as a new language is judged as the new text, never cleared by the old hold).
 */
export function useLanguageHold(source: Pick<LinkOut, "source_type"> | null, expr: string) {
  const language = source ? languageOf(source.source_type) : null;
  const [state, setState] = useState<{ held: Held | null; seen: Language | null }>({ held: null, seen: language });
  // The text a trail chip brought with its own source: it fits that source, so it is never held.
  const brought = useRef<string | null>(null);

  let next = state;
  // A project that is loading has no source yet: that is no change of language.
  if (language !== null && language !== state.seen) {
    let held = state.held !== null && state.held.expr === expr ? state.held : null;
    if (state.seen !== null) {
      if (held !== null && held.from === language) held = null;
      else if (held === null && expr.trim() !== "" && brought.current !== expr) held = { expr, from: state.seen };
    }
    next = { held, seen: language };
  } else if (state.held !== null && state.held.expr !== expr) {
    // Any other text ends the hold.
    next = { ...state, held: null };
  }
  if (next !== state) setState(next);
  useEffect(() => { brought.current = null; });

  const held = next.held;
  return {
    held,
    holding: held !== null && language !== null && held.from !== language,
    /** Hold this text now (set in the same update as the text itself). */
    hold: (text: string, from: Language) => setState((s) => ({ ...s, held: { expr: text, from } })),
    /** The next text comes with its own source: don't hold it. */
    bring: (text: string) => { brought.current = text; },
  };
}
