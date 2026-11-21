// The chart chunk's front door. Only `dashboards/` and `charts/` know a panel's data; this picks
// the drawing for the panel's type. A panel that couldn't answer draws no series: never the
// previous answer dressed as current.

import type { ChartSeries, PanelData } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import TimeSeriesChart from "./TimeSeriesChart";

export interface ChartViewProps {
  panel: PanelSpec;
  data: PanelData;
  /** The run's aligned time range, in seconds: the x axis and the decimation window. */
  range: { start: number; end: number };
  animate: boolean;
  /** Increments on each edit of this panel; with `animate`, a new value morphs from the last drawn frame. */
  changeId: number;
}

const NO_SERIES: ChartSeries[] = [];

export default function ChartView({ panel, data, range, animate, changeId }: ChartViewProps) {
  if (panel.type === "timeseries") {
    const answered = data.state !== "unreachable" && data.state !== "error" && data.state !== "noQuery";
    return (
      <TimeSeriesChart
        panel={panel}
        series={answered ? data.series : NO_SERIES}
        range={range}
        animate={animate}
        changeId={changeId}
        editId={data.editId}
      />
    );
  }
  return null;
}
