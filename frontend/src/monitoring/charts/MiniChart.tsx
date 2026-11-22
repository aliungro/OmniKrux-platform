// A small, quiet chart for a candidate's preview: a sparkline of up to three series, the last
// value for a stat or gauge, horizontal bars for a bar panel, three lines for logs. Decorative:
// the card names the result, so the whole thing is hidden from assistive tech.

import type { ChartSeries, PanelData } from "../dashboards/runPanel";
import type { PanelType, Unit } from "../dashboards/schema";
import { seriesColors } from "./colors";
import { decimate } from "./decimate";
import { logTime } from "./LogsChart";
import { formatValue } from "./units";
import styles from "./Charts.module.css";

export const MINI_COLUMNS = 120;
export const MINI_SERIES = 3;
export const MINI_LOG_LINES = 3;
const W = MINI_COLUMNS;
const H = 40;
const PAD = 2;

export interface MiniChartProps {
  data: PanelData;
  panelType: PanelType;
  unit: Unit;
  /** Draw the lines in over 700 ms. */
  animate: boolean;
}

function lastValue(s: ChartSeries | undefined): number | null {
  if (!s) return null;
  for (let i = s.points.length - 1; i >= 0; i--) {
    const v = s.points[i][1];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

function Sparkline({ series, animate }: { series: ChartSeries[]; animate: boolean }) {
  const colors = seriesColors(series);
  const shown = series.slice(0, MINI_SERIES);
  let t0 = Infinity;
  let t1 = -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of shown) {
    for (const [t, v] of s.points) {
      if (v === null || !Number.isFinite(v)) continue;
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (!(t1 >= t0)) return null;
  const span = t1 - t0 || 1;
  const range = hi - lo || 1;
  const x = (t: number) => (((t - t0) / span) * W).toFixed(2);
  const y = (v: number) => (H - PAD - ((v - lo) / range) * (H - 2 * PAD)).toFixed(2);
  return (
    <svg className={styles.mini} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {shown.map((s, i) => {
        const stroke = `var(${colors.get(s.key) ?? "--focus"})`;
        const points = decimate(s.points, t0, t1, MINI_COLUMNS);
        let d = "";
        let area = "";
        let run: string[] = [];
        const close = () => {
          if (run.length > 1) {
            const first = run[0].slice(1).split(" ")[0];
            const last = run[run.length - 1].split(" ")[0].replace("L", "");
            area += `${run.join(" ")} L${last} ${H} L${first} ${H} Z `;
          }
          run = [];
        };
        for (const [t, v] of points) {
          if (v === null || !Number.isFinite(v)) {
            close();
            continue;
          }
          const cmd = `${d === "" || run.length === 0 ? "M" : "L"}${x(t)} ${y(v)}`;
          d += `${cmd} `;
          run.push(run.length === 0 ? `M${x(t)} ${y(v)}` : cmd);
        }
        close();
        if (d === "") return null;
        return (
          <g key={s.key}>
            {i === 0 && area ? <path d={area.trim()} fill={stroke} fillOpacity={0.15} stroke="none" /> : null}
            <path
              data-line=""
              d={d.trim()}
              fill="none"
              stroke={stroke}
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pathLength={1}
              className={animate ? styles.miniDraw : undefined}
            />
          </g>
        );
      })}
    </svg>
  );
}

function Bars({ series, unit }: { series: ChartSeries[]; unit: Unit }) {
  const rows = series.slice(0, MINI_SERIES).map((s) => ({ s, v: lastValue(s) }));
  const colors = seriesColors(series);
  const top = Math.max(...rows.map((r) => r.v ?? 0), 0) || 1;
  return (
    <span className={styles.miniBars}>
      {rows.map(({ s, v }) => (
        <span key={s.key} className={styles.miniBarRow} data-bar="">
          <span className={styles.miniBarName}>{s.name}</span>
          <span className={styles.miniBarTrack}>
            <span
              className={styles.miniBarFill}
              style={{ width: `${Math.max(0, ((v ?? 0) / top) * 100)}%`, background: `var(${colors.get(s.key) ?? "--focus"})` }}
            />
          </span>
          <span className={styles.miniBarValue}>{formatValue(v, unit, null)}</span>
        </span>
      ))}
    </span>
  );
}

export function MiniChart({ data, panelType, unit, animate }: MiniChartProps) {
  let body;
  if (panelType === "logs") {
    body = (
      <span className={styles.miniLogs}>
        {data.logs.slice(0, MINI_LOG_LINES).map((l) => (
          <span key={l.key} className={styles.miniLog} data-log="">
            <span className={styles.miniLogTime}>{logTime(l.ts)}</span> {l.line}
          </span>
        ))}
      </span>
    );
  } else if (panelType === "stat" || panelType === "gauge") {
    body = <span className={styles.miniValue}>{formatValue(lastValue(data.series[0]), unit, null)}</span>;
  } else if (panelType === "bar" || panelType === "table") {
    body = <Bars series={data.series} unit={unit} />;
  } else {
    body = <Sparkline series={data.series} animate={animate} />;
  }
  return <span className={styles.miniBox} aria-hidden="true">{body}</span>;
}
