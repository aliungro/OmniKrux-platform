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
  /** Rises with each edit of this panel (never in view mode). */
  changeId: number;
  /** Off under reduced motion. Charts only morph and count on edits (a newer `changeId` or `editId`). */
  animate: boolean;
}

export function PanelBody({ panel, run, result, waiting, changeId, animate }: Props) {
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
          {/* Refreshes and time changes never animate: only a newer edit count morphs (F28). */}
          <ChartView panel={panel} data={data} range={run.range} animate={animate} changeId={changeId} step={run.step} />
        </Suspense>
      );
  }
}
