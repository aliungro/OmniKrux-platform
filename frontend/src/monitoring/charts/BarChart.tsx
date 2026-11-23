// Bar panel: one bar per series (its last value), horizontal or vertical, each labelled with its
// name and value, so the text says everything the bars show. A panel alert's threshold is a
// dashed rose line across the bars, on the shared scale (which grows to hold it).

import type { ChartSeries } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import { seriesColors, thresholdColor } from "./colors";
import type { AlertBand } from "./drawTimeSeries";
import { reduceSeries } from "./reduce";
import { formatValue } from "./units";
import styles from "./Charts.module.css";

type BarPanel = Extract<PanelSpec, { type: "bar" }>;

export interface BarChartProps {
  panel: BarPanel;
  series: ChartSeries[];
  /** A panel alert's threshold: a dashed `--bad` line at it. */
  alert?: AlertBand | null;
}

export default function BarChart({ panel, series, alert = null }: BarChartProps) {
  const o = panel.options;
  if (series.length === 0) return null;
  const rows = series.map((s) => ({ s, value: reduceSeries(s.points, "last") }));
  const colors = seriesColors(series);
  const values = rows.map((r) => r.value).filter((v): v is number => v !== null);
  const limit = alert && Number.isFinite(alert.threshold) ? alert.threshold : null;
  // The threshold is always on the scale: the bars shrink to make room for it.
  const held = limit === null ? values : [...values, limit];
  const min = o.min ?? Math.min(0, ...held);
  let max = Math.max(0, ...held, min);
  if (max <= min) max = min + 1;
  const frac = (v: number) => Math.min(1, Math.max(0, (v - min) / (max - min)));
  const zero = frac(0);
  const vertical = o.orientation === "vertical";
  const line = limit === null || limit < min ? null : frac(limit) * 100;
  return (
    <ul className={vertical ? styles.barsV : styles.barsH} aria-label={panel.title}>
      {rows.map(({ s, value }) => {
        const tone = value === null ? null : thresholdColor(value, o.thresholds);
        // Bars grow from zero, so a negative value points the other way.
        const end = value === null ? zero : frac(value);
        const lo = Math.min(zero, end) * 100;
        const size = Math.abs(end - zero) * 100;
        const text = formatValue(value, o.unit, o.decimals);
        return (
          <li key={s.key} className={styles.barItem} data-tone={tone ?? "none"} style={{ color: tone ? `var(--${tone})` : `var(${colors.get(s.key)})` }}>
            <span className={styles.barName} title={s.name}>{s.name}</span>
            <svg className={styles.bar} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <rect className={styles.barTrack} x="0" y="0" width="100" height="100" />
              {vertical
                ? <rect className={styles.barFill} x="0" y={100 - lo - size} width="100" height={size} />
                : <rect className={styles.barFill} x={lo} y="0" width={size} height="100" />}
              {line !== null && (vertical
                ? <line className={styles.barAlert} data-alert-line="" x1="0" x2="100" y1={100 - line} y2={100 - line} vectorEffect="non-scaling-stroke" />
                : <line className={styles.barAlert} data-alert-line="" x1={line} x2={line} y1="0" y2="100" vectorEffect="non-scaling-stroke" />)}
            </svg>
            <span className={styles.barValue}>{text}</span>
          </li>
        );
      })}
    </ul>
  );
}
