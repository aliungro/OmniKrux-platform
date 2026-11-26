// The live query bar (X1): the query in Geist Mono, which runs as you type, and the meta line under
// it saying how the last run ended. Only that line is a polite live region, and it changes only when
// a run ends; **Running…** shows beside it, outside the live region, and never on each keystroke.

import { forwardRef, type KeyboardEvent, type ReactNode } from "react";
import { pressed } from "../../features/chrome/shortcuts";
import type { ExploreKind, ExploreRunState, LinesRunState } from "./useExploreRun";
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

/** `✓ {n} lines · {time words} · updated {hh:mm:ss}`: what a log query's run found. */
function linesBody(lines: LinesRunState): ReactNode {
  const n = lines.lines.length;
  return (
    <>
      <span className={s.metaOk}>✓ {n} {n === 1 ? "line" : "lines"}</span>
      {lines.timeText && (
        <>
          <span className={s.metaSep}>·</span>
          <span>{lines.timeText}</span>
        </>
      )}
      {lines.at !== null && (
        <>
          <span className={s.metaSep}>·</span>
          <span>updated {clock(lines.at)}</span>
        </>
      )}
    </>
  );
}

/**
 * The meta line: how the last run ended, kept while the next one waits and runs (dimmed, with
 * Running… beside it). Its time words are the ones that run read, not the picker's current range.
 * A log query has no chart: given `lines`, the line speaks for the log lines' run instead.
 */
export const NO_SUCH_METRIC = "No metric named {name} in {source} for this project.";

export function MetaLine({ state, expr, lines, missing }: { state: ExploreRunState; expr: string; kind?: ExploreKind; lines?: LinesRunState; missing?: string | null }) {
  let body: ReactNode = null;
  let tone: "bad" | "quiet" = "quiet";
  const running = (lines ?? state).status === "running";
  if (lines) {
    if (lines.shown === "idle") body = expr.trim() === "" ? NO_QUERY : null;
    else if (lines.shown === "done") body = linesBody(lines);
    else {
      tone = "bad";
      body = `✗ ${lines.message ?? ""}`;
    }
  } else if (state.shown === "idle") {
    // Nothing ran, or an emptied field ended its run: the hint. Before the first end, the field says.
    body = (state.expr ?? expr).trim() === "" ? NO_QUERY : null;
  } else if (state.shown === "done" && state.data) {
    // A chart counts its series (a log query's line is `linesBody`).
    // An empty answer is not a success: no check, no green.
    const count = state.data.series.length;
    const n = `${count} series`;
    body = (
      <>
        <span className={count > 0 ? s.metaOk : undefined}>{count > 0 ? "✓ " : ""}{n} · {state.tookMs ?? 0} ms</span>
        {state.timeText && (
          <>
            <span className={s.metaSep}>·</span>
            <span>{state.timeText}</span>
          </>
        )}
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
  if (missing && body !== null && tone === "quiet") {
    body = <>{body}<span className={s.metaSep}>·</span><span>{missing}</span></>;
  }
  return (
    <div className={s.metaRow}>
      {running && <span className={s.running} data-explore-running="">Running…</span>}
      <p className={`${s.meta} ${tone === "bad" ? s.metaBad : ""} ${running ? s.metaStale : ""}`} data-explore-meta="" aria-live="polite">
        {body}
      </p>
    </div>
  );
}
