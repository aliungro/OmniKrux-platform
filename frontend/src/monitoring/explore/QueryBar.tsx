// The live query bar (X1): the query in Geist Mono, which runs as you type, and the meta line under
// it saying how the last run ended. The meta line is a polite live region; it changes when a run
// starts and ends, never on each keystroke.

import { forwardRef, type KeyboardEvent, type ReactNode } from "react";
import { pressed } from "../../features/chrome/shortcuts";
import type { ExploreKind, ExploreRunState } from "./useExploreRun";
import s from "./ExplorePage.module.css";

const MAX_ROWS = 6;
export const NO_QUERY = "Pick a metric on the left, or type a query.";
export const FAILED_TITLE = { unreachable: "Source unreachable", error: "Query error" } as const;

interface QueryBarProps {
  expr: string;
  /** PromQL for a Prometheus-compatible source, LogQL for Loki. */
  language: "PromQL" | "LogQL";
  onChange(expr: string): void;
  /** Ctrl+Enter: run now. */
  onRun(): void;
  /** Esc: the keyboard leaves the field (to the chart, or the heading). */
  onLeave(): void;
}

export const QueryBar = forwardRef<HTMLTextAreaElement, QueryBarProps>(function QueryBar({ expr, language, onChange, onRun, onLeave }, ref) {
  const rows = Math.min(MAX_ROWS, Math.max(1, expr.split("\n").length));
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pressed("exploreRun", e)) {
      e.preventDefault();
      if (!e.repeat) onRun();
    } else if (e.key === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      onLeave();
    }
  };
  return (
    <div className={s.bar}>
      <span className={s.lang} aria-hidden="true">{language}</span>
      <textarea
        ref={ref}
        className={s.input}
        aria-label="Query"
        aria-keyshortcuts="q"
        aria-description={`${language}. Runs as you type; Ctrl+Enter runs it now.`}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        rows={rows}
        value={expr}
        placeholder={language === "LogQL" ? '{app="api"} |= "error"' : 'rate(http_requests_total{job="api"}[5m])'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
});

const two = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

/** The meta line: how the last run ended (while the next waits), or Running…. */
export function MetaLine({ state, expr, kind, timeText }: { state: ExploreRunState; expr: string; kind: ExploreKind; timeText: string }) {
  let body: ReactNode = null;
  let tone: "bad" | "quiet" = "quiet";
  if (state.status === "running") {
    body = "Running…";
  } else if (state.shown === "idle") {
    // Nothing ran yet, or the field was emptied: the hint, only while the field is empty.
    body = expr.trim() === "" ? NO_QUERY : null;
  } else if (state.shown === "done" && state.data) {
    const n = (state.kind ?? kind) === "logs" ? `${state.data.logs.length} ${state.data.logs.length === 1 ? "line" : "lines"}`
      : `${state.data.series.length} series`;
    body = (
      <>
        <span className={s.metaOk}>✓ {n} · {state.tookMs ?? 0} ms</span>
        <span className={s.metaSep}>·</span>
        <span>{timeText}</span>
        {state.at !== null && (
          <>
            <span className={s.metaSep}>·</span>
            <span>updated {clock(state.at)}</span>
          </>
        )}
      </>
    );
  } else if (state.shown === "invalid") {
    tone = "bad";
    body = state.lastGood ? `✗ ${state.message} · showing the last result` : `✗ ${state.message}`;
  } else if (state.shown === "failed") {
    tone = "bad";
    body = `✗ ${FAILED_TITLE[state.failure ?? "error"]}`;
  }
  return (
    <p className={`${s.meta} ${tone === "bad" ? s.metaBad : ""}`} data-explore-meta="" aria-live="polite">
      {body}
    </p>
  );
}
