// Metrics and logs on one timeline (X3): the log lines under Explore's chart. In metrics mode they
// come from the Only chips' labels that Loki has (or a LogQL selector the user writes); in logs mode
// from the query itself, and they are the whole result (no chart). A window chosen on the chart
// narrows them to exactly that window; Show all goes back. Its states are its own: a failure here
// never touches the chart above, and a text that can't run names nothing but its own error.

import { forwardRef, lazy, Suspense, useMemo, type Ref } from "react";
import { useEmptyReason } from "../dashboards/emptyReason";
import type { PanelData } from "../dashboards/runPanel";
import { newPanel, type PanelSpec } from "../dashboards/schema";
import { LINES_LIMIT, lineCount, lineTone, windowLabel } from "./logLinks";
import type { LinesRunState } from "./useExploreRun";
import s from "./LinkedLogs.module.css";

const ChartView = lazy(() => import("../charts"));

export const LINKED_HINT = "Pick values under Only, or write a LogQL selector, to see matching log lines here.";
export const METRIC_QUERY = "This is a metric query, so there are no lines to list.";
/** After a text that can't run: `✗ {message} Fix the query to run it again.` */
export const FIX_QUERY = "Fix the query to run it again.";
const ROW = 22;
const MAX_LIST = 320;

type Range = { start: number; end: number };

export interface LinkedLogsProps {
  mode: "metrics" | "logs";
  /** The Loki source the lines come from. */
  sourceName: string;
  /** Metrics mode: the Logs query field's text and its edits. */
  field?: { value: string; onChange(text: string): void };
  /** The selector shown in the info line; `null` when there is none. */
  selector: string | null;
  /** The text is a LogQL metric query: a chart, no lines. */
  metricQuery: boolean;
  /** The run, and whether it is about the current text, place and range (else it isn't shown). */
  state: LinesRunState;
  current: boolean;
  window: Range | null;
  range: Range;
  onShowAll(): void;
  onRetry(): void;
  showAllRef: Ref<HTMLButtonElement>;
  headingRef: Ref<HTMLHeadingElement>;
}

export const LinkedLogs = forwardRef<HTMLElement, LinkedLogsProps>(function LinkedLogs(props, ref) {
  const { mode, sourceName, field, selector, metricQuery, state, current, window, range, onShowAll, onRetry, showAllRef, headingRef } = props;
  const panel = useMemo<PanelSpec>(() => {
    const p = newPanel("logs", "explore:lines", { x: 0, y: 0, w: 12, h: 8 });
    p.title = "Log lines";
    if (p.type === "logs") p.options = { ...p.options, limit: LINES_LIMIT, order: "newest", wrap: false };
    return p;
  }, []);
  const lines = current ? state.lines : [];
  const data = useMemo<PanelData>(() => ({
    state: lines.length > 0 ? "ready" : "empty", series: [], logs: lines, problems: [],
    summary: { series: 0, points: 0, tookMs: 0 }, editId: 0,
  }), [lines]);

  // A text that can't run is about itself only: its lines are gone and no selector is named.
  const invalid = !metricQuery && current && state.status === "invalid";
  const nothing = metricQuery || selector === null || invalid;
  const loading = !nothing && (!current || state.status === "waiting" || state.status === "running");
  const done = !nothing && current && state.status === "done";
  const failed = !nothing && current && state.status === "failed";
  // Empty lines: why, about the request that ran (a chosen window is in it), once the check proves it.
  const none = done && state.lines.length === 0;
  const reason = useEmptyReason(none && state.request ? { sourceType: "loki", request: state.request } : null);

  let said = "";
  if (done) {
    const n = state.lines.length;
    const newest = n >= LINES_LIMIT ? ` · showing the newest ${LINES_LIMIT}` : "";
    said = state.window ? `${windowLabel(state.window, n)}${newest}` : `${state.timeText ?? ""} · ${lineCount(n)}${newest}`;
  }

  return (
    <section ref={ref} className={s.section} aria-label="Log lines">
      <header className={s.head}>
        <h2 ref={headingRef} className={s.title} tabIndex={-1}>Log lines</h2>
        {selector !== null && !metricQuery && !invalid && (
          <p className={s.info}>Logs from <code className={s.selector}>{selector}</code> · {sourceName}</p>
        )}
      </header>

      {mode === "metrics" && field && (
        <div className={s.fieldRow}>
          <span className={s.lang} aria-hidden="true">LogQL</span>
          <input
            className={s.field}
            type="text"
            aria-label="Logs query"
            aria-description="A LogQL selector. The Only chips fill it in until you write your own."
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            placeholder='{namespace="api"}'
            value={field.value}
            onChange={(e) => field.onChange(e.target.value)}
          />
        </div>
      )}

      {metricQuery ? (
        <p className={s.note}>{METRIC_QUERY}</p>
      ) : invalid ? (
        // The text is wrong: fixing it is the way on, so there's no Try again.
        <p className={s.invalid} data-lines-invalid="">
          <span className={s.invalidMark} aria-hidden="true">✗</span> {state.message} <span className={s.invalidStep}>{FIX_QUERY}</span>
        </p>
      ) : selector === null ? (
        mode === "metrics" ? <p className={s.note}>{LINKED_HINT}</p> : null
      ) : (
        <>
          <div className={s.windowRow}>
            <p className={s.windowText} role="status" aria-live="polite">{said}</p>
            {loading && <span className={s.loading}>Loading lines…</span>}
            {window && (
              <button ref={showAllRef} type="button" className={s.showAll} onClick={onShowAll}>
                Show all
              </button>
            )}
          </div>
          {failed && (
            <div className={s.failure} role="group" aria-label="The log lines failed">
              <p className={s.failureReason}>{state.message}</p>
              <button type="button" className={s.retry} onClick={onRetry}>Try again</button>
            </div>
          )}
          {none && (reason
            ? <p className={`${s.note} ${s.reason}`} data-empty-reason="">{reason}</p>
            : <p className={s.note}>{state.window ? "No log lines in this window." : "No log lines in this time range."}</p>)}
          {done && state.lines.length > 0 && (
            <div className={s.lines} style={{ height: Math.min(MAX_LIST, state.lines.length * ROW + 8) }}>
              <Suspense fallback={<p className={s.note}>Loading lines…</p>}>
                <ChartView panel={panel} data={data} range={state.window ?? range} animate={false} changeId={0}
                  lineTone={lineTone} listKeyshortcuts="l" />
              </Suspense>
            </div>
          )}
        </>
      )}
    </section>
  );
});
