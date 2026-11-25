// The chart chunk's front door. Only `dashboards/` and `charts/` know a panel's data; this picks
// the drawing for the panel's type. A panel that couldn't answer draws no series: never the
// previous answer dressed as current.

import { useMemo } from "react";
import type { ChartLogLine, ChartSeries, PanelData } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import BarChart from "./BarChart";
import type { AlertBand, ChartMark, ChartRange } from "./drawTimeSeries";
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
  /** Time series only (Explore): the selected window, drawn as a band over the full range. */
  selection?: ChartRange | null;
  /**
   * Time series only (Explore): a drag or Shift+arrows selected a window (`null`: Esc cleared it).
   * Without it no pointer handler is bound and the chart is M2's. `via` says how it was chosen.
   */
  onSelect?: (range: ChartRange | null, via?: "pointer" | "keyboard") => void;
  /** Time series only (Explore): log line ticks along the bottom. */
  marks?: ChartMark[];
  /** Time series only (Explore): the run's step in seconds, which a chosen window snaps to. */
  step?: number;
  /** Logs only (Explore): each line's tone for a level column; dashboards pass none. */
  lineTone?: (line: ChartLogLine) => ChartMark["tone"];
  /** Logs only (Explore): the key that brings the keyboard to the list (`aria-keyshortcuts`). */
  listKeyshortcuts?: string;
  /**
   * An alert rule's threshold (the Alerts page, the rule form). Given (null too), it wins over the
   * panel's own alert; absent, the panel's alert draws it. A time series draws the dashed line and
   * the shaded firing side, a bar chart the dashed line, a gauge a tick; a stat draws nothing.
   */
  alert?: AlertBand | null;
}

export type { AlertBand, ChartMark, ChartRange };

const NO_SERIES: ChartSeries[] = [];

/** The band of a panel's own alert: the same object while the alert's condition doesn't change. */
function usePanelBand(panel: PanelSpec): AlertBand | null {
  const a = panel.alert;
  const op = a?.op;
  const threshold = a?.threshold;
  const queryRef = a?.query;
  return useMemo(
    () => (op !== undefined && threshold !== undefined && queryRef !== undefined && Number.isFinite(threshold) ? { op, threshold, queryRef } : null),
    [op, threshold, queryRef],
  );
}
const NO_LOGS: ChartLogLine[] = [];

export default function ChartView({
  panel, data, range, animate, changeId, selection, onSelect, marks, step, lineTone, listKeyshortcuts, alert,
}: ChartViewProps) {
  // A panel that couldn't answer draws nothing, whatever its type: never the old answer.
  const answered = data.state !== "unreachable" && data.state !== "error" && data.state !== "noQuery";
  const series = answered ? data.series : NO_SERIES;
  const own = usePanelBand(panel);
  const band = alert !== undefined ? alert : own;
  switch (panel.type) {
    case "timeseries":
      return (
        <TimeSeriesChart panel={panel} series={series} range={range} animate={animate} changeId={changeId} editId={data.editId}
          selection={selection} onSelect={onSelect} marks={marks} step={step} alert={band} />
      );
    case "stat":
      return <StatChart panel={panel} series={series} animate={animate} changeId={changeId} editId={data.editId} />;
    case "gauge":
      return <GaugeChart panel={panel} series={series} alert={band} />;
    case "bar":
      return <BarChart panel={panel} series={series} alert={band} />;
    case "table":
      return <TableChart panel={panel} series={series} />;
    case "logs":
      return <LogsChart panel={panel} logs={answered ? data.logs : NO_LOGS} lineTone={lineTone} listKeyshortcuts={listKeyshortcuts} />;
  }
}
