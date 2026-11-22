import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartLogLine, ChartSeries, PanelData } from "../dashboards/runPanel";
import { newPanel, type PanelSpec, type TimeseriesOptions } from "../dashboards/schema";
import ChartView, { type ChartViewProps } from "./index";
import { buildFrame, drawTimeSeries, type CanvasLike } from "./drawTimeSeries";
import { fakeBox } from "./panelFixtures";

// The plot is 900 px over 3600 s, with a sample every 60 s: 4 s per pixel, 15 px per step.
const START = 1_800_000;
const SPAN = 3600;
const STEP = 60;
const RANGE = { start: START, end: START + SPAN };
const PLOT_W = 900;
const SIZE = { width: 960, height: 240, dpr: 1 };

const series = (name: string): ChartSeries => ({
  key: `k-${name}`, name, labels: { job: name }, queryRef: "A", projectName: null,
  points: Array.from({ length: SPAN / STEP + 1 }, (_, i) => [START + i * STEP, i % 7] as [number, number | null]),
});
const panelOf = (): PanelSpec => {
  const p = newPanel("timeseries", "p-1", { x: 0, y: 0, w: 12, h: 8 });
  return { ...p, title: "Errors" } as PanelSpec;
};
const dataOf = (s: ChartSeries[]): PanelData => ({
  state: "ready", series: s, logs: [], problems: [], summary: { series: s.length, points: 0, tookMs: 1 }, editId: 0,
});

/** Records each call with the fill colour it was made with. */
function recorder() {
  const calls: { name: string; args: unknown[]; fillStyle: unknown }[] = [];
  const ctx = new Proxy({ lineWidth: 1, fillStyle: "" } as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => { calls.push({ name: prop, args, fillStyle: target.fillStyle }); };
    },
    set(target, prop: string, value) { target[prop] = value; return true; },
  });
  return { ctx: ctx as unknown as CanvasLike, calls };
}
const ticks = (calls: ReturnType<typeof recorder>["calls"]) =>
  calls.filter((c) => c.name === "fillRect" && c.args[2] === 2 && c.args[3] === 6);

function stubBrowser() {
  const rec = recorder();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: SIZE.width, height: SIZE.height } }]); }
    disconnect() {}
    unobserve() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(rec.ctx as unknown as CanvasRenderingContext2D);
  // The brush layer covers exactly the plot area: 900 px wide.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => (
    { x: 0, y: 0, top: 0, left: 0, right: PLOT_W, bottom: 200, width: PLOT_W, height: 200, toJSON: () => ({}) } as DOMRect
  ));
  return rec;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const base = (over: Partial<ChartViewProps> = {}): ChartViewProps => ({
  panel: panelOf(), data: dataOf([series("a")]), range: RANGE, animate: false, changeId: 0, ...over,
});
const brush = () => document.querySelector<HTMLElement>("[data-chart-brush]");
const band = () => document.querySelector<HTMLElement>("[data-chart-band]");
const drag = (from: number, to: number) => {
  const layer = brush()!;
  fireEvent.pointerDown(layer, { clientX: from, clientY: 50, pointerId: 1, button: 0 });
  fireEvent.pointerMove(layer, { clientX: (from + to) / 2, clientY: 50, pointerId: 1 });
  fireEvent.pointerMove(layer, { clientX: to, clientY: 50, pointerId: 1 });
  return layer;
};

describe("selecting a window on the time series", () => {
  beforeEach(() => stubBrowser());

  it("dragging selects a window snapped to the step", () => {
    const onSelect = vi.fn();
    render(<ChartView {...base({ onSelect })} />);
    const layer = drag(100, 460);
    // While dragging, the band follows the pointer.
    expect(band()).toBeTruthy();
    fireEvent.pointerUp(layer, { clientX: 460, clientY: 50, pointerId: 1 });
    // 100 px = 400 s → 420 s; 460 px = 1840 s → 1860 s.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toEqual({ start: START + 420, end: START + 1860 });
  });

  it("dragging leftwards selects the same window", () => {
    const onSelect = vi.fn();
    render(<ChartView {...base({ onSelect })} />);
    const layer = drag(460, 100);
    fireEvent.pointerUp(layer, { clientX: 100, clientY: 50, pointerId: 1 });
    expect(onSelect.mock.calls[0][0]).toEqual({ start: START + 420, end: START + 1860 });
  });

  it("a click is not a selection", () => {
    const onSelect = vi.fn();
    render(<ChartView {...base({ onSelect })} />);
    const layer = drag(300, 303);
    fireEvent.pointerUp(layer, { clientX: 303, clientY: 50, pointerId: 1 });
    expect(onSelect).not.toHaveBeenCalled();
    expect(band()).toBeNull();
  });

  it("Esc during a drag cancels it", () => {
    const onSelect = vi.fn();
    render(<ChartView {...base({ onSelect })} />);
    const layer = drag(100, 460);
    fireEvent.keyDown(screen.getByRole("img"), { key: "Escape" });
    expect(band()).toBeNull();
    fireEvent.pointerUp(layer, { clientX: 460, clientY: 50, pointerId: 1 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("the selection draws as a band over the full range", () => {
    render(<ChartView {...base({ onSelect: vi.fn(), selection: { start: START + 900, end: START + 1800 } })} />);
    const b = band()!;
    expect(b).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Window");
  });

  it("Shift+Right extends from the crosshair and selects after 300 ms", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    render(<ChartView {...base({ onSelect })} />);
    const chart = screen.getByRole("img");
    expect(chart.getAttribute("aria-keyshortcuts")).toContain("Shift+ArrowRight");
    act(() => chart.focus());
    fireEvent.keyDown(chart, { key: "ArrowRight" }); // the crosshair on the second sample
    fireEvent.keyDown(chart, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(chart, { key: "ArrowRight", shiftKey: true });
    expect(band()).toBeTruthy();
    act(() => { vi.advanceTimersByTime(299); });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(chart, { key: "ArrowRight", shiftKey: true });
    act(() => { vi.advanceTimersByTime(299); });
    expect(onSelect).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toEqual({ start: START + STEP, end: START + 4 * STEP });
    expect(onSelect.mock.calls[0][1]).toBe("keyboard");
  });

  it("Esc clears the selection", () => {
    const onSelect = vi.fn();
    const outer = vi.fn();
    render(<div onKeyDown={outer}><ChartView {...base({ onSelect, selection: { start: START + 60, end: START + 600 } })} /></div>);
    const chart = screen.getByRole("img");
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(onSelect).toHaveBeenCalledWith(null, "keyboard");
    expect(outer).not.toHaveBeenCalled();
  });

  it("Esc without a selection keeps the crosshair's behaviour", () => {
    const onSelect = vi.fn();
    const outer = vi.fn();
    render(<div onKeyDown={outer}><ChartView {...base({ onSelect })} /></div>);
    const chart = screen.getByRole("img");
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("dashboards pass no selection and nothing changes", () => {
    render(<ChartView {...base()} />);
    // No pointer layer is bound, and a drag over the plot draws nothing.
    expect(brush()).toBeNull();
    const chart = screen.getByRole("img");
    fireEvent.pointerDown(chart, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(chart, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(chart, { clientX: 400, pointerId: 1 });
    expect(band()).toBeNull();
    expect(chart.getAttribute("aria-keyshortcuts")).toBe("ArrowLeft ArrowRight Escape");
    expect(chart.getAttribute("aria-label")).toBe("Errors: 1 series. Latest: a 4.");
  });
});

describe("marks", () => {
  const options = (panelOf() as Extract<PanelSpec, { type: "timeseries" }>).options as TimeseriesOptions;

  it("marks draw one tick per column per tone", () => {
    const frame = buildFrame([series("a")], options, SIZE, RANGE, new Set());
    const { ctx, calls } = recorder();
    drawTimeSeries(ctx, frame, (t) => t, [
      // Three errors a second apart share a pixel column: one tick.
      { t: START + 600, tone: "error" }, { t: START + 601, tone: "error" }, { t: START + 602, tone: "error" },
      // A warning in the same column is its own tick.
      { t: START + 600, tone: "warn" },
      { t: START + 2400, tone: "info" },
      // Outside the range: no tick.
      { t: START - 60, tone: "error" }, { t: START + SPAN + 60, tone: "info" },
    ]);
    const drawn = ticks(calls);
    expect(drawn.map((c) => c.fillStyle).sort()).toEqual(["--bad", "--kind", "--warn"]);
    // Along the bottom of the plot.
    for (const c of drawn) expect(c.args[1]).toBe(frame.plot.y + frame.plot.h - 6);
  });

  it("the chart draws the marks it is given", () => {
    const { calls } = stubBrowser();
    const { rerender } = render(<ChartView {...base({ onSelect: vi.fn(), marks: [{ t: START + 600, tone: "error" }] })} />);
    expect(ticks(calls)).toHaveLength(1);
    calls.length = 0;
    rerender(<ChartView {...base({ onSelect: vi.fn(), marks: [{ t: START + 600, tone: "error" }, { t: START + 3000, tone: "info" }] })} />);
    expect(ticks(calls)).toHaveLength(2);
  });
});

describe("the level column", () => {
  const logsPanel = () => {
    const p = newPanel("logs", "p-2", { x: 0, y: 0, w: 12, h: 8 });
    return { ...p, title: "Log lines" } as PanelSpec;
  };
  const logLine = (n: number, line: string): ChartLogLine => ({
    key: `l${n}`, ts: `${1_700_000_000_000 + n * 1000}000000`, line, labels: {}, projectName: null,
  });

  it("shows each line's tone when given one", () => {
    fakeBox();
    const logs = [logLine(1, "boom ERROR"), logLine(2, "fine")];
    render(<ChartView panel={logsPanel()} data={{ ...dataOf([]), logs }} range={RANGE} animate={false} changeId={0}
      lineTone={(l) => (l.line.includes("ERROR") ? "error" : "info")} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((i) => i.querySelector("[data-tone]")?.getAttribute("data-tone"))).toEqual(["info", "error"]);
    expect(items[1].textContent).toContain("error");
  });

  it("dashboards show no level column", () => {
    fakeBox();
    render(<ChartView panel={logsPanel()} data={{ ...dataOf([]), logs: [logLine(1, "boom ERROR")] }} range={RANGE} animate={false} changeId={0} />);
    expect(document.querySelector("[data-tone]")).toBeNull();
  });
});
