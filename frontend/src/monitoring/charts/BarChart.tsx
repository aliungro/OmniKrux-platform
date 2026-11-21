// Bar panel: one bar per series (its last value), horizontal or vertical, each labelled with its
// name and value, so the text says everything the bars show.

import type { ChartSeries } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import { seriesColor, thresholdColor } from "./colors";
import { reduceSeries } from "./reduce";
import { formatValue } from "./units";
import styles from "./Charts.module.css";

type BarPanel = Extract<PanelSpec, { type: "bar" }>;

export interface BarChartProps {
  panel: BarPanel;
  series: ChartSeries[];
}

export default function BarChart({ panel, series }: BarChartProps) {
  const o = panel.options;
  if (series.length === 0) return null;
  const rows = series.map((s) => ({ s, value: reduceSeries(s.points, "last") }));
  const values = rows.map((r) => r.value).filter((v): v is number => v !== null);
  const min = o.min ?? Math.min(0, ...values);
  let max = Math.max(0, ...values, min);
  if (max <= min) max = min + 1;
  const frac = (v: number) => Math.min(1, Math.max(0, (v - min) / (max - min)));
  const zero = frac(0);
  const vertical = o.orientation === "vertical";
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
          <li key={s.key} className={styles.barItem} data-tone={tone ?? "none"} style={{ color: tone ? `var(--${tone})` : `var(${seriesColor(s.key)})` }}>
            <span className={styles.barName} title={s.name}>{s.name}</span>
            <svg className={styles.bar} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <rect className={styles.barTrack} x="0" y="0" width="100" height="100" />
              {vertical
                ? <rect className={styles.barFill} x="0" y={100 - lo - size} width="100" height={size} />
                : <rect className={styles.barFill} x={lo} y="0" width={size} height="100" />}
            </svg>
            <span className={styles.barValue}>{text}</span>
          </li>
        );
      })}
    </ul>
  );
}
