// Stat panel: up to six big numbers, each the series reduced to one value, coloured by threshold,
// with an optional sparkline.

import type { ChartSeries } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import { thresholdColor } from "./colors";
import CountUp from "./CountUp";
import { reduceSeries } from "./reduce";
import { formatValue } from "./units";
import styles from "./Charts.module.css";

type StatPanel = Extract<PanelSpec, { type: "stat" }>;

export const MAX_TILES = 6;

export interface StatChartProps {
  panel: StatPanel;
  series: ChartSeries[];
  animate: boolean;
  changeId: number;
  editId: number;
}

function Sparkline({ points }: { points: ChartSeries["points"] }) {
  const values = points.filter((p): p is [number, number] => p[1] !== null);
  if (values.length < 2) return null;
  const t0 = values[0][0];
  const span = values[values.length - 1][0] - t0 || 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of values) {
    lo = Math.min(lo, p[1]);
    hi = Math.max(hi, p[1]);
  }
  const range = hi - lo || 1;
  const d = values
    .map((p, i) => `${i === 0 ? "M" : "L"}${(((p[0] - t0) / span) * 100).toFixed(2)} ${(22 - ((p[1] - lo) / range) * 20).toFixed(2)}`)
    .join(" ");
  return (
    <svg className={styles.spark} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <path className={styles.sparkLine} d={d} />
    </svg>
  );
}

export default function StatChart({ panel, series, animate, changeId, editId }: StatChartProps) {
  const o = panel.options;
  if (series.length === 0) return null;
  const shown = series.slice(0, MAX_TILES);
  return (
    <div className={styles.stat}>
      <ul className={styles.statGrid} aria-label={panel.title}>
        {shown.map((s) => {
          const value = reduceSeries(s.points, o.calc);
          const tone = value === null ? null : thresholdColor(value, o.thresholds);
          return (
            <li key={s.key} className={styles.statTile} data-tone={tone ?? "none"}>
              <CountUp
                className={styles.statValue}
                value={value}
                format={(v) => formatValue(v, o.unit, o.decimals)}
                animate={animate}
                changeId={changeId}
                editId={editId}
              />
              {series.length > 1 ? <span className={styles.statName} title={s.name}>{s.name}</span> : null}
              {o.sparkline ? <Sparkline points={s.points} /> : null}
            </li>
          );
        })}
      </ul>
      {series.length > MAX_TILES ? <p className={styles.note}>Showing {MAX_TILES} of {series.length} series.</p> : null}
    </div>
  );
}
