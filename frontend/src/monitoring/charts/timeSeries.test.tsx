import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartSeries, PanelData } from "../dashboards/runPanel";
import { newAlert, newPanel, type PanelSpec, type TimeseriesOptions } from "../dashboards/schema";
import ChartView, { type ChartViewProps } from "./index";
import userEvent from "@testing-library/user-event";
import { buildFrame, drawTimeSeries, HIGHLIGHT_DIM, type CanvasLike } from "./drawTimeSeries";
import { formatTooltipTime } from "./scale";

const tweenMock = vi.hoisted(() => vi.fn((_ms: number, _on: (k: number) => void) => () => {}));
vi.mock("./motion", async (importOriginal) => ({ ...(await importOriginal<typeof import("./motion")>()), tween: tweenMock }));
// Every frame painted, in order (the real drawing still runs).
const painted = vi.hoisted(() => [] as import("./drawTimeSeries").TimeSeriesFrame[]);
vi.mock("./drawTimeSeries", async (importOriginal) => {
  const real = await importOriginal<typeof import("./drawTimeSeries")>();
  return {
    ...real,
    drawTimeSeries: (...args: Parameters<typeof real.drawTimeSeries>) => {
      painted.push(args[1]);
      return real.drawTimeSeries(...args);
    },
  };
});

// --- fixtures ---------------------------------------------------------------------------------

type P = [number, number | null];
const START = 1_000_000;
const series = (name: string, values: (number | null)[], more: Partial<ChartSeries> = {}): ChartSeries => ({
  key: `k-${name}`, name, labels: { job: name }, queryRef: "A", projectName: null,
  points: values.map((v, i) => [START + i * 60, v] as P), ...more,
});
const panelOf = (options: Partial<TimeseriesOptions> = {}, title = "Latency"): PanelSpec => {
  const p = newPanel("timeseries", "p-1", { x: 0, y: 0, w: 12, h: 8 });
  return { ...p, title, options: { ...p.options, ...options } } as PanelSpec;
};
const dataOf = (s: ChartSeries[], more: Partial<PanelData> = {}): PanelData => ({
  state: "ready", series: s, logs: [], problems: [], summary: { series: s.length, points: 0, tookMs: 1 }, editId: 0, ...more,
});
const RANGE = { start: START, end: START + 120 };
const SIZE = { width: 600, height: 240, dpr: 1 };

function recorder() {
  const calls: { name: string; args: unknown[]; lineWidth: number }[] = [];
  const state = { lineWidth: 1 };
  const ctx = new Proxy({ ...state } as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => { calls.push({ name: prop, args, lineWidth: target.lineWidth as number }); };
    },
    set(target, prop: string, value) { target[prop] = value; return true; },
  });
  return { ctx: ctx as unknown as CanvasLike, calls };
}

// --- the frame and the drawing ----------------------------------------------------------------

describe("buildFrame and drawTimeSeries", () => {
  const options = panelOf({ thresholds: [{ value: 3, color: "warn" }] }).options as TimeseriesOptions;
  const three = [series("a", [1, 2, 3]), series("b", [3, 2, 1]), series("c", [2, 2, 2])];

  it("draws one path per visible series and the thresholds", () => {
    const frame = buildFrame(three, options, SIZE, RANGE, new Set(["k-c"]));
    expect(frame.series.map((s) => s.key)).toEqual(["k-a", "k-b"]);
    const { ctx, calls } = recorder();
    drawTimeSeries(ctx, frame, (token) => token);
    expect(calls.filter((c) => c.name === "stroke" && c.lineWidth === 1.5)).toHaveLength(2);
    expect(calls.filter((c) => c.name === "setLineDash" && (c.args[0] as number[]).length > 0)).toHaveLength(1);
  });

  it("the threshold band is drawn on the firing side", () => {
    // A recorder that keeps the paint state at each call.
    const record = () => {
      const calls: { name: string; args: unknown[]; strokeStyle: unknown; fillStyle: unknown; globalAlpha: unknown; dash: number[] }[] = [];
      const state: Record<string, unknown> = { lineWidth: 1, globalAlpha: 1, strokeStyle: "", fillStyle: "" };
      let dash: number[] = [];
      const saved: { dash: number[]; values: Record<string, unknown> }[] = [];
      const ctx = new Proxy(state, {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          return (...args: unknown[]) => {
            if (prop === "setLineDash") dash = args[0] as number[];
            // save and restore keep the dash and paint state, as a canvas does.
            if (prop === "save") saved.push({ dash, values: { ...target } });
            if (prop === "restore") {
              const back = saved.pop();
              if (back) { dash = back.dash; Object.assign(target, back.values); }
            }
            calls.push({ name: prop, args, strokeStyle: target.strokeStyle, fillStyle: target.fillStyle, globalAlpha: target.globalAlpha, dash });
          };
        },
        set(target, prop: string, value) { target[prop] = value; return true; },
      });
      return { ctx: ctx as unknown as CanvasLike, calls };
    };
    const lines = { ...options, thresholds: [], style: "lines" as const };
    const data = [series("a", [1, 2, 3])];
    for (const op of ["above", "below"] as const) {
      const frame = buildFrame(data, lines, SIZE, RANGE, new Set(), { op, threshold: 2, queryRef: "A" });
      const { ctx, calls } = record();
      drawTimeSeries(ctx, frame, (token) => `color(${token})`);
      const dashed = calls.filter((c) => c.name === "stroke" && c.dash.length > 0);
      expect(dashed).toHaveLength(1);
      expect(dashed[0].strokeStyle).toBe("color(--bad)");
      const fills = calls.filter((c) => c.name === "fill");
      expect(fills).toHaveLength(1);
      expect(fills[0]).toMatchObject({ fillStyle: "color(--bad)", globalAlpha: 0.04 });
      // The rect filled is the one just before the fill: above the line for "above", below it for "below".
      const at = calls.indexOf(fills[0]);
      const rect = calls.slice(0, at).reverse().find((c) => c.name === "rect")!.args as number[];
      const lineY = frame.plot.y + frame.alert!.y;
      if (op === "above") {
        expect(rect[1]).toBe(frame.plot.y);
        expect(rect[1] + rect[3]).toBeCloseTo(lineY);
      } else {
        expect(rect[1]).toBeCloseTo(lineY);
        expect(rect[1] + rect[3]).toBeCloseTo(frame.plot.y + frame.plot.h);
      }
    }
    // A threshold above every value widens the y range to hold it.
    const plain = buildFrame(data, lines, SIZE, RANGE, new Set());
    const high = buildFrame(data, lines, SIZE, RANGE, new Set(), { op: "above", threshold: 40, queryRef: "A" });
    expect(plain.yTicks[plain.yTicks.length - 1]).toBeLessThan(40);
    expect(high.yTicks[high.yTicks.length - 1]).toBeGreaterThanOrEqual(40);
    expect(high.alert!.y).toBeGreaterThanOrEqual(0);
    expect(plain.alert).toBeNull();
  });

  it("a highlighted series draws at full strength over the dimmed others", () => {
    const strokes = (frame: ReturnType<typeof buildFrame>) => {
      const out: { color: unknown; alpha: unknown }[] = [];
      const state: Record<string, unknown> = { globalAlpha: 1, strokeStyle: "", lineWidth: 1 };
      const ctx = new Proxy(state, {
        get: (t, prop: string) => (prop in t ? t[prop] : (..._args: unknown[]) => {
          if (prop === "stroke" && t.lineWidth === 1.5) out.push({ color: t.strokeStyle, alpha: t.globalAlpha });
        }),
        set: (t, prop: string, value) => { t[prop] = value; return true; },
      }) as unknown as CanvasLike;
      drawTimeSeries(ctx, frame, (token) => token);
      return out;
    };
    const lines = { ...options, thresholds: [], style: "lines" as const };
    const plain = buildFrame(three, lines, SIZE, RANGE, new Set());
    expect(plain.highlight).toBeNull();
    expect(strokes(plain).every((s) => s.alpha === 1)).toBe(true);
    const lit = buildFrame(three, lines, SIZE, RANGE, new Set(), null, undefined, "k-b");
    expect(lit.highlight).toBe("k-b");
    const drawn = strokes(lit);
    const colourOfB = lit.series.find((s) => s.key === "k-b")!.color;
    // Drawn last, so it sits on top; the others at a quarter.
    expect(drawn[drawn.length - 1]).toEqual({ color: colourOfB, alpha: 1 });
    expect(drawn.slice(0, -1).map((s) => s.alpha)).toEqual([HIGHLIGHT_DIM, HIGHLIGHT_DIM]);
    expect(HIGHLIGHT_DIM).toBe(0.25);
    // The colours are the same as without the highlight.
    expect(lit.series.map((s) => s.color)).toEqual(plain.series.map((s) => s.color));
    // A hidden or unknown key highlights nothing.
    expect(buildFrame(three, lines, SIZE, RANGE, new Set(["k-b"]), null, undefined, "k-b").highlight).toBeNull();
    expect(buildFrame(three, lines, SIZE, RANGE, new Set(), null, undefined, "nope").highlight).toBeNull();
  });

  it("has one y value per pixel column", () => {
    const frame = buildFrame(three, options, SIZE, RANGE, new Set());
    for (const s of frame.series) expect(s.ys.length).toBe(frame.columns);
    expect(frame.columns).toBe(Math.floor(frame.plot.w));
  });

  it("bars draw one rect per sample and nothing for zero", () => {
    const o = { ...options, style: "bars" as const, thresholds: [], min: null, max: null };
    const data = [series("a", [2, 0, 3]), series("b", [1, null, 1])];
    const frame = buildFrame(data, o, SIZE, RANGE, new Set());
    expect(frame.yTicks[0]).toBe(0);
    expect(frame.yTicks[frame.yTicks.length - 1]).toBeGreaterThanOrEqual(4);
    const painted: { color: unknown; args: number[] }[] = [];
    let fillStyle: unknown = "";
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop: string) => (prop === "fillStyle" ? fillStyle : (...args: number[]) => { if (prop === "fillRect") painted.push({ color: fillStyle, args }); }),
      set: (_t, prop: string, value) => { if (prop === "fillStyle") fillStyle = value; return true; },
    }) as unknown as CanvasLike;
    drawTimeSeries(ctx, frame, (token) => `color(${token})`);
    const bars = painted.filter((p) => !["color(--rule)", "color(--ink-3)"].includes(p.color as string));
    // Series a: samples 0 and 2; series b: samples 0 and 2 (the zero and the null draw nothing).
    expect(bars).toHaveLength(4);
    expect(frame.bars).toHaveLength(4);
    const gap = (60 / (RANGE.end - RANGE.start)) * frame.plot.w;
    expect(bars[0].args[2]).toBeCloseTo(Math.max(1, 0.7 * gap));
    // The second series stacks on the first at the same time: it ends where the first starts.
    const [a0, b0] = [bars[0].args, bars.find((b) => b.color !== bars[0].color)!.args];
    expect(b0[1] + b0[3]).toBeCloseTo(a0[1], 0);
    expect(frame.series[0].values.length).toBe(frame.columns);
  });

  it("sparse bars are a step wide, not as wide as the gap between restarts", () => {
    const o = { ...options, style: "bars" as const, thresholds: [], min: null, max: null };
    const hours = { start: START, end: START + 6 * 3600 };
    const one: ChartSeries = { ...series("a", []), points: [[START + 3600, 2]] };
    const frame = buildFrame([one], o, SIZE, hours, new Set(), null, 60);
    expect(frame.bars).toHaveLength(1);
    const stepPx = (60 / (6 * 3600)) * frame.plot.w;
    expect(frame.bars![0].w).toBeCloseTo(Math.max(1, 0.7 * stepPx));
    expect(frame.bars![0].w).toBeLessThan(frame.plot.w / 20);
    // Two far-apart restarts: still a step wide.
    const two2: ChartSeries = { ...series("b", []), points: [[START + 600, 1], [START + 18000, 1]] };
    const f2 = buildFrame([two2], o, SIZE, hours, new Set(), null, 60);
    expect(f2.bars!.map((b) => b.w)).toEqual([f2.bars![0].w, f2.bars![0].w]);
    expect(f2.bars![0].w).toBeLessThan(frame.plot.w / 20);
  });

  it("breaks the line at a gap", () => {
    const frame = buildFrame([series("a", [1, null, 3])], options, SIZE, RANGE, new Set());
    const ys = frame.series[0].ys;
    expect(ys.some((y) => Number.isNaN(y))).toBe(true);
    expect(Number.isNaN(ys[Math.floor(frame.columns / 2)])).toBe(true);
  });

  it("honours the min and max options", () => {
    const o = { ...options, min: 0, max: 10 };
    const frame = buildFrame(three, o, SIZE, RANGE, new Set());
    expect(frame.yTicks[0]).toBe(0);
    expect(frame.yTicks[frame.yTicks.length - 1]).toBe(10);
  });

  it("stacks the visible series", () => {
    const o = { ...options, style: "stacked" as const, thresholds: [] };
    const frame = buildFrame([series("a", [1, 1, 1]), series("b", [2, 2, 2])], o, SIZE, RANGE, new Set());
    expect(frame.yTicks[frame.yTicks.length - 1]).toBeGreaterThanOrEqual(3);
    const [a, b] = frame.series;
    const mid = Math.floor(frame.columns / 2);
    expect(b.ys[mid]).toBeLessThan(a.ys[mid]); // b's top sits above a's
    expect(b.base![mid]).toBeCloseTo(a.ys[mid]);
  });

  it("keeps the top band of a stack whose peaks share a column at different times", () => {
    const spike = (name: string, at: number): ChartSeries => ({
      key: `k-${name}`, name, labels: {}, queryRef: "A", projectName: null,
      points: Array.from({ length: 1201 }, (_, i) => [i, i === at ? 10 : 0] as P),
    });
    const o = { ...options, style: "stacked" as const, thresholds: [] };
    const frame = buildFrame([spike("a", 100), spike("b", 101)], o, SIZE, { start: 0, end: 1200 }, new Set());
    expect(frame.yTicks[frame.yTicks.length - 1]).toBeGreaterThanOrEqual(20);
    const top = Math.min(...Array.from(frame.series[1].ys).filter((y) => y === y));
    expect(top).toBeGreaterThanOrEqual(0); // inside the plot, not clipped above it
  });

  it("draws nothing for no series, and survives an empty range", () => {
    const frame = buildFrame([], options, SIZE, { start: 5, end: 5 }, new Set());
    expect(frame.series).toEqual([]);
    const { ctx } = recorder();
    expect(() => drawTimeSeries(ctx, frame, (t) => t)).not.toThrow();
  });
});

// --- the component ----------------------------------------------------------------------------

function stubBrowser(reduced = false, size: { width: number; height: number } = SIZE) {
  const ctx = recorder();
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: reduced && q.includes("reduce"), addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: size.width, height: size.height } }]); }
    disconnect() {}
    unobserve() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx.ctx as unknown as CanvasRenderingContext2D);
  return ctx;
}

beforeEach(() => {
  tweenMock.mockClear();
  painted.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const base = (over: Partial<ChartViewProps> = {}): ChartViewProps => ({
  panel: panelOf(), data: dataOf([series("a", [1, 2, 3]), series("b", [3, 2, 1])]), range: RANGE, animate: true, changeId: 0, ...over,
});

describe("ChartView time series", () => {
  it("draws on the canvas it is given", () => {
    const { calls } = stubBrowser();
    render(<ChartView {...base()} />);
    expect(calls.filter((c) => c.name === "stroke" && c.lineWidth === 1.5)).toHaveLength(2);
  });

  it("keeps its text alternative where there is no canvas", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    render(<ChartView {...base({ panel: panelOf({ unit: "short" }) })} />);
    expect(screen.getByRole("img", { name: "Latency: 2 series. Latest: a 3, b 1." })).toBeTruthy();
  });

  it("names the first three series in the label and counts them all", () => {
    stubBrowser();
    const s = ["a", "b", "c", "d"].map((n, i) => series(n, [i, i + 1]));
    render(<ChartView {...base({ data: dataOf(s) })} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Latency: 4 series. Latest: a 1, b 2, c 3.");
  });

  it("draws no old series when the panel is unreachable or errored", () => {
    for (const state of ["unreachable", "error", "noQuery"] as const) {
      const { calls } = stubBrowser();
      const { unmount } = render(<ChartView {...base({ data: dataOf([series("a", [1, 2, 3])], { state }) })} />);
      expect(calls.filter((c) => c.name === "stroke" && c.lineWidth === 1.5)).toHaveLength(0);
      expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/0 series/);
      unmount();
      vi.restoreAllMocks();
    }
  });

  it("a panel's alert draws its band: the time series' dashed line, the bar line, the gauge tick", () => {
    const dashes = (calls: { name: string; args: unknown[] }[]) =>
      calls.filter((c) => c.name === "setLineDash" && (c.args[0] as number[]).length > 0).length;
    const alerting = <T extends PanelSpec>(p: T, threshold: number): T => ({ ...p, alert: newAlert(p, threshold) });

    let rec = stubBrowser();
    const { unmount } = render(<ChartView {...base()} />);
    expect(dashes(rec.calls)).toBe(0);
    unmount();
    vi.restoreAllMocks();
    rec = stubBrowser();
    render(<ChartView {...base({ panel: alerting(panelOf(), 2.5) })} />);
    expect(dashes(rec.calls)).toBeGreaterThan(0);
    // The firing side is filled faintly.
    expect(rec.calls.some((c) => c.name === "fill")).toBe(true);
    cleanup();

    const bar = newPanel("bar", "p-b", { x: 0, y: 0, w: 12, h: 8 });
    const { container: bars } = render(<ChartView {...base({ panel: alerting(bar, 2) })} />);
    const lines = bars.querySelectorAll("[data-alert-line]");
    expect(lines).toHaveLength(2);
    // On a scale from 0 to 3 (the larger last value), 2 is two thirds of the way.
    expect(Number(lines[0].getAttribute("x1"))).toBeCloseTo(66.67, 1);
    cleanup();

    const gauge = { ...newPanel("gauge", "p-g", { x: 0, y: 0, w: 12, h: 8 }) } as Extract<PanelSpec, { type: "gauge" }>;
    gauge.options = { ...gauge.options, max: 10 };
    const { container: gauges } = render(<ChartView {...base({ panel: alerting(gauge, 5) })} />);
    expect(gauges.querySelectorAll("[data-alert-tick]")).toHaveLength(2);
    cleanup();
    // Outside its range the gauge draws no tick, and a stat draws nothing for an alert.
    const { container: high } = render(<ChartView {...base({ panel: alerting(gauge, 50) })} />);
    expect(high.querySelectorAll("[data-alert-tick]")).toHaveLength(0);
    cleanup();
    const stat = newPanel("stat", "p-s", { x: 0, y: 0, w: 6, h: 4 });
    const { container: stats } = render(<ChartView {...base({ panel: alerting(stat, 2) })} />);
    expect(stats.querySelectorAll("[data-alert-line], [data-alert-tick]")).toHaveLength(0);
  });

  describe("morph", () => {
    const edited = (over: Partial<ChartViewProps> = {}) => base({ panel: panelOf({ max: 50 }), ...over });

    it("morphs for an option edit when animating", () => {
      stubBrowser();
      const { rerender } = render(<ChartView {...base()} />);
      expect(tweenMock).not.toHaveBeenCalled(); // the first draw is never a morph
      rerender(<ChartView {...edited({ changeId: 1 })} />);
      expect(tweenMock).toHaveBeenCalledWith(380, expect.any(Function));
    });

    it("jumps when not animating", () => {
      stubBrowser();
      const { rerender } = render(<ChartView {...base({ animate: false })} />);
      rerender(<ChartView {...edited({ animate: false, changeId: 1 })} />);
      expect(tweenMock).not.toHaveBeenCalled();
    });

    it("jumps under reduced motion", () => {
      stubBrowser(true);
      const { rerender } = render(<ChartView {...base()} />);
      rerender(<ChartView {...edited({ changeId: 1 })} />);
      expect(tweenMock).not.toHaveBeenCalled();
    });

    it("jumps on a refresh: new data, same edit count", () => {
      stubBrowser();
      const { rerender } = render(<ChartView {...base()} />);
      rerender(<ChartView {...base({ data: dataOf([series("a", [2, 3, 4]), series("b", [4, 3, 2])]) })} />);
      expect(tweenMock).not.toHaveBeenCalled();
    });

    it("morphs for a query edit: new data with a newer editId", () => {
      stubBrowser();
      const { rerender } = render(<ChartView {...base()} />);
      rerender(<ChartView {...base({ changeId: 1, data: dataOf([series("a", [2, 3, 4]), series("b", [4, 3, 2])], { editId: 1 }) })} />);
      expect(tweenMock).toHaveBeenCalledWith(380, expect.any(Function));
    });

    it("jumps on the first refresh after an option edit", () => {
      stubBrowser();
      const { rerender } = render(<ChartView {...base()} />);
      rerender(<ChartView {...edited({ changeId: 1 })} />); // the option edit morphs
      tweenMock.mockClear();
      // The refresh: new points, the data keeps the tag it had (0) because the queries didn't change.
      rerender(<ChartView {...edited({ changeId: 1, data: dataOf([series("a", [2, 3, 4]), series("b", [4, 3, 2])], { editId: 0 }) })} />);
      expect(tweenMock).not.toHaveBeenCalled();
    });

    it("jumps when the series set changed", () => {
      stubBrowser();
      const { rerender } = render(<ChartView {...base()} />);
      rerender(<ChartView {...base({ changeId: 1, data: dataOf([series("z", [1, 2, 3])], { editId: 1 }) })} />);
      expect(tweenMock).not.toHaveBeenCalled();
    });
  });

  describe("crosshair", () => {
    it("arrow keys move it and Esc hides it, keeping focus on the chart", () => {
      stubBrowser();
      render(<ChartView {...base()} />);
      const chart = screen.getByRole("img");
      expect(chart.tabIndex).toBe(0);
      expect(screen.getByRole("status").textContent).toBe("");
      act(() => chart.focus());
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      const tip = screen.getByRole("status");
      expect(tip.textContent).toContain(formatTooltipTime(START + 60));
      expect(tip.textContent).toContain("a");
      fireEvent.keyDown(chart, { key: "ArrowLeft" });
      expect(tip.textContent).toContain(formatTooltipTime(START));
      fireEvent.keyDown(chart, { key: "Escape" });
      expect(screen.getByRole("status").textContent).toBe("");
      expect(document.activeElement).toBe(chart);
    });

    it("bars of a series that is not the longest can be hovered", () => {
      stubBrowser();
      const long: ChartSeries = { ...series("long", []), points: [[START, 1], [START + 60, 1], [START + 120, 1]] };
      const sparse: ChartSeries = { ...series("sparse", []), points: [[START + 90, 4]] };
      render(<ChartView {...base({ panel: panelOf({ style: "bars" }), data: dataOf([long, sparse]), step: 60 })} />);
      const chart = screen.getByRole("img");
      for (let i = 0; i < 2; i++) fireEvent.keyDown(chart, { key: "ArrowRight" });
      const tip = screen.getByRole("status");
      expect(tip.textContent).toContain(formatTooltipTime(START + 90));
      const rows = Array.from(tip.querySelectorAll("li")).map((li) => li.textContent);
      expect(rows[0]).toContain("sparse");
      expect(rows[0]).toContain("4");
    });

    it("lists each series' value, biggest first", () => {
      stubBrowser();
      render(<ChartView {...base({ panel: panelOf({ unit: "short" }) })} />);
      const chart = screen.getByRole("img");
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      fireEvent.keyDown(chart, { key: "ArrowLeft" });
      const rows = Array.from(screen.getByRole("status").querySelectorAll("li")).map((li) => li.textContent);
      expect(rows).toEqual(["b3", "a1"]);
    });

    it("tooltip caps at ten rows and counts the rest", () => {
      stubBrowser();
      const many = Array.from({ length: 40 }, (_, i) => series(`pod-${String(i).padStart(2, "0")}`, [i, i, i]));
      render(<ChartView {...base({ panel: panelOf({ unit: "short" }), data: dataOf(many) })} />);
      const chart = screen.getByRole("img");
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      const tip = screen.getByRole("status");
      const rows = tip.querySelectorAll("li");
      expect(rows).toHaveLength(10);
      // The biggest values lead.
      expect(rows[0].textContent).toBe("pod-3939");
      expect(rows[9].textContent).toBe("pod-3030");
      expect(tip.textContent).toContain("and 30 more");
      // Ten series: no count line.
      cleanup();
      stubBrowser();
      render(<ChartView {...base({ data: dataOf(many.slice(0, 10)) })} />);
      fireEvent.keyDown(screen.getByRole("img"), { key: "ArrowRight" });
      expect(screen.getByRole("status").querySelectorAll("li")).toHaveLength(10);
      expect(screen.getByRole("status").textContent).not.toMatch(/more/);
    });

    it("each tooltip row shows its value", () => {
      stubBrowser();
      const long = "x".repeat(300);
      const data = dataOf([series(long, [1, 2, 3]), series("b", [null, null, null]), series("c", [4, 5, 6])]);
      render(<ChartView {...base({ panel: panelOf({ unit: "short" }), data })} />);
      fireEvent.keyDown(screen.getByRole("img"), { key: "ArrowRight" });
      const rows = Array.from(screen.getByRole("status").querySelectorAll("li"));
      expect(rows).toHaveLength(3);
      // Swatch, name and value: the name may be cut, the value never is.
      for (const row of rows) expect(row.children).toHaveLength(3);
      expect(rows.map((r) => r.children[2].textContent)).toEqual(["5", "2", "–"]);
      // The full name is in the title.
      expect(rows[1].children[1].getAttribute("title")).toBe(long);
      expect(rows[1].children[1].textContent).toBe(long);
    });

    it("stops at the ends and lets Esc through when nothing is shown", () => {
      stubBrowser();
      const outer = vi.fn();
      render(<div onKeyDown={outer}><ChartView {...base()} /></div>);
      const chart = screen.getByRole("img");
      fireEvent.keyDown(chart, { key: "Escape" });
      expect(outer).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) fireEvent.keyDown(chart, { key: "ArrowRight" });
      expect(screen.getByRole("status").textContent).toContain(formatTooltipTime(START + 120));
    });
  });

  describe("legend", () => {
    it("lists the series as buttons; a click shows only that one, Ctrl+click toggles", () => {
      const { calls } = stubBrowser();
      render(<ChartView {...base({ data: dataOf([series("a", [1, 2, 3]), series("b", [3, 2, 1]), series("c", [2, 2, 2])]) })} />);
      const a = screen.getByRole("button", { name: /^a$/ });
      const b = screen.getByRole("button", { name: /^b$/ });
      expect(a.getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(a);
      expect(a.getAttribute("aria-pressed")).toBe("true");
      expect(b.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(b, { ctrlKey: true });
      expect(b.getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("img").getAttribute("aria-label")).toContain("3 series");
      fireEvent.click(a, { ctrlKey: true });
      calls.length = 0;
      fireEvent.click(b, { ctrlKey: true });
      expect(calls.filter((c) => c.name === "stroke" && c.lineWidth === 1.5)).toHaveLength(0);
    });

    it("a long legend folds into N series", async () => {
      stubBrowser();
      const user = userEvent.setup();
      const many = Array.from({ length: 13 }, (_, i) => series(`s${i}`, [i, i + 1]));
      render(<ChartView {...base({ data: dataOf(many) })} />);
      const fold = screen.getByRole("button", { name: "13 series" });
      expect(fold.getAttribute("aria-expanded")).toBe("false");
      // Folded, it controls nothing on the page.
      expect(fold.hasAttribute("aria-controls")).toBe(false);
      expect(screen.queryByRole("button", { name: /^s0$/ })).toBeNull();
      act(() => fold.focus());
      await user.keyboard("{Enter}");
      expect(fold.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(fold);
      expect(document.activeElement).not.toBe(document.body);
      const list = document.getElementById(fold.getAttribute("aria-controls") as string) as HTMLElement;
      expect(list.querySelectorAll("button")).toHaveLength(13);
      expect(screen.getByRole("button", { name: /^s12$/ })).toBeTruthy();
      // Esc in the list folds it again and hands the keyboard back to the button.
      await user.tab();
      expect(document.activeElement?.textContent).toBe("s0");
      expect(document.activeElement).not.toBe(document.body);
      await user.keyboard("{Escape}");
      expect(fold.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(fold);
      expect(document.activeElement).not.toBe(document.body);
      expect(fold.hasAttribute("aria-controls")).toBe(false);
      // Twelve series: no fold.
      cleanup();
      stubBrowser();
      render(<ChartView {...base({ data: dataOf(many.slice(0, 12)) })} />);
      expect(screen.queryByRole("button", { name: /series$/ })).toBeNull();
      expect(screen.getAllByRole("button", { pressed: true })).toHaveLength(12);
    });

    it("a refresh across the fold keeps the keyboard in the legend", () => {
      stubBrowser();
      const of = (n: number) => dataOf(Array.from({ length: n }, (_, i) => series(`s${i}`, [i, i + 1])));
      const { rerender } = render(<ChartView {...base({ data: of(12) })} />);
      // Twelve to thirteen while a series has the keyboard: the "13 series" button takes it.
      act(() => screen.getByRole("button", { name: /^s3$/ }).focus());
      rerender(<ChartView {...base({ data: of(13) })} />);
      const fold = screen.getByRole("button", { name: "13 series" });
      expect(document.activeElement).toBe(fold);
      expect(document.activeElement).not.toBe(document.body);
      // Thirteen to twelve while the button has the keyboard: the first series takes it.
      rerender(<ChartView {...base({ data: of(12) })} />);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^s0$/ }));
      expect(document.activeElement).not.toBe(document.body);
      // The focused series goes away with a refresh: the first series takes it.
      act(() => screen.getByRole("button", { name: /^s11$/ }).focus());
      rerender(<ChartView {...base({ data: of(11) })} />);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^s0$/ }));
      // A refresh while the keyboard is elsewhere leaves it there.
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      act(() => outside.focus());
      rerender(<ChartView {...base({ data: of(13) })} />);
      expect(document.activeElement).toBe(outside);
      outside.remove();
    });

    it("folding clears the highlight, and a series that comes back is not highlighted again", async () => {
      stubBrowser();
      const user = userEvent.setup();
      const of = (n: number) => dataOf(Array.from({ length: n }, (_, i) => series(`s${i}`, [i, i + 1])));
      const last = () => painted[painted.length - 1].highlight;
      const { rerender } = render(<ChartView {...base({ data: of(13) })} />);
      const fold = screen.getByRole("button", { name: "13 series" });
      await user.click(fold);
      // The pointer rests on s5 while the keyboard is on s1; Esc folds the list under both.
      act(() => screen.getByRole("button", { name: /^s1$/ }).focus());
      fireEvent.mouseEnter(screen.getByRole("button", { name: /^s5$/ }));
      expect(last()).toBe("k-s5");
      await user.keyboard("{Escape}");
      expect(fold.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(fold);
      expect(last()).toBeNull();
      // Closing with the button does the same.
      await user.click(fold);
      fireEvent.mouseEnter(screen.getByRole("button", { name: /^s2$/ }));
      expect(last()).toBe("k-s2");
      await user.click(fold);
      expect(last()).toBeNull();
      // A refresh that folds the list under the pointer clears it too.
      rerender(<ChartView {...base({ data: of(12) })} />);
      fireEvent.mouseEnter(screen.getByRole("button", { name: /^s4$/ }));
      expect(last()).toBe("k-s4");
      rerender(<ChartView {...base({ data: of(13) })} />);
      expect(last()).toBeNull();
      // A highlighted series a refresh takes away doesn't light up when it comes back.
      rerender(<ChartView {...base({ data: of(3) })} />);
      fireEvent.mouseEnter(screen.getByRole("button", { name: /^s2$/ }));
      expect(last()).toBe("k-s2");
      rerender(<ChartView {...base({ data: of(2) })} />);
      expect(last()).toBeNull();
      rerender(<ChartView {...base({ data: of(3) })} />);
      expect(last()).toBeNull();
      expect(screen.getByRole("button", { name: /^s2$/ }).className).not.toMatch(/legendLit/);
    });

    it("a legend name is cut with its full name in the title", () => {
      stubBrowser();
      const long = `pod="${"checkout-worker-".repeat(18)}"`;
      render(<ChartView {...base({ data: dataOf([series(long, [1, 2, 3]), series("b", [3, 2, 1])]) })} />);
      const item = screen.getByRole("button", { name: long });
      expect(item.getAttribute("title")).toBe(long);
      expect(item.getAttribute("aria-description")).toBe("Click to show only this series; Ctrl+click to show or hide it.");
      expect(item.querySelector("span:last-child")?.className).toMatch(/legendName/);
    });

    it("hovering a legend item highlights its series", () => {
      stubBrowser();
      render(<ChartView {...base()} />);
      const last = () => painted[painted.length - 1];
      expect(last().highlight).toBeNull();
      const b = screen.getByRole("button", { name: /^b$/ });
      fireEvent.mouseEnter(b);
      expect(last().highlight).toBe("k-b");
      fireEvent.mouseLeave(b);
      expect(last().highlight).toBeNull();
      // Keyboard focus does the same.
      act(() => b.focus());
      expect(last().highlight).toBe("k-b");
      expect(document.activeElement).toBe(b);
      act(() => b.blur());
      expect(last().highlight).toBeNull();
      // A hidden series is never highlighted.
      const a = screen.getByRole("button", { name: /^a$/ });
      fireEvent.click(a);
      fireEvent.mouseEnter(b);
      expect(last().highlight).toBeNull();
    });

    it("highlighting never recolours", () => {
      stubBrowser();
      const many = Array.from({ length: 5 }, (_, i) => series(`s${i}`, [i, i + 1]));
      render(<ChartView {...base({ data: dataOf(many) })} />);
      const colours = () => painted[painted.length - 1].series.map((s) => `${s.key}=${s.color}`);
      const swatches = () => screen.getAllByRole("button", { pressed: true }).map((b) => (b.querySelector("span") as HTMLElement).style.background);
      const before = { frame: colours(), legend: swatches() };
      fireEvent.mouseEnter(screen.getByRole("button", { name: /^s3$/ }));
      expect(painted[painted.length - 1].highlight).toBe("k-s3");
      expect(colours()).toEqual(before.frame);
      expect(swatches()).toEqual(before.legend);
      fireEvent.mouseLeave(screen.getByRole("button", { name: /^s3$/ }));
      expect(colours()).toEqual(before.frame);
    });

    it("is hidden when the options say so", () => {
      stubBrowser();
      render(<ChartView {...base({ panel: panelOf({ legend: "hidden" }) })} />);
      expect(screen.queryByRole("button", { name: /^a$/ })).toBeNull();
    });
  });

  describe("room to draw", () => {
    it("a short plot draws no axis labels or legend", () => {
      // The frame: under 48 px of plot there are no labels to draw.
      const opts = panelOf().options as TimeseriesOptions;
      const data = [series("a", [1, 2, 3]), series("b", [3, 2, 1])];
      const short = buildFrame(data, opts, { width: 400, height: 60, dpr: 1 }, RANGE, new Set());
      expect(short.labels).toBe(false);
      expect(short.plot.h).toBeLessThan(60);
      expect(short.plot.y + short.plot.h).toBeLessThanOrEqual(60);
      const rec = recorder();
      drawTimeSeries(rec.ctx, short, (token) => token);
      expect(rec.calls.filter((c) => c.name === "fillText")).toHaveLength(0);
      expect(rec.calls.filter((c) => c.name === "stroke" && c.lineWidth === 1.5)).toHaveLength(2);
      const tall = buildFrame(data, opts, SIZE, RANGE, new Set());
      expect(tall.labels).toBe(true);
      const full = recorder();
      drawTimeSeries(full.ctx, tall, (token) => token);
      expect(full.calls.filter((c) => c.name === "fillText").length).toBeGreaterThan(0);

      // The panel: a short chart drops the legend and draws no text on its canvas.
      const { calls } = stubBrowser(false, { width: 400, height: 60 });
      render(<ChartView {...base()} />);
      expect(calls.filter((c) => c.name === "stroke" && c.lineWidth === 1.5)).toHaveLength(2);
      expect(calls.filter((c) => c.name === "fillText")).toHaveLength(0);
      expect(screen.queryByRole("list", { name: "Series" })).toBeNull();
      expect(screen.queryByRole("button", { name: /^a$/ })).toBeNull();
      // The text alternative still names every series.
      expect(screen.getByRole("img").getAttribute("aria-label")).toContain("2 series");
    });

    it("a tall chart keeps its legend", () => {
      stubBrowser();
      render(<ChartView {...base()} />);
      expect(screen.getByRole("list", { name: "Series" })).toBeTruthy();
    });

    it("a short panel's tooltip is not cut", () => {
      stubBrowser(false, { width: 400, height: 60 });
      const { container } = render(<ChartView {...base()} />);
      const chart = screen.getByRole("img");
      // The plot layer is what clips; the tip lives outside every clip, on the page itself.
      const tip = screen.getByRole("status");
      expect(container.contains(tip)).toBe(false);
      expect(tip.parentElement).toBe(document.body);
      // Placed against the window: the box's own place on the page is added to placeTip's answer.
      const wrap = chart.parentElement as HTMLElement;
      vi.spyOn(wrap, "getBoundingClientRect").mockReturnValue({ left: 300, top: 200, right: 700, bottom: 260, width: 400, height: 60, x: 300, y: 200, toJSON() {} } as DOMRect);
      vi.stubGlobal("innerWidth", 1280);
      vi.stubGlobal("innerHeight", 800);
      act(() => chart.focus());
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      expect(tip.textContent).toContain(formatTooltipTime(START + 60));
      expect(Number.parseFloat(tip.style.left)).toBeGreaterThanOrEqual(300);
      expect(Number.parseFloat(tip.style.top)).toBeGreaterThanOrEqual(200);
      expect(document.activeElement).toBe(chart);
      fireEvent.keyDown(chart, { key: "Escape" });
      expect(tip.textContent).toBe("");
      expect(document.activeElement).toBe(chart);
    });

    it("a keyboard tooltip goes when its chart loses the keyboard", () => {
      stubBrowser();
      render(<><ChartView {...base()} /><button type="button">Next</button></>);
      const chart = screen.getByRole("img");
      act(() => chart.focus());
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      const tip = screen.getByRole("status");
      expect(tip.textContent).toContain(formatTooltipTime(START + 60));
      const next = screen.getByRole("button", { name: "Next" });
      act(() => next.focus());
      expect(tip.textContent).toBe("");
      expect(document.activeElement).toBe(next);
      expect(document.activeElement).not.toBe(document.body);
    });

    it("a tooltip goes when its chart scrolls out of view", () => {
      stubBrowser();
      vi.stubGlobal("innerWidth", 1280);
      vi.stubGlobal("innerHeight", 800);
      render(<ChartView {...base()} />);
      const chart = screen.getByRole("img");
      const wrap = chart.parentElement as HTMLElement;
      let top = 200;
      vi.spyOn(wrap, "getBoundingClientRect").mockImplementation(() => ({ left: 100, top, right: 700, bottom: top + 240, width: 600, height: 240, x: 100, y: top, toJSON() {} }) as DOMRect);
      act(() => chart.focus());
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      const tip = screen.getByRole("status");
      expect(tip.textContent).toContain(formatTooltipTime(START + 60));
      // Still partly in view: it follows the chart.
      top = -100;
      act(() => { fireEvent.scroll(window); });
      expect(tip.textContent).not.toBe("");
      expect(Number.parseFloat(tip.style.top)).toBeGreaterThanOrEqual(0);
      // Gone above the window: so is the tip.
      top = -400;
      act(() => { fireEvent.scroll(window); });
      expect(tip.textContent).toBe("");
      expect(document.activeElement).toBe(chart);
    });

    it("the tooltip goes with its chart", () => {
      stubBrowser();
      const { unmount } = render(<ChartView {...base()} />);
      expect(screen.getByRole("status")).toBeTruthy();
      unmount();
      expect(screen.queryByRole("status")).toBeNull();
    });
  });
});

describe("tooltip width", () => {
  it("the tooltip can't widen the page", () => {
    const css = readFileSync(resolve(process.cwd(), "src/monitoring/charts/Charts.module.css"), "utf8");
    expect(/\.tip \{[^}]*max-width: min\(420px, calc\(100vw - 16px\)\);/.test(css)).toBe(true);
  });
});
