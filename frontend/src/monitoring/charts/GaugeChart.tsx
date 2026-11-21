// Gauge panel: up to six arcs from min to max with threshold bands behind the value.

import type { ChartSeries } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import { thresholdColor } from "./colors";
import { reduceSeries } from "./reduce";
import { formatValue } from "./units";
import styles from "./Charts.module.css";

type GaugePanel = Extract<PanelSpec, { type: "gauge" }>;

export const MAX_GAUGES = 6;
export const NEEDS_MAX = "Set a maximum in Options to draw this gauge.";

const CX = 60;
const CY = 58;
const R = 46;

/** The point on the arc at fraction f of the half circle (0 is the left end). */
function at(f: number): string {
  const a = Math.PI * (1 - f);
  return `${(CX + R * Math.cos(a)).toFixed(2)} ${(CY - R * Math.sin(a)).toFixed(2)}`;
}
function arc(f0: number, f1: number): string {
  return `M${at(f0)} A${R} ${R} 0 0 1 ${at(f1)}`;
}

/** The maximum the panel draws to: its own, or the unit's natural one. */
export function gaugeMax(o: GaugePanel["options"]): number | null {
  if (o.max !== null) return o.max;
  if (o.unit === "percentunit") return 1;
  if (o.unit === "percent") return 100;
  return null;
}

export interface GaugeChartProps {
  panel: GaugePanel;
  series: ChartSeries[];
}

export default function GaugeChart({ panel, series }: GaugeChartProps) {
  const o = panel.options;
  if (series.length === 0) return null;
  const max = gaugeMax(o);
  const min = o.min ?? 0;
  if (max === null || max <= min) return <p className={styles.hint}>{NEEDS_MAX}</p>;
  const frac = (v: number) => Math.min(1, Math.max(0, (v - min) / (max - min)));
  const bands = [...o.thresholds].sort((a, b) => a.value - b.value);
  const shown = series.slice(0, MAX_GAUGES);
  return (
    <div className={styles.stat}>
      <ul className={styles.gaugeGrid} aria-label={panel.title}>
        {shown.map((s) => {
          const value = reduceSeries(s.points, o.calc);
          const tone = value === null ? null : thresholdColor(value, o.thresholds);
          const text = formatValue(value, o.unit, o.decimals);
          const range = `${formatValue(min, o.unit, o.decimals)} to ${formatValue(max, o.unit, o.decimals)}`;
          return (
            <li
              key={s.key}
              className={styles.gaugeTile}
              data-tone={tone ?? "none"}
              role="meter"
              aria-label={s.name}
              aria-valuemin={min}
              aria-valuemax={max}
              aria-valuenow={value ?? undefined}
              aria-valuetext={`${text} of ${range}`}
            >
              <svg className={styles.gauge} viewBox="0 0 120 68" aria-hidden="true">
                <path className={styles.gaugeTrack} d={arc(0, 1)} />
                {bands.map((b, i) => {
                  const end = bands[i + 1]?.value ?? max;
                  const f0 = frac(b.value);
                  const f1 = frac(end);
                  return f1 > f0 ? <path key={b.value} className={styles.gaugeBand} style={{ color: `var(--${b.color})` }} d={arc(f0, f1)} /> : null;
                })}
                {value !== null && frac(value) > 0 ? (
                  <path className={styles.gaugeValue} style={{ color: tone ? `var(--${tone})` : "var(--focus)" }} d={arc(0, frac(value))} />
                ) : null}
              </svg>
              <span className={styles.gaugeText}>{text}</span>
              {series.length > 1 ? <span className={styles.statName} title={s.name}>{s.name}</span> : null}
            </li>
          );
        })}
      </ul>
      {series.length > MAX_GAUGES ? <p className={styles.note}>Showing {MAX_GAUGES} of {series.length} series.</p> : null}
    </div>
  );
}
