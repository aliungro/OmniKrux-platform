import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartSeries, PanelData } from "../dashboards/runPanel";
import { newAlert, newPanel, type PanelSpec, type TimeseriesOptions } from "../dashboards/schema";
import ChartView, { type ChartViewProps } from "./index";
import { buildFrame, drawTimeSeries, type CanvasLike } from "./drawTimeSeries";
import { formatTooltipTime } from "./scale";

const tweenMock = vi.hoisted(() => vi.fn((_ms: number, _on: (k: number) => void) => () => {}));
vi.mock("./motion", async (importOriginal) => ({ ...(await importOriginal<typeof import("./motion")>()), tween: tweenMock }));

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
      expect(fills[0]).toMatchObject({ fillStyle: "color(--bad)", globalAlpha: 0.07 });
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

  it("has one y value per pixel column", () => {
    const frame = buildFrame(three, options, SIZE, RANGE, new Set());
    for (const s of frame.series) expect(s.ys.length).toBe(frame.columns);
    expect(frame.columns).toBe(Math.floor(frame.plot.w));
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

function stubBrowser(reduced = false) {
  const ctx = recorder();
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: reduced && q.includes("reduce"), addEventListener() {}, removeEventListener() {},
  }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: SIZE.width, height: SIZE.height } }]); }
    disconnect() {}
    unobserve() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx.ctx as unknown as CanvasRenderingContext2D);
  return ctx;
}

beforeEach(() => tweenMock.mockClear());
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

    it("lists each series' value, biggest first", () => {
      stubBrowser();
      render(<ChartView {...base({ panel: panelOf({ unit: "short" }) })} />);
      const chart = screen.getByRole("img");
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      fireEvent.keyDown(chart, { key: "ArrowLeft" });
      const rows = Array.from(screen.getByRole("status").querySelectorAll("li")).map((li) => li.textContent);
      expect(rows).toEqual(["b3", "a1"]);
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

    it("is hidden when the options say so", () => {
      stubBrowser();
      render(<ChartView {...base({ panel: panelOf({ legend: "hidden" }) })} />);
      expect(screen.queryByRole("button", { name: /^a$/ })).toBeNull();
    });
  });
});
