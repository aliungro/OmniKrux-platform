// Gauge panel: up to six arcs from min to max with threshold bands behind the value. A panel
// alert's threshold is a rose tick across the arc (when it is inside the range).

import type { ChartSeries } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import { thresholdColor } from "./colors";
import type { AlertBand } from "./drawTimeSeries";
import { reduceSeries } from "./reduce";
import { formatValue } from "./units";
import styles from "./Charts.module.css";

type GaugePanel = Extract<PanelSpec, { type: "gauge" }>;

export const MAX_GAUGES = 6;
export const NEEDS_MAX = "Set a maximum in Options to draw this gauge.";
export const MAX_ABOVE_MIN = "Set a maximum above the minimum in Options to draw this gauge.";

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
/** A short radial line across the arc at fraction f. */
function tick(f: number): string {
  const a = Math.PI * (1 - f);
  const p = (r: number) => `${(CX + r * Math.cos(a)).toFixed(2)} ${(CY - r * Math.sin(a)).toFixed(2)}`;
  return `M${p(R - 8)} L${p(R + 7)}`;
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
  /** A panel alert's threshold: a `--bad` tick at it. */
  alert?: AlertBand | null;
}

export default function GaugeChart({ panel, series, alert = null }: GaugeChartProps) {
  const o = panel.options;
  if (series.length === 0) return null;
  const max = gaugeMax(o);
  const min = o.min ?? 0;
  if (max === null) return <p className={styles.hint}>{NEEDS_MAX}</p>;
  if (max <= min) return <p className={styles.hint}>{MAX_ABOVE_MIN}</p>;
  const frac = (v: number) => Math.min(1, Math.max(0, (v - min) / (max - min)));
  const bands = [...o.thresholds].sort((a, b) => a.value - b.value);
  const shown = series.slice(0, MAX_GAUGES);
  const limit = alert && Number.isFinite(alert.threshold) && alert.threshold >= min && alert.threshold <= max ? alert.threshold : null;
  return (
    <div className={styles.stat}>
      <div className={styles.gaugeGrid} role="group" aria-label={panel.title}>
        {shown.map((s) => {
          const value = reduceSeries(s.points, o.calc);
          const tone = value === null ? null : thresholdColor(value, o.thresholds);
          const text = formatValue(value, o.unit, o.decimals);
          const range = `${formatValue(min, o.unit, o.decimals)} to ${formatValue(max, o.unit, o.decimals)}`;
          return (
            <div
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
                  return f1 > f0 ? <path key={`${b.value}-${i}`} className={styles.gaugeBand} style={{ color: `var(--${b.color})` }} d={arc(f0, f1)} /> : null;
                })}
                {value !== null && frac(value) > 0 ? (
                  <path className={styles.gaugeValue} style={{ color: tone ? `var(--${tone})` : "var(--focus)" }} d={arc(0, frac(value))} />
                ) : null}
                {limit !== null && <path className={styles.gaugeAlert} data-alert-tick="" d={tick(frac(limit))} />}
              </svg>
              <span className={styles.gaugeText}>{text}</span>
              {series.length > 1 ? <span className={styles.statName} title={s.name}>{s.name}</span> : null}
            </div>
          );
        })}
      </div>
      {series.length > MAX_GAUGES ? <p className={styles.note}>Showing {MAX_GAUGES} of {series.length} series.</p> : null}
    </div>
  );
}
