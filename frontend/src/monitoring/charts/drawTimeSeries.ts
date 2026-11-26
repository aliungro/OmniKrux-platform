// The time series, in two steps. `buildFrame` turns series into numbers: one y per pixel column per
// visible series (from `decimate`), the y scale, the x ticks and the thresholds. `drawTimeSeries`
// paints a frame on a canvas. Colours stay token names in the frame and are resolved by the caller
// at draw time, so a theme change is picked up and no colour is hard-coded.

import type { ChartSeries } from "../dashboards/runPanel";
import type { Threshold, TimeseriesOptions } from "../dashboards/schema";
import { decimate } from "./decimate";
import { niceTicks, formatTimeTick, timeTicks } from "./scale";
import { seriesColors } from "./colors";
import { formatValue } from "./units";

/** The subset of `CanvasRenderingContext2D` the chart calls, so tests can record calls. */
export type CanvasLike = Pick<
  CanvasRenderingContext2D,
  | "save" | "restore" | "setTransform" | "clearRect" | "fillRect" | "fillText" | "beginPath" | "moveTo" | "lineTo"
  | "closePath" | "rect" | "clip" | "stroke" | "fill" | "setLineDash"
  | "fillStyle" | "strokeStyle" | "lineWidth" | "lineJoin" | "font" | "textAlign" | "textBaseline" | "globalAlpha"
>;

export type ChartRange = { start: number; end: number };
/** A log line's tick on the time series (Explore): its time in seconds and its tone. */
export type ChartMark = { t: number; tone: "error" | "warn" | "info" };
/**
 * An alert rule's threshold on the chart: a dashed `--bad` line at `threshold` and a faint `--bad`
 * fill on the side where the rule fires. `queryRef` names the query the rule watches.
 */
export type AlertBand = { op: "above" | "below"; threshold: number; queryRef: string };

/** Tick colours: rose means failing, so errors may use `--bad` (series colours never do). */
const MARK_COLORS: Record<ChartMark["tone"], string> = { error: "--bad", warn: "--warn", info: "--kind" };
/** Drawn quietest first, so an error tick is never hidden under an info one. */
const MARK_ORDER: ChartMark["tone"][] = ["info", "warn", "error"];
const MARK_W = 2;
const MARK_H = 6;
const MARK_ALPHA = 0.85;
/** The firing side of an alert band: rose, barely there (lighter than a filled area), so the series
 * stay readable over it even when it covers the whole plot. */
const BAND_ALPHA = 0.04;
const BAND_LINE = 1.2;

export interface FrameSize {
  width: number;
  height: number;
  dpr: number;
}

export interface FrameSeries {
  key: string;
  name: string;
  /** A Territories token name such as `--kind`. */
  color: string;
  /** Data value per pixel column; `NaN` is a gap. For `stacked` this is the series' own value. */
  values: Float32Array;
  /** Y per pixel column in pixels from the plot's top (the top of the band when stacked); `NaN` is a gap. */
  ys: Float32Array;
  /** Stacked only: the y of the band's lower edge. */
  base?: Float32Array;
}

/** One bar of the `bars` style: a sample's value as a block from `y0` to `y1` (pixels from the plot's top). */
export interface FrameBar {
  /** The series' key. */
  key: string;
  /** A Territories token name. */
  color: string;
  /** The bar's left edge and width in pixels from the plot's left. */
  x: number;
  w: number;
  y0: number;
  y1: number;
}

export interface FrameThreshold {
  value: number;
  /** `--ok`, `--warn` or `--bad`. */
  color: string;
  y: number;
}

/** An alert band in the frame: its line's y in pixels from the plot's top. */
export interface FrameAlert {
  op: AlertBand["op"];
  threshold: number;
  y: number;
  /** Always `--bad`: the side where the rule fires. */
  color: string;
}

export interface TimeSeriesFrame {
  size: FrameSize;
  plot: { x: number; y: number; w: number; h: number };
  columns: number;
  range: { start: number; end: number };
  style: TimeseriesOptions["style"];
  series: FrameSeries[];
  yTicks: number[];
  yLabels: string[];
  yPositions: number[];
  xTicks: number[];
  thresholds: FrameThreshold[];
  /** An alert rule's threshold band, or null. */
  alert: FrameAlert | null;
  /** Y of the zero line (or the nearest edge): where a filled area starts. */
  baseline: number;
  /** The `bars` style only: one block per sample and series, stacked from the baseline. */
  bars?: FrameBar[];
  /** The visible series drawn at full strength over the others (dimmed to `HIGHLIGHT_DIM`), or null. */
  highlight: string | null;
  /** False on a short plot: no axis labels, and the plot takes the whole box but a small margin. */
  labels: boolean;
}

const TOP = 8;
const RIGHT = 14;
const BOTTOM = 22;
/** A plot shorter than this (with room for its labels) draws none: they would cover the lines. */
export const SHORT_PLOT = 48;
/** The margin round a plot with no labels, so a line at the edge isn't cut in half. */
const BARE = 3;
/** Whether a canvas this tall leaves a plot of at least `SHORT_PLOT` once its labels have room. */
export const roomForLabels = (height: number) => height - TOP - BOTTOM >= SHORT_PLOT;
const CHAR_W = 6.6; // Geist Mono at 11px
export const FONT = '11px "Geist Mono", ui-monospace, monospace';
const BREAK_AFTER = 3; // a hole wider than this many steps is a gap, not a slope

function stepOf(points: ChartSeries["points"]): number {
  const diffs: number[] = [];
  for (let i = 1; i < points.length && diffs.length < 21; i++) {
    const d = points[i][0] - points[i - 1][0];
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return Infinity;
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1];
}

/** One value per pixel column. Holes narrower than a few steps are bridged; wider ones and nulls stay gaps. */
function columnValues(s: ChartSeries, start: number, end: number, cols: number): Float32Array {
  const vals = new Float32Array(cols).fill(Number.NaN);
  const kind = new Uint8Array(cols); // 0 none, 1 value, 2 gap
  const points = decimate(s.points, start, end, cols);
  const step = stepOf(s.points);
  const per = cols / (end - start);
  let cur = -1;
  let before = Number.NaN;
  let lastT = Number.NaN;
  let lastCol = -1;
  for (const p of points) {
    let c = Math.floor((p[0] - start) * per);
    if (c >= cols) c = cols - 1;
    if (c < 0) continue;
    const v = p[1];
    if (v === null) {
      kind[c] = 2;
      vals[c] = Number.NaN;
      lastT = Number.NaN;
      lastCol = -1;
      continue;
    }
    if (c !== cur) {
      if (cur >= 0 && kind[cur] === 1) before = vals[cur];
      cur = c;
    }
    if (kind[c] === 2) continue;
    if (lastCol >= 0 && p[0] - lastT > BREAK_AFTER * step && c - lastCol >= 2) kind[lastCol + 1] = 2;
    if (kind[c] === 0) {
      vals[c] = v;
      kind[c] = 1;
    } else if (before === before && Math.abs(v - before) > Math.abs(vals[c] - before)) {
      vals[c] = v; // keep the extreme that sits farthest from the column before: spikes survive
    }
    lastT = p[0];
    lastCol = c;
  }
  let prev = -1;
  for (let c = 0; c < cols; c++) {
    if (kind[c] === 2) prev = -1;
    else if (kind[c] === 1) {
      if (prev >= 0 && c - prev > 1) {
        const a = vals[prev];
        const b = vals[c];
        for (let m = prev + 1; m < c; m++) vals[m] = a + ((b - a) * (m - prev)) / (c - prev);
      }
      prev = c;
    }
  }
  return vals;
}

export function buildFrame(
  series: ChartSeries[],
  opts: TimeseriesOptions,
  size: FrameSize,
  range: { start: number; end: number },
  hidden: ReadonlySet<string>,
  alert: AlertBand | null = null,
  step?: number,
  highlight: string | null = null,
): TimeSeriesFrame {
  // An alert's threshold is always on the chart: the y range (explicit bounds too) grows to hold it.
  const limit = alert && Number.isFinite(alert.threshold) ? alert.threshold : null;
  const minOpt = opts.min !== null && limit !== null ? Math.min(opts.min, limit) : opts.min;
  const maxOpt = opts.max !== null && limit !== null ? Math.max(opts.max, limit) : opts.max;
  const visible = series.filter((s) => !hidden.has(s.key));
  const colors = seriesColors(series);
  const filled = opts.style !== "lines";
  const stacked = opts.style === "stacked";
  const barStyle = opts.style === "bars";
  // A short plot gives its label room back to the lines (the panel's text alternative still says it all).
  const labels = roomForLabels(size.height);
  const top = labels ? TOP : BARE;
  const right = labels ? RIGHT : BARE;
  const plotH = Math.max(1, labels ? size.height - TOP - BOTTOM : size.height - 2 * BARE);

  /** The y domain, its ticks and labels for a data extent. */
  const domainFor = (extMin: number, extMax: number) => {
    if (extMin === Infinity) {
      extMin = limit ?? 0;
      extMax = limit === null ? 1 : limit + Math.max(1, Math.abs(limit));
    }
    if (limit !== null) {
      extMin = Math.min(extMin, limit);
      extMax = Math.max(extMax, limit);
    }
    if (filled && minOpt === null) extMin = Math.min(0, extMin);
    const eMin = minOpt ?? extMin;
    const eMax = maxOpt ?? Math.max(extMax, eMin);
    const ticks = niceTicks(eMin, eMax, plotH > 150 ? 5 : 4, opts.unit);
    const lo = minOpt ?? ticks[0];
    let hi = maxOpt ?? ticks[ticks.length - 1];
    if (!(hi > lo)) hi = lo + 1;
    const yTicks = ticks.filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9);
    const yLabels = yTicks.map((t) => formatValue(t, opts.unit, opts.decimals, Math.max(0, ...yTicks.map(Math.abs))));
    const left = labels ? Math.ceil(yLabels.reduce((m, l) => Math.max(m, l.length), 1) * CHAR_W) + 14 : BARE;
    return { lo, hi, yTicks, yLabels, left };
  };
  const colsFor = (left: number) => Math.max(1, Math.floor(Math.max(1, size.width - left - right)));
  const valuesFor = (cols: number) => visible.map((s) => columnValues(s, range.start, range.end, cols));

  let dom: ReturnType<typeof domainFor>;
  let left: number;
  let columns: number;
  let allValues: Float32Array[];
  if (barStyle) {
    // The extent is the tallest stack of samples at one time (negatives stack downwards); the
    // width follows from the labels.
    const up = new Map<number, number>();
    const down = new Map<number, number>();
    for (const s of visible) {
      for (const [t, v] of s.points) {
        if (v === null || v === 0 || t < range.start || t > range.end) continue;
        const sums = v > 0 ? up : down;
        sums.set(t, (sums.get(t) ?? 0) + v);
      }
    }
    let dMin = 0;
    let dMax = 0;
    for (const v of down.values()) dMin = Math.min(dMin, v);
    for (const v of up.values()) dMax = Math.max(dMax, v);
    dom = domainFor(dMin, dMax);
    left = dom.left;
    columns = colsFor(left);
    allValues = valuesFor(columns);
  } else if (!stacked) {
    // The extent is the data's own; the width follows from the labels.
    let dMin = Infinity;
    let dMax = -Infinity;
    for (const s of visible) {
      for (const p of s.points) {
        const v = p[1];
        if (v === null || p[0] < range.start || p[0] > range.end) continue;
        if (v > dMax) dMax = v;
        if (v < dMin) dMin = v;
      }
    }
    dom = domainFor(dMin, dMax);
    left = dom.left;
    columns = colsFor(left);
    allValues = valuesFor(columns);
  } else {
    // The extent is the tallest column sum as drawn, and the columns depend on the width, which
    // depends on the labels: settle them together (two or three passes), so no band is clipped.
    left = labels ? 56 : BARE;
    for (let pass = 0; ; pass++) {
      columns = colsFor(left);
      allValues = valuesFor(columns);
      let dMin = Infinity;
      let dMax = -Infinity;
      for (let c = 0; c < columns; c++) {
        let sum = 0;
        let any = false;
        for (const v of allValues) {
          if (v[c] === v[c]) {
            sum += v[c];
            any = true;
          }
        }
        if (!any) continue;
        if (sum > dMax) dMax = sum;
        if (sum < dMin) dMin = sum;
      }
      dom = domainFor(dMin, dMax);
      if (dom.left === left || pass >= 3) break;
      left = dom.left;
    }
  }
  const { lo, hi, yTicks, yLabels } = dom;
  const plot = { x: left, y: top, w: Math.max(1, size.width - left - right), h: plotH };
  const yOf = (v: number) => plot.h - ((v - lo) / (hi - lo)) * plot.h;

  const out: FrameSeries[] = [];
  const cum = stacked ? new Float32Array(columns) : null;
  visible.forEach((s, si) => {
    const values = allValues[si];
    const ys = new Float32Array(columns);
    const base = cum ? new Float32Array(columns) : undefined;
    for (let c = 0; c < columns; c++) {
      const v = values[c];
      if (cum && base) {
        base[c] = yOf(cum[c]);
        if (v === v) cum[c] += v;
        ys[c] = v === v ? yOf(cum[c]) : Number.NaN;
      } else {
        ys[c] = v === v ? yOf(v) : Number.NaN;
      }
    }
    out.push({ key: s.key, name: s.name, color: colors.get(s.key) as string, values, ys, base });
  });

  let bars: FrameBar[] | undefined;
  if (barStyle) {
    const list: FrameBar[] = [];
    bars = list;
    const span = range.end - range.start;
    // A bar is 0.7 of the query step wide. Series may hold only the steps with a value (a restart),
    // so the gaps between samples say nothing about the step: they are used only when none is known.
    let gap = step !== undefined && step > 0 ? step : 0;
    if (gap === 0) {
      const times = new Set<number>();
      for (const s of visible) for (const p of s.points) if (p[1] !== null && p[0] >= range.start && p[0] <= range.end) times.add(p[0]);
      const sorted = [...times].sort((a, b) => a - b);
      const gaps = sorted.slice(1).map((t, i) => t - sorted[i]).sort((a, b) => a - b);
      gap = gaps.length > 0 ? gaps[gaps.length >> 1] : span;
    }
    const w = Math.max(1, 0.7 * (span > 0 ? (gap / span) * plot.w : plot.w));
    const zero = yOf(Math.min(hi, Math.max(lo, 0)));
    const upTo = new Map<number, number>();
    const downTo = new Map<number, number>();
    visible.forEach((s) => {
      const color = colors.get(s.key) as string;
      for (const [t, v] of s.points) {
        if (v === null || v === 0 || !(t >= range.start && t <= range.end) || span <= 0) continue;
        const sums = v > 0 ? upTo : downTo;
        const from = sums.get(t) ?? 0;
        sums.set(t, from + v);
        list.push({ key: s.key, color, x: ((t - range.start) / span) * plot.w - w / 2, w, y0: from === 0 ? zero : yOf(from), y1: yOf(from + v) });
      }
    });
  }

  const thresholds = opts.thresholds.map((t: Threshold) => ({ value: t.value, color: `--${t.color}`, y: yOf(t.value) }));
  return {
    size,
    plot,
    columns,
    range,
    style: opts.style,
    series: out,
    yTicks,
    yLabels,
    yPositions: yTicks.map(yOf),
    xTicks: labels ? timeTicks(range.start, range.end, Math.max(2, Math.floor(plot.w / 90))) : [],
    thresholds,
    alert: limit !== null && alert ? { op: alert.op, threshold: limit, y: yOf(limit), color: "--bad" } : null,
    baseline: yOf(Math.min(hi, Math.max(lo, 0))),
    ...(bars ? { bars } : {}),
    highlight: highlight !== null && visible.some((s) => s.key === highlight) ? highlight : null,
    labels,
  };
}

const AREA_ALPHA = 0.18;
const BAR_ALPHA = 0.85;
/** How strongly the other series draw while one is highlighted (their colours stay the same). */
export const HIGHLIGHT_DIM = 0.25;

/**
 * Paint a frame. `colorOf` turns a token name into the colour to paint with (read from the page at
 * draw time). `marks` are log line ticks along the bottom of the plot, at most one per pixel column
 * per tone.
 */
export function drawTimeSeries(
  ctx: CanvasLike,
  frame: TimeSeriesFrame,
  colorOf: (token: string) => string = (t) => t,
  marks: readonly ChartMark[] = [],
): void {
  const { size, plot, columns, range } = frame;
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);

  // Grid and y labels.
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (let i = 0; i < frame.yTicks.length; i++) {
    const y = plot.y + frame.yPositions[i];
    ctx.fillStyle = colorOf("--rule");
    ctx.fillRect(plot.x, Math.round(y) - 0.5, plot.w, 1);
    if (!frame.labels) continue;
    ctx.fillStyle = colorOf("--ink-3");
    ctx.fillText(frame.yLabels[i], plot.x - 8, y);
  }
  // x labels.
  const span = range.end - range.start;
  ctx.textBaseline = "top";
  ctx.fillStyle = colorOf("--ink-3");
  const gap = frame.xTicks.length > 1 ? frame.xTicks[1] - frame.xTicks[0] : 60;
  for (const t of frame.xTicks) {
    const x = plot.x + ((t - range.start) / span) * plot.w;
    ctx.textAlign = x < plot.x + 18 ? "left" : x > plot.x + plot.w - 18 ? "right" : "center";
    ctx.fillText(formatTimeTick(t, span, gap), x, plot.y + plot.h + 7);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // A highlighted series: the others draw dimmed, and it draws last, on top.
  const lit = frame.highlight;
  const strength = (key: string) => (lit === null || key === lit ? 1 : HIGHLIGHT_DIM);
  const order = lit === null ? frame.series : [...frame.series.filter((s) => s.key !== lit), ...frame.series.filter((s) => s.key === lit)];

  // Bars: a block per sample, nothing for a null or a zero.
  if (frame.style === "bars" && frame.bars) {
    for (const b of frame.bars) {
      ctx.globalAlpha = BAR_ALPHA * strength(b.key);
      ctx.fillStyle = colorOf(b.color);
      const top = Math.min(b.y0, b.y1);
      ctx.fillRect(plot.x + b.x, plot.y + top, b.w, Math.max(1, Math.abs(b.y0 - b.y1)));
    }
    ctx.globalAlpha = 1;
  }

  // Fills.
  if (frame.style === "area" || frame.style === "stacked") {
    for (const s of order) {
      ctx.globalAlpha = AREA_ALPHA * strength(s.key);
      ctx.fillStyle = colorOf(s.color);
      let c = 0;
      while (c < columns) {
        if (s.ys[c] !== s.ys[c]) { c++; continue; }
        const from = c;
        while (c < columns && s.ys[c] === s.ys[c]) c++;
        const to = c - 1;
        if (to === from) continue;
        ctx.beginPath();
        ctx.moveTo(plot.x + from + 0.5, plot.y + s.ys[from]);
        for (let i = from + 1; i <= to; i++) ctx.lineTo(plot.x + i + 0.5, plot.y + s.ys[i]);
        for (let i = to; i >= from; i--) ctx.lineTo(plot.x + i + 0.5, plot.y + (s.base ? s.base[i] : frame.baseline));
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // An alert's band: the firing side filled faintly, then its dashed line at the threshold.
  if (frame.alert) drawAlertBand(ctx, frame, frame.alert, colorOf);

  // Thresholds: dashed, in their colour.
  const inside = frame.thresholds.filter((t) => t.y >= 0 && t.y <= plot.h);
  if (inside.length > 0) {
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1;
    for (const t of inside) {
      ctx.strokeStyle = colorOf(t.color);
      ctx.beginPath();
      ctx.moveTo(plot.x, plot.y + t.y);
      ctx.lineTo(plot.x + plot.w, plot.y + t.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Lines: gaps break the path; a lone point is a dot.
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  for (const s of frame.style === "bars" ? [] : order) {
    ctx.globalAlpha = strength(s.key);
    const color = colorOf(s.color);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    let pen = false;
    for (let c = 0; c < columns; c++) {
      const y = s.ys[c];
      if (y !== y) { pen = false; continue; }
      const x = plot.x + c + 0.5;
      if (pen) ctx.lineTo(x, plot.y + y);
      else {
        ctx.moveTo(x, plot.y + y);
        if (c + 1 >= columns || s.ys[c + 1] !== s.ys[c + 1]) ctx.fillRect(x - 1.5, plot.y + y - 1.5, 3, 3);
      }
      pen = true;
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  if (marks.length > 0) drawMarks(ctx, frame, colorOf, marks);
}

function drawAlertBand(ctx: CanvasLike, frame: TimeSeriesFrame, alert: FrameAlert, colorOf: (token: string) => string): void {
  const { plot } = frame;
  const y = Math.min(plot.h, Math.max(0, alert.y));
  const color = colorOf(alert.color);
  ctx.save();
  ctx.globalAlpha = BAND_ALPHA;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (alert.op === "above") ctx.rect(plot.x, plot.y, plot.w, y);
  else ctx.rect(plot.x, plot.y + y, plot.w, plot.h - y);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = BAND_LINE;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(plot.x, plot.y + y);
  ctx.lineTo(plot.x + plot.w, plot.y + y);
  ctx.stroke();
  ctx.restore();
}

function drawMarks(ctx: CanvasLike, frame: TimeSeriesFrame, colorOf: (token: string) => string, marks: readonly ChartMark[]): void {
  const { plot, range } = frame;
  const span = range.end - range.start;
  if (!(span > 0)) return;
  const columns = new Map<ChartMark["tone"], Set<number>>(MARK_ORDER.map((t) => [t, new Set<number>()]));
  for (const m of marks) {
    if (!(m.t >= range.start && m.t <= range.end)) continue;
    const col = Math.min(Math.floor(plot.w) - 1, Math.floor(((m.t - range.start) / span) * plot.w));
    columns.get(m.tone)?.add(Math.max(0, col));
  }
  ctx.save();
  ctx.globalAlpha = MARK_ALPHA;
  const y = plot.y + plot.h - MARK_H;
  for (const tone of MARK_ORDER) {
    const cols = columns.get(tone) as Set<number>;
    if (cols.size === 0) continue;
    ctx.fillStyle = colorOf(MARK_COLORS[tone]);
    for (const c of cols) ctx.fillRect(plot.x + c - MARK_W / 2 + 0.5, y, MARK_W, MARK_H);
  }
  ctx.restore();
}
