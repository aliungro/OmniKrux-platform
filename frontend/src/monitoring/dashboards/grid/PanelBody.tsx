// A panel's body: its chart (from the lazy chart chunk) or what it says instead. A run that
// failed shows the failure, never the chart it had before.
import { lazy, Suspense } from "react";
import type { PanelDataResult, PanelRun } from "../runPanel";
import type { PanelSpec } from "../schema";
import { PANEL_COPY, PanelFailure, PanelNote } from "./PanelState";

const ChartView = lazy(() => import("../../charts"));

interface Props {
  panel: PanelSpec;
  run: PanelRun;
  result: PanelDataResult;
  /** Its owner or a variable it uses is still loading: nothing it had is current. */
  waiting: boolean;
  /** Increments on each edit of this panel (0 in view mode). */
  changeId: number;
}

export function PanelBody({ panel, run, result, waiting, changeId }: Props) {
  const { data } = result;
  // Waiting on variables, nothing read yet, or the last thing kept is from before this panel had a run.
  if (waiting || data === null || (data.state === "noQuery" && run.requests.length > 0)) {
    return <PanelNote text={PANEL_COPY.loading} busy />;
  }
  switch (data.state) {
    case "noQuery":
      return <PanelNote text={PANEL_COPY.noQuery} />;
    case "empty":
      return <PanelNote text={PANEL_COPY.empty} />;
    case "unreachable":
      return <PanelFailure kind="unreachable" reason={data.problems[0]} onRetry={result.refetch} />;
    case "error":
      return <PanelFailure kind="error" reason={data.problems[0]} />;
    default:
      return (
        <Suspense fallback={<PanelNote text={PANEL_COPY.loading} busy />}>
          {/* View mode: refreshes and time changes never animate (no edit to morph from). */}
          <ChartView panel={panel} data={data} range={run.range} animate={false} changeId={changeId} />
        </Suspense>
      );
  }
}
