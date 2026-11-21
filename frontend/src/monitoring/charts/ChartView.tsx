// The chart chunk's front door. Only `dashboards/` and `charts/` know a panel's data; this picks
// the drawing for the panel's type. A panel that couldn't answer draws no series: never the
// previous answer dressed as current.

import type { ChartLogLine, ChartSeries, PanelData } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import BarChart from "./BarChart";
import GaugeChart from "./GaugeChart";
import LogsChart from "./LogsChart";
import StatChart from "./StatChart";
import TableChart from "./TableChart";
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
const NO_LOGS: ChartLogLine[] = [];

export default function ChartView({ panel, data, range, animate, changeId }: ChartViewProps) {
  // A panel that couldn't answer draws nothing, whatever its type: never the old answer.
  const answered = data.state !== "unreachable" && data.state !== "error" && data.state !== "noQuery";
  const series = answered ? data.series : NO_SERIES;
  switch (panel.type) {
    case "timeseries":
      return <TimeSeriesChart panel={panel} series={series} range={range} animate={animate} changeId={changeId} editId={data.editId} />;
    case "stat":
      return <StatChart panel={panel} series={series} animate={animate} changeId={changeId} editId={data.editId} />;
    case "gauge":
      return <GaugeChart panel={panel} series={series} />;
    case "bar":
      return <BarChart panel={panel} series={series} />;
    case "table":
      return <TableChart panel={panel} series={series} />;
    case "logs":
      return <LogsChart panel={panel} logs={answered ? data.logs : NO_LOGS} />;
  }
}
