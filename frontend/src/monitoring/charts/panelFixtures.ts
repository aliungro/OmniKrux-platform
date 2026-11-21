// Shared fixtures for the panel tests (never imported by the app).
import { vi } from "vitest";
import type { ChartLogLine, ChartSeries, PanelData } from "../dashboards/runPanel";
import { newPanel, type PanelSpec, type PanelType } from "../dashboards/schema";

export const START = 1_000_000;
export const RANGE = { start: START, end: START + 120 };

export const series = (name: string, values: (number | null)[], more: Partial<ChartSeries> = {}): ChartSeries => ({
  key: `k-${name}`, name, labels: { job: name }, queryRef: "A", projectName: null,
  points: values.map((v, i) => [START + i * 60, v] as [number, number | null]), ...more,
});

export function panelOf(type: PanelType, options: Record<string, unknown> = {}, more: Partial<PanelSpec> = {}): PanelSpec {
  const p = newPanel(type, "p-1", { x: 0, y: 0, w: 12, h: 8 });
  return { ...p, title: "Panel", ...more, options: { ...p.options, ...options } } as PanelSpec;
}

export const dataOf = (s: ChartSeries[], more: Partial<PanelData> = {}): PanelData => ({
  state: "ready", series: s, logs: [], problems: [], summary: { series: s.length, points: 0, tookMs: 1 }, editId: 0, ...more,
});

export const logLine = (n: number, line: string, more: Partial<ChartLogLine> = {}): ChartLogLine => ({
  key: `l${n}`, ts: `${1_700_000_000_000 + n * 1000}000000`, line, labels: { app: "api" }, projectName: null, ...more,
});

export const query = (ref: string, legend = "") => ({
  ref, source: { type: "prometheus" as const, id: null }, expr: "x", legend, hidden: false,
});

/** Undone by `vi.unstubAllGlobals()`. */
export function stubMotion(reduced = false) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: reduced && q.includes("reduce"), addEventListener() {}, removeEventListener() {},
  }));
}

/** jsdom lays nothing out: give scroll boxes a size so the virtualizer draws rows. Undone by `vi.restoreAllMocks()`. */
export function fakeBox(height = 300, width = 800, rowHeight = 22) {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  // A virtualized row (it has a data-index) is one line tall, whatever the box is.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-index") ? rowHeight : height;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = this.hasAttribute("data-index") ? rowHeight : height;
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: h, width, height: h, toJSON: () => ({}) } as DOMRect;
  });
}
