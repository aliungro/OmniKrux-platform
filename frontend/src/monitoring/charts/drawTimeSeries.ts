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

export interface FrameThreshold {
  value: number;
  /** `--ok`, `--warn` or `--bad`. */
  color: string;
  y: number;
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
  /** Y of the zero line (or the nearest edge): where a filled area starts. */
  baseline: number;
}

const TOP = 8;
const RIGHT = 14;
const BOTTOM = 22;
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
): TimeSeriesFrame {
  const visible = series.filter((s) => !hidden.has(s.key));
  const colors = seriesColors(series);
  const filled = opts.style !== "lines";
  const stacked = opts.style === "stacked";
  const plotH = Math.max(1, size.height - TOP - BOTTOM);

  /** The y domain, its ticks and labels for a data extent. */
  const domainFor = (extMin: number, extMax: number) => {
    if (extMin === Infinity) {
      extMin = 0;
      extMax = 1;
    }
    if (filled && opts.min === null) extMin = Math.min(0, extMin);
    const eMin = opts.min ?? extMin;
    const eMax = opts.max ?? Math.max(extMax, eMin);
    const ticks = niceTicks(eMin, eMax, plotH > 150 ? 5 : 4);
    const lo = opts.min ?? ticks[0];
    let hi = opts.max ?? ticks[ticks.length - 1];
    if (!(hi > lo)) hi = lo + 1;
    const yTicks = ticks.filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9);
    const yLabels = yTicks.map((t) => formatValue(t, opts.unit, opts.decimals));
    const left = Math.ceil(yLabels.reduce((m, l) => Math.max(m, l.length), 1) * CHAR_W) + 14;
    return { lo, hi, yTicks, yLabels, left };
  };
  const colsFor = (left: number) => Math.max(1, Math.floor(Math.max(1, size.width - left - RIGHT)));
  const valuesFor = (cols: number) => visible.map((s) => columnValues(s, range.start, range.end, cols));

  let dom: ReturnType<typeof domainFor>;
  let left: number;
  let columns: number;
  let allValues: Float32Array[];
  if (!stacked) {
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
    left = 56;
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
  const plot = { x: left, y: TOP, w: Math.max(1, size.width - left - RIGHT), h: plotH };
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
    xTicks: timeTicks(range.start, range.end, Math.max(2, Math.floor(plot.w / 90))),
    thresholds,
    baseline: yOf(Math.min(hi, Math.max(lo, 0))),
  };
}

const AREA_ALPHA = 0.18;

/** Paint a frame. `colorOf` turns a token name into the colour to paint with (read from the page at draw time). */
export function drawTimeSeries(ctx: CanvasLike, frame: TimeSeriesFrame, colorOf: (token: string) => string = (t) => t): void {
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
    ctx.fillStyle = colorOf("--ink-3");
    ctx.fillText(frame.yLabels[i], plot.x - 8, y);
  }
  // x labels.
  const span = range.end - range.start;
  ctx.textBaseline = "top";
  ctx.fillStyle = colorOf("--ink-3");
  for (const t of frame.xTicks) {
    const x = plot.x + ((t - range.start) / span) * plot.w;
    ctx.textAlign = x < plot.x + 18 ? "left" : x > plot.x + plot.w - 18 ? "right" : "center";
    ctx.fillText(formatTimeTick(t, span), x, plot.y + plot.h + 7);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();

  // Fills.
  if (frame.style !== "lines") {
    ctx.globalAlpha = AREA_ALPHA;
    for (const s of frame.series) {
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
  for (const s of frame.series) {
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
  ctx.restore();
}
