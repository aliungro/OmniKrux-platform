// The time series panel: a canvas sized to its box at the device pixel ratio, a crosshair with a
// tooltip (mouse, or the arrow keys on the focused chart), and the legend. Option and query edits
// morph the lines; refreshes, resizes and reduced motion jump.

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent,
} from "react";
import type { ChartSeries } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import { buildFrame, drawTimeSeries, type FrameSeries, type TimeSeriesFrame } from "./drawTimeSeries";
import { resolveToken, seriesColors } from "./colors";
import Legend from "./Legend";
import { easeOutCubic, MORPH_MS, mixColumns, tween, usePrefersReducedMotion } from "./motion";
import { formatTooltipTime } from "./scale";
import { formatValue } from "./units";
import styles from "./Charts.module.css";

type TimeseriesPanel = Extract<PanelSpec, { type: "timeseries" }>;

export interface TimeSeriesChartProps {
  panel: TimeseriesPanel;
  series: ChartSeries[];
  range: { start: number; end: number };
  animate: boolean;
  changeId: number;
  /** The edit count the data was fetched under (a newer one than the last frame is a query edit). */
  editId: number;
}

interface Drawn {
  target: TimeSeriesFrame;
  shown: TimeSeriesFrame;
  changeId: number;
  editId: number;
  cancel?: () => void;
}

const NO_HIDDEN: ReadonlySet<string> = new Set();

/** The same series in the same order (the axis may have changed width, so columns may differ). */
function sameShape(a: TimeSeriesFrame, b: TimeSeriesFrame): boolean {
  if (a.series.length !== b.series.length) return false;
  return a.series.every((s, i) => s.key === b.series[i].key && !s.base === !b.series[i].base);
}

/** `ys` stretched or squeezed to `n` columns (a gap stays a gap). */
function resample(ys: Float32Array, n: number): Float32Array {
  if (ys.length === n) return ys;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ys[Math.min(ys.length - 1, Math.floor((i * ys.length) / n))];
  return out;
}

function lastValue(s: ChartSeries): number | null {
  for (let i = s.points.length - 1; i >= 0; i--) {
    const v = s.points[i][1];
    if (v !== null) return v;
  }
  return null;
}

/** The point nearest `t`, if it lies within `tolerance` seconds. */
function valueAt(points: ChartSeries["points"], t: number, tolerance: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  let best: [number, number | null] | null = null;
  for (const i of [lo - 1, lo]) {
    const p = points[i];
    if (p && (best === null || Math.abs(p[0] - t) < Math.abs(best[0] - t))) best = p;
  }
  return best && Math.abs(best[0] - t) <= tolerance ? best[1] : null;
}

function nearestIndex(samples: number[], t: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(samples[lo - 1] - t) <= Math.abs(samples[lo] - t) ? lo - 1 : lo;
}

export default function TimeSeriesChart({ panel, series, range, animate, changeId, editId }: TimeSeriesChartProps) {
  const opts = panel.options;
  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawn = useRef<Drawn | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_HIDDEN);
  const [cursor, setCursor] = useState<number | null>(null);
  const reduced = usePrefersReducedMotion();
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  // Size from the box, not the window.
  useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const apply = (w: number, h: number) => {
      const width = Math.max(0, Math.floor(w));
      const height = Math.max(0, Math.floor(h));
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    if (typeof ResizeObserver === "undefined") {
      const r = el.getBoundingClientRect();
      apply(r.width, r.height);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) apply(box.width, box.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The same tokens the frame draws with, for the tooltip and the legend.
  const colors = useMemo(() => seriesColors(series), [series]);
  const frame = useMemo(
    () => (size.width > 0 && size.height > 0
      ? buildFrame(series, opts, { ...size, dpr }, { start: range.start, end: range.end }, hidden)
      : null),
    [series, opts, size, dpr, range.start, range.end, hidden],
  );

  // Paint. An edit morphs from what is on the canvas; anything else jumps.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    const prev = drawn.current;
    if (prev && prev.target === frame) {
      prev.changeId = changeId;
      prev.editId = editId;
      return;
    }
    prev?.cancel?.();
    const w = Math.round(frame.size.width * frame.size.dpr);
    const h = Math.round(frame.size.height * frame.size.dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const entry: Drawn = { target: frame, shown: frame, changeId, editId };
    drawn.current = entry;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // no canvas here: the text alternative still says what the chart shows
    const style = getComputedStyle(canvas);
    const colorOf = (token: string) => resolveToken(style, token);

    const edited = prev !== null && (changeId > prev.changeId || editId > prev.editId);
    if (!(animate && !reduced && edited && sameShape(prev.shown, frame))) {
      drawTimeSeries(ctx, frame, colorOf);
      return;
    }
    const from = new Map<string, FrameSeries>(prev.shown.series.map((s) => [s.key, s]));
    // Resampled once, not per frame.
    const starts = frame.series.map((s) => {
      const f = from.get(s.key)!;
      return { ys: resample(f.ys, s.ys.length), base: s.base && f.base ? resample(f.base, s.base.length) : undefined };
    });
    const buffers = frame.series.map((s) => ({
      ys: new Float32Array(s.ys.length),
      base: s.base ? new Float32Array(s.base.length) : undefined,
    }));
    entry.cancel = tween(MORPH_MS, (k) => {
      const e = easeOutCubic(k);
      const mixed: TimeSeriesFrame = k >= 1 ? frame : {
        ...frame,
        series: frame.series.map((s, i) => ({
          ...s,
          ys: mixColumns(starts[i].ys, s.ys, e, buffers[i].ys),
          base: s.base && starts[i].base ? mixColumns(starts[i].base, s.base, e, buffers[i].base) : s.base,
        })),
      };
      entry.shown = mixed;
      drawTimeSeries(ctx, mixed, colorOf);
    });
  }, [frame, changeId, editId, animate, reduced]);

  useEffect(() => () => drawn.current?.cancel?.(), []);

  const visible = useMemo(() => series.filter((s) => !hidden.has(s.key)), [series, hidden]);

  // The crosshair moves between the longest visible series' own samples.
  const samples = useMemo(() => {
    let best: ChartSeries | null = null;
    for (const s of visible) if (!best || s.points.length > best.points.length) best = s;
    if (!best) return [];
    return best.points.map((p) => p[0]).filter((t) => t >= range.start && t <= range.end);
  }, [visible, range.start, range.end]);
  const at = cursor !== null && samples.length > 0 ? Math.min(cursor, samples.length - 1) : null;
  const span = range.end - range.start;

  const onMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (!frame || samples.length === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - box.left - frame.plot.x) / frame.plot.w;
    setCursor(nearestIndex(samples, range.start + Math.min(1, Math.max(0, frac)) * span));
  }, [frame, samples, range.start, span]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      if (samples.length === 0) return;
      e.preventDefault();
      const from = at ?? 0;
      setCursor(Math.max(0, Math.min(samples.length - 1, from + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Escape" && cursor !== null) {
      e.stopPropagation(); // hides the crosshair only; Esc keeps its other jobs for when nothing is shown
      setCursor(null);
    }
  };

  let tip: { x: number; time: string; rows: { key: string; name: string; color: string; value: number | null; text: string }[] } | null = null;
  if (at !== null && frame) {
    const t = samples[at];
    const tolerance = samples.length > 1 ? ((samples[samples.length - 1] - samples[0]) / (samples.length - 1)) * 1.5 : Infinity;
    const rows = visible.map((s) => {
      const v = valueAt(s.points, t, tolerance);
      return { key: s.key, name: s.name, color: colors.get(s.key) as string, value: v, text: formatValue(v, opts.unit, opts.decimals) };
    });
    rows.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
    tip = { x: frame.plot.x + ((t - range.start) / span) * frame.plot.w, time: formatTooltipTime(t), rows };
  }

  const solo = (key: string) => setHidden(() => {
    const onlyThis = visible.length === 1 && visible[0].key === key;
    return onlyThis ? NO_HIDDEN : new Set(series.filter((s) => s.key !== key).map((s) => s.key));
  });
  const toggle = (key: string) => setHidden((h) => {
    const next = new Set(h);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  const latest = series.slice(0, 3).map((s) => `${s.name} ${formatValue(lastValue(s), opts.unit, opts.decimals)}`);
  const label = `${panel.title}: ${series.length} series.${latest.length > 0 ? ` Latest: ${latest.join(", ")}.` : ""}`;

  return (
    <div className={styles.chart}>
      <div className={styles.plotWrap}>
        <div
          ref={plotRef}
          className={styles.plot}
          role="img"
          tabIndex={0}
          aria-label={label}
          aria-keyshortcuts="ArrowLeft ArrowRight Escape"
          onKeyDown={onKeyDown}
          onMouseMove={onMouseMove}
          onMouseLeave={() => setCursor(null)}
        >
          <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
          {tip && frame ? (
            <div className={styles.crosshair} style={{ left: tip.x, top: frame.plot.y, height: frame.plot.h }} aria-hidden="true" />
          ) : null}
        </div>
        <div
          role="status"
          className={tip && frame && tip.x > frame.size.width * 0.6 ? `${styles.tip} ${styles.tipLeft}` : `${styles.tip} ${styles.tipRight}`}
          style={tip && frame ? { left: tip.x, top: frame.plot.y + 4 } : undefined}
        >
          {tip ? (
            <>
              <p className={styles.tipTime}>{tip.time}</p>
              <ul className={styles.tipList}>
                {tip.rows.map((r) => (
                  <li key={r.key} className={styles.tipRow}>
                    <span className={styles.swatch} style={{ background: `var(${r.color})` }} aria-hidden="true" />
                    <span className={styles.tipName}>{r.name}</span>
                    <span className={styles.tipValue}>{r.text}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>
      {opts.legend === "bottom" && series.length > 0 ? (
        <Legend
          items={series.map((s) => ({ key: s.key, name: s.name, color: colors.get(s.key) as string }))}
          hidden={hidden}
          onSolo={solo}
          onToggle={toggle}
        />
      ) : null}
    </div>
  );
}
