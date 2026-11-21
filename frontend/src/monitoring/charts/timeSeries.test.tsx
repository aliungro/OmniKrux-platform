import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartSeries, PanelData } from "../dashboards/runPanel";
import { newPanel, type PanelSpec, type TimeseriesOptions } from "../dashboards/schema";
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
    for (const state of ["unreachable", "error"] as const) {
      const { calls } = stubBrowser();
      const { unmount } = render(<ChartView {...base({ data: dataOf([series("a", [1, 2, 3])], { state }) })} />);
      expect(calls.filter((c) => c.name === "stroke" && c.lineWidth === 1.5)).toHaveLength(0);
      expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/0 series/);
      unmount();
      vi.restoreAllMocks();
    }
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
