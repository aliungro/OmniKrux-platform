// The time series panel: a canvas sized to its box at the device pixel ratio, a crosshair with a
// tooltip (mouse, or the arrow keys on the focused chart), and the legend. Option and query edits
// morph the lines; refreshes, resizes and reduced motion jump. The tooltip lists the ten biggest
// values and counts the rest, and is placed inside the window; hovering or focusing a legend item
// highlights its series (the others dim, no colour changes).
//
// With `onSelect` (Explore only) a window can be chosen: drag across the plot, or Shift+arrows from
// the crosshair; the band stays drawn over the full range, and log line `marks` tick the bottom.
// Without it no pointer handler is bound at all: dashboards get M2's chart unchanged.

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type PointerEvent,
} from "react";
import type { ChartSeries } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import { buildFrame, drawTimeSeries, type AlertBand, type ChartMark, type ChartRange, type FrameSeries, type TimeSeriesFrame } from "./drawTimeSeries";
import { resolveToken, seriesColors } from "./colors";
import Legend from "./Legend";
import { placeTip, tipRows } from "./tooltip";
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
  selection?: ChartRange | null;
  onSelect?: (range: ChartRange | null, via?: "pointer" | "keyboard") => void;
  marks?: ChartMark[];
  /** Explore: the run's step in seconds; a chosen window snaps to it (else to the samples' spacing). */
  step?: number;
  /** An alert rule's threshold band, drawn under the series. */
  alert?: AlertBand | null;
}

interface Drawn {
  target: TimeSeriesFrame;
  shown: TimeSeriesFrame;
  changeId: number;
  editId: number;
  marks: readonly ChartMark[];
  cancel?: () => void;
}

const NO_HIDDEN: ReadonlySet<string> = new Set();
const NO_MARKS: readonly ChartMark[] = [];
/** A drag narrower than this is a click: nothing is selected. */
const CLICK_PX = 4;
/** Shift+arrows select once the keys rest this long. */
const KEY_SELECT_MS = 300;

/** The spacing of the samples (their median gap), so a window snaps to the data's own step. */
function sampleStep(samples: number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < samples.length && gaps.length < 21; i++) {
    const d = samples[i] - samples[i - 1];
    if (d > 0) gaps.push(d);
  }
  if (gaps.length === 0) return 1;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

const two = (n: number) => String(n).padStart(2, "0");
const clockTime = (s: number) => {
  const d = new Date(s * 1000);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

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

export default function TimeSeriesChart({
  panel, series, range, animate, changeId, editId, selection = null, onSelect, marks = NO_MARKS as ChartMark[], step: runStep, alert = null,
}: TimeSeriesChartProps) {
  const opts = panel.options;
  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawn = useRef<Drawn | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_HIDDEN);
  const [cursor, setCursor] = useState<number | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
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
  // A new list only when the series change, so the legend can tell a refresh from a hover.
  const legendItems = useMemo(
    () => series.map((s) => ({ key: s.key, name: s.name, color: colors.get(s.key) as string })),
    [series, colors],
  );
  // A highlighted series that a refresh took away is forgotten, so it doesn't light up again
  // when it comes back without a hover or focus.
  useEffect(() => {
    if (highlighted !== null && !series.some((s) => s.key === highlighted)) setHighlighted(null);
  }, [series, highlighted]);
  const frame = useMemo(
    () => (size.width > 0 && size.height > 0
      ? buildFrame(series, opts, { ...size, dpr }, { start: range.start, end: range.end }, hidden, alert, runStep, highlighted)
      : null),
    [series, opts, size, dpr, range.start, range.end, hidden, alert, runStep, highlighted],
  );

  // Paint. An edit morphs from what is on the canvas; anything else jumps.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    const prev = drawn.current;
    if (prev && prev.target === frame && prev.marks === marks) {
      prev.changeId = changeId;
      prev.editId = editId;
      return;
    }
    prev?.cancel?.();
    const w = Math.round(frame.size.width * frame.size.dpr);
    const h = Math.round(frame.size.height * frame.size.dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const entry: Drawn = { target: frame, shown: frame, changeId, editId, marks };
    drawn.current = entry;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // no canvas here: the text alternative still says what the chart shows
    const style = getComputedStyle(canvas);
    const colorOf = (token: string) => resolveToken(style, token);

    const edited = prev !== null && prev.target !== frame && (changeId > prev.changeId || editId > prev.editId);
    if (!(animate && !reduced && edited && frame.style !== "bars" && sameShape(prev.shown, frame))) {
      drawTimeSeries(ctx, frame, colorOf, marks);
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
      drawTimeSeries(ctx, mixed, colorOf, marks);
    });
  }, [frame, changeId, editId, animate, reduced, marks]);

  useEffect(() => () => drawn.current?.cancel?.(), []);

  const visible = useMemo(() => series.filter((s) => !hidden.has(s.key)), [series, hidden]);

  // The crosshair moves between the longest visible series' own samples; for bars, between every
  // visible series' sample times, since each series holds only the steps where it has a bar.
  const barStyle = opts.style === "bars";
  const samples = useMemo(() => {
    if (barStyle) {
      const times = new Set<number>();
      for (const s of visible) for (const p of s.points) if (p[0] >= range.start && p[0] <= range.end) times.add(p[0]);
      return [...times].sort((a, b) => a - b);
    }
    let best: ChartSeries | null = null;
    for (const s of visible) if (!best || s.points.length > best.points.length) best = s;
    if (!best) return [];
    return best.points.map((p) => p[0]).filter((t) => t >= range.start && t <= range.end);
  }, [visible, barStyle, range.start, range.end]);
  const at = cursor !== null && samples.length > 0 ? Math.min(cursor, samples.length - 1) : null;
  const span = range.end - range.start;

  const onMouseMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    if (!frame || samples.length === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - box.left - frame.plot.x) / frame.plot.w;
    setCursor(nearestIndex(samples, range.start + Math.min(1, Math.max(0, frac)) * span));
  }, [frame, samples, range.start, span]);

  // --- choosing a window (Explore): a drag, or Shift+arrows from the crosshair ---------------------
  const sampled = useMemo(() => sampleStep(samples), [samples]);
  const step = runStep !== undefined && runStep > 0 ? runStep : sampled;
  const toWindow = (a: number, b: number): ChartRange | null => {
    const snap = (t: number) => Math.min(range.end, Math.max(range.start, range.start + Math.round((t - range.start) / step) * step));
    const start = snap(Math.min(a, b));
    let end = snap(Math.max(a, b));
    if (end <= start) end = Math.min(range.end, start + step);
    return end > start ? { start, end } : null;
  };
  // The drag, in the brush layer's pixels (the layer covers exactly the plot area).
  const [drag, setDrag] = useState<{ from: number; to: number; width: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  // Shift+arrows: sample indexes, chosen once the keys rest.
  const [keyBand, setKeyBand] = useState<{ anchor: number; head: number } | null>(null);
  const keyBandRef = useRef(keyBand);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const stopKeyBand = () => {
    if (keyTimer.current !== null) clearTimeout(keyTimer.current);
    keyTimer.current = null;
    keyBandRef.current = null;
    setKeyBand(null);
  };
  useEffect(() => () => { if (keyTimer.current !== null) clearTimeout(keyTimer.current); }, []);

  // The brush went away (no `onSelect`, or no frame to draw on): a drag or key band in progress
  // goes with it, so nothing is left holding Esc.
  const canSelect = onSelect !== undefined && frame !== null;
  useEffect(() => {
    if (canSelect) return;
    setDrag(null);
    if (keyTimer.current !== null) clearTimeout(keyTimer.current);
    keyTimer.current = null;
    keyBandRef.current = null;
    setKeyBand(null);
  }, [canSelect]);

  // Esc while dragging cancels the drag, wherever the keyboard is.
  const dragging = drag !== null && canSelect;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setDrag(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [dragging]);

  const layerX = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(box.width, Math.max(0, e.clientX - box.left)), width: box.width };
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !frame) return;
    const { x, width } = layerX(e);
    if (!(width > 0)) return;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // A pointer that can't be captured still drags while it stays over the plot.
    }
    stopKeyBand();
    setDrag({ from: x, to: x, width });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const { x } = layerX(e);
    setDrag((d) => (d ? { ...d, to: x } : d));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const to = layerX(e).x;
    setDrag(null);
    // A click, not a drag: nothing changes.
    if (Math.abs(to - d.from) < CLICK_PX) return;
    const timeAt = (x: number) => range.start + (x / d.width) * span;
    const chosen = toWindow(timeAt(d.from), timeAt(to));
    if (chosen) selectRef.current?.(chosen, "pointer");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (onSelect && e.shiftKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      if (samples.length === 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const start = at ?? (dir > 0 ? 0 : samples.length - 1);
      const from = keyBandRef.current ?? { anchor: start, head: start };
      const next = { anchor: from.anchor, head: Math.max(0, Math.min(samples.length - 1, from.head + dir)) };
      keyBandRef.current = next;
      setKeyBand(next);
      setCursor(next.head);
      if (keyTimer.current !== null) clearTimeout(keyTimer.current);
      const times = samples;
      keyTimer.current = setTimeout(() => {
        keyTimer.current = null;
        const band = keyBandRef.current;
        keyBandRef.current = null;
        setKeyBand(null);
        if (!band || band.anchor === band.head) return;
        const a = times[Math.min(band.anchor, band.head)];
        const b = times[Math.max(band.anchor, band.head)];
        if (b > a) selectRef.current?.({ start: a, end: b }, "keyboard");
      }, KEY_SELECT_MS);
      return;
    }
    if (e.key === "Escape" && onSelect) {
      if (keyBandRef.current) {
        e.stopPropagation();
        stopKeyBand();
        return;
      }
      if (selection) {
        // Shows all again; the crosshair's own Esc is for when nothing is selected.
        e.stopPropagation();
        onSelect(null, "keyboard");
        return;
      }
    }
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

  type TipRow = { key: string; name: string; color: string; value: number | null; text: string };
  let tip: { x: number; time: string; rows: TipRow[]; more: number } | null = null;
  if (at !== null && frame) {
    const t = samples[at];
    const tolerance = barStyle ? step / 2 : samples.length > 1 ? ((samples[samples.length - 1] - samples[0]) / (samples.length - 1)) * 1.5 : Infinity;
    const { shown, more } = tipRows(visible.map((s) => ({ s, value: valueAt(s.points, t, tolerance) })));
    const rows = shown.map(({ s, value }): TipRow => ({
      key: s.key, name: s.name, color: colors.get(s.key) as string, value, text: formatValue(value, opts.unit, opts.decimals),
    }));
    tip = { x: frame.plot.x + ((t - range.start) / span) * frame.plot.w, time: formatTooltipTime(t), rows, more };
  }

  // Placed after it is measured, before the browser paints (no frame in the wrong place): right of
  // the crosshair unless the window ends there, and never past the window's top or bottom.
  const tipX = tip?.x ?? null;
  const tipTop = frame?.plot.y ?? 0;
  useLayoutEffect(() => {
    const el = tipRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap || tipX === null) return;
    const place = placeTip(
      { x: tipX, y: tipTop + 4 },
      { width: el.offsetWidth, height: el.offsetHeight },
      wrap.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
    );
    el.style.left = `${place.left}px`;
    el.style.top = `${place.top}px`;
  });

  const solo = (key: string) => setHidden(() => {
    const onlyThis = visible.length === 1 && visible[0].key === key;
    return onlyThis ? NO_HIDDEN : new Set(series.filter((s) => s.key !== key).map((s) => s.key));
  });
  const toggle = (key: string) => setHidden((h) => {
    const next = new Set(h);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  // Only a series on the chart can be highlighted (one that went away with a refresh can't).
  const lit = highlighted !== null && series.some((s) => s.key === highlighted) ? highlighted : null;

  const latest = series.slice(0, 3).map((s) => `${s.name} ${formatValue(lastValue(s), opts.unit, opts.decimals)}`);
  const chosenText = selection ? ` Window ${clockTime(selection.start)} – ${clockTime(selection.end)} selected.` : "";
  const label = `${panel.title}: ${series.length} series.${latest.length > 0 ? ` Latest: ${latest.join(", ")}.` : ""}${chosenText}`;

  // The band: the drag in progress, else the keys' band, else the selection (over the full range).
  let band: { left: number; width: number } | null = null;
  if (frame && span > 0) {
    const px = (t: number) => Math.min(frame.plot.w, Math.max(0, ((t - range.start) / span) * frame.plot.w));
    if (drag) band = { left: Math.min(drag.from, drag.to), width: Math.abs(drag.to - drag.from) };
    else if (keyBand && samples.length > 0) {
      const a = px(samples[Math.min(keyBand.anchor, keyBand.head)]);
      band = { left: a, width: px(samples[Math.max(keyBand.anchor, keyBand.head)]) - a };
    } else if (selection) {
      const a = px(selection.start);
      band = { left: a, width: px(selection.end) - a };
    }
  }

  return (
    <div className={styles.chart}>
      <div ref={wrapRef} className={styles.plotWrap}>
        <div
          ref={plotRef}
          className={styles.plot}
          role="img"
          tabIndex={0}
          aria-label={label}
          aria-keyshortcuts={onSelect ? "ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Escape" : "ArrowLeft ArrowRight Escape"}
          onKeyDown={onKeyDown}
          onMouseMove={onMouseMove}
          onMouseLeave={() => setCursor(null)}
        >
          <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
          {band && frame ? (
            <div className={styles.band} data-chart-band="" aria-hidden="true"
              style={{ left: frame.plot.x + band.left, top: frame.plot.y, width: Math.max(1, band.width), height: frame.plot.h }} />
          ) : null}
          {onSelect && frame ? (
            <div
              className={styles.brush}
              data-chart-brush=""
              aria-hidden="true"
              style={{ left: frame.plot.x, top: frame.plot.y, width: frame.plot.w, height: frame.plot.h }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
              onLostPointerCapture={() => setDrag(null)}
            />
          ) : null}
          {tip && frame ? (
            <div className={styles.crosshair} style={{ left: tip.x, top: frame.plot.y, height: frame.plot.h }} aria-hidden="true" />
          ) : null}
        </div>
        <div ref={tipRef} role="status" className={styles.tip}>
          {tip ? (
            <>
              <p className={styles.tipTime}>{tip.time}</p>
              <ul className={styles.tipList}>
                {tip.rows.map((r) => (
                  <li key={r.key} className={r.key === lit ? `${styles.tipRow} ${styles.tipLit}` : styles.tipRow}>
                    <span className={styles.swatch} style={{ background: `var(${r.color})` }} aria-hidden="true" />
                    <span className={styles.tipName} title={r.name}>{r.name}</span>
                    <span className={styles.tipValue}>{r.text}</span>
                  </li>
                ))}
              </ul>
              {tip.more > 0 ? <p className={styles.tipMore}>and {tip.more} more</p> : null}
            </>
          ) : null}
        </div>
      </div>
      {opts.legend === "bottom" && series.length > 0 ? (
        <Legend
          items={legendItems}
          hidden={hidden}
          onSolo={solo}
          onToggle={toggle}
          highlighted={lit}
          onHighlight={setHighlighted}
        />
      ) : null}
    </div>
  );
}
