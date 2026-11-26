// A panel's body: its chart (from the lazy chart chunk) or what it says instead. A run that
// failed shows the failure, never the chart it had before.
import { lazy, Suspense } from "react";
import type { PanelDataResult, PanelRun } from "../runPanel";
import type { PanelSpec } from "../schema";
import { panelWindowHint, usePanelEmptyReason } from "../emptyReason";
import { LOG_QUERY_IN_CHART, logQueryInChart } from "../logQueries";
import { PANEL_COPY, PanelFailure, PanelNote } from "./PanelState";

const ChartView = lazy(() => import("../../charts"));

interface Props {
  panel: PanelSpec;
  run: PanelRun;
  result: PanelDataResult;
  /** Its owner or a variable it uses is still loading: nothing it had is current. */
  waiting: boolean;
  /** Rises with each edit of this panel (never in view mode). */
  changeId: number;
  /** Off under reduced motion. Charts only morph and count on edits (a newer `changeId` or `editId`). */
  animate: boolean;
}

export function PanelBody({ panel, run, result, waiting, changeId, animate }: Props) {
  const { data } = result;
  // Before any return (hooks keep their order): why an empty answer was empty, once it is known.
  // A log query in a chart panel answers lines (so it is rarely empty): its note wins over any reason.
  const logsInChart = logQueryInChart(panel);
  // A window shorter than the step is a cause seen from the text alone: it speaks first, and no check is asked.
  const isEmpty = !waiting && data?.state === "empty" && !logsInChart;
  // Never over a dimmed older result: the run's step belongs to the newer question.
  const hint = isEmpty && !result.stale ? panelWindowHint(run) : null;
  const reason = usePanelEmptyReason(panel, run, isEmpty && hint === null, !waiting && !result.fetching);
  // Waiting on variables, nothing read yet, or the last thing kept is from before this panel had a run.
  if (waiting || data === null || (data.state === "noQuery" && run.requests.length > 0)) {
    return <PanelNote text={PANEL_COPY.loading} busy />;
  }
  // Whatever it answered, a chart cannot draw lines. A failure still says what failed.
  if (logsInChart && data.state !== "unreachable" && data.state !== "error" && data.state !== "noQuery") {
    return <PanelNote text={LOG_QUERY_IN_CHART} />;
  }
  switch (data.state) {
    case "noQuery":
      return <PanelNote text={PANEL_COPY.noQuery} />;
    case "empty":
      // The generic words stay until a reason is proved; a reason replaces them, never a "checking" line.
      if (hint) return <PanelNote text={hint} reason />;
      return reason ? <PanelNote text={reason} reason /> : <PanelNote text={PANEL_COPY.empty} />;
    case "unreachable":
      return <PanelFailure kind="unreachable" reason={data.problems[0]} onRetry={result.refetch} />;
    case "error":
      return <PanelFailure kind="error" reason={data.problems[0]} />;
    default:
      return (
        <Suspense fallback={<PanelNote text={PANEL_COPY.loading} busy />}>
          {/* Refreshes and time changes never animate: only a newer edit count morphs (F28). */}
          <ChartView panel={panel} data={data} range={run.range} animate={animate} changeId={changeId} step={run.step} />
        </Suspense>
      );
  }
}
