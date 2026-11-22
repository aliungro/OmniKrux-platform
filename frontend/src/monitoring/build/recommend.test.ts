import { describe, expect, it } from "vitest";
import type { ChartSeries, PanelData } from "../dashboards/runPanel";
import { newPanel, type PanelSpec } from "../dashboards/schema";
import { catalog, counter, gauge } from "./testCatalogs";
import {
  RULES,
  durationWords,
  recommendFor,
  registerRecommendationRule,
  roughness,
  type RecommendationContext,
} from "./recommend";

const panelWith = (expr: string): PanelSpec => {
  const p = newPanel("timeseries", "p1", { x: 0, y: 0, w: 12, h: 8 });
  return { ...p, queries: [{ ref: "A", source: { type: "prometheus", id: null }, expr, legend: "", hidden: false }] } as PanelSpec;
};
const line = (name: string, ys: (number | null)[]): ChartSeries => ({
  key: name,
  name,
  labels: {},
  queryRef: "A",
  projectName: null,
  points: ys.map((y, i) => [i * 15, y]),
});
const dataOf = (series: ChartSeries[], state: PanelData["state"] = "ready"): PanelData => ({
  state,
  series,
  logs: [],
  problems: [],
  summary: { series: series.length, points: 0, tookMs: 1 },
  editId: 0,
});
const ctx = (panel: PanelSpec, over: Partial<RecommendationContext> = {}): RecommendationContext => ({
  panel,
  data: null,
  catalog: null,
  stepSeconds: 15,
  ...over,
});
const textOf = (r: ReturnType<typeof recommendFor>) =>
  r!.text.map((x) => (typeof x === "string" ? x : x.strong)).join("");
const cat = catalog([counter("http_requests_total", ["route"]), gauge("memory_bytes", [])]);
const alternating = line("a", Array.from({ length: 60 }, (_, i) => (i % 2 ? 10 : 0)));

describe("recommendations", () => {
  it("a raw counter is offered per second and Apply wraps it", () => {
    const panel = panelWith("sum by (route) (http_requests_total)");
    const rec = recommendFor(ctx(panel, { catalog: cat }), new Set())!;
    expect(rec.id).toBe("perSecond");
    expect(rec.key).toBe("perSecond:p1:A");
    expect(textOf(rec)).toBe("http_requests_total is a counter, so its raw value only goes up. Show it per second?");
    expect(rec.text[0]).toEqual({ strong: "http_requests_total" });
    expect(rec.apply(panel).queries[0].expr).toBe("sum by (route) (rate(http_requests_total[$__rate_interval]))");
    expect(panel.queries[0].expr).toBe("sum by (route) (http_requests_total)");
  });

  it("without a catalog a _total name is a counter", () => {
    expect(recommendFor(ctx(panelWith("foo_total")), new Set())?.id).toBe("perSecond");
    expect(recommendFor(ctx(panelWith("foo_bytes")), new Set())).toBeNull();
  });

  it("a gauge is not offered per second", () => {
    expect(recommendFor(ctx(panelWith("memory_bytes"), { catalog: cat }), new Set())).toBeNull();
  });

  it("logs panels and hidden queries are not offered per second", () => {
    const logs = newPanel("logs", "p1", { x: 0, y: 0, w: 12, h: 8 });
    const q = { ref: "A", source: { type: "prometheus", id: null }, expr: "foo_total", legend: "", hidden: false };
    expect(recommendFor(ctx({ ...logs, queries: [q] } as PanelSpec), new Set())).toBeNull();
    const p = panelWith("foo_total");
    p.queries[0].hidden = true;
    expect(recommendFor(ctx(p), new Set())).toBeNull();
  });

  it("a noisy line at 1m is offered 5 minutes", () => {
    const panel = panelWith("rate(x[1m])");
    const rec = recommendFor(ctx(panel, { data: dataOf([alternating]) }), new Set())!;
    expect(rec.id).toBe("widerWindow");
    expect(textOf(rec)).toBe("The line is noisy at this window. 5 minutes is smoother and still shows spikes.");
    expect(rec.apply(panel).queries[0].expr).toBe("rate(x[5m])");
  });

  it("widerWindow needs a known step and usable data", () => {
    const panel = panelWith("rate(x[1m])");
    expect(recommendFor(ctx(panel, { data: dataOf([alternating]), stepSeconds: 0 }), new Set())?.id).not.toBe("widerWindow");
    expect(recommendFor(ctx(panel, { data: dataOf([alternating], "error") }), new Set())).toBeNull();
    expect(recommendFor(ctx(panel, { data: null }), new Set())).toBeNull();
    expect(recommendFor(ctx(panelWith("rate(x[10m])"), { data: dataOf([alternating]) }), new Set())).toBeNull();
    const short = line("s", Array.from({ length: 10 }, (_, i) => (i % 2 ? 10 : 0)));
    expect(recommendFor(ctx(panel, { data: dataOf([short]) }), new Set())).toBeNull();
  });

  it("a smooth line is not offered a wider window", () => {
    const sine = line("s", Array.from({ length: 60 }, (_, i) => 10 + Math.sin(i / 10)));
    expect(recommendFor(ctx(panelWith("rate(x[1m])"), { data: dataOf([sine]) }), new Set())).toBeNull();
  });

  it("several rates are offered stacked area", () => {
    const panel = panelWith("sum by (route) (rate(x[5m]))");
    const smooth = (n: string) => line(n, Array.from({ length: 60 }, (_, i) => 5 + Math.sin(i / 10)));
    const rec = recommendFor(ctx(panel, { data: dataOf([smooth("a"), smooth("b"), smooth("c")]) }), new Set())!;
    expect(rec.id).toBe("stackedArea");
    expect(textOf(rec)).toBe("3 rates read better stacked. Show as stacked area?");
    const next = rec.apply(panel);
    expect(next.type === "timeseries" && next.options.style).toBe("stacked");
  });

  it("negative values are never stacked", () => {
    const panel = panelWith("sum by (route) (rate(x[5m]))");
    const mk = (n: string, v: number) => line(n, Array.from({ length: 60 }, () => v));
    expect(recommendFor(ctx(panel, { data: dataOf([mk("a", 1), mk("b", -1)]) }), new Set())).toBeNull();
    expect(recommendFor(ctx(panel, { data: dataOf([mk("a", 1)]) }), new Set())).toBeNull();
  });

  it("dismissed keys are skipped and the next rule shows", () => {
    const panel = panelWith("rate(x[1m])");
    const data = dataOf([alternating, { ...alternating, key: "b", name: "b" }]);
    const first = recommendFor(ctx(panel, { data }), new Set())!;
    expect(first.id).toBe("widerWindow");
    const second = recommendFor(ctx(panel, { data }), new Set([first.key]))!;
    expect(second.id).toBe("stackedArea");
    expect(recommendFor(ctx(panel, { data }), new Set([first.key, second.key]))).toBeNull();
  });

  it("a registered rule runs after the built-in ones and can be removed", () => {
    const panel = panelWith("memory_bytes");
    const rule = {
      id: "extra",
      evaluate: (c: RecommendationContext) => ({
        id: "extra",
        key: `extra:${c.panel.id}:-`,
        text: ["hi"],
        apply: (p: PanelSpec) => p,
      }),
    };
    const n = RULES.length;
    const off = registerRecommendationRule(rule);
    expect(RULES).toHaveLength(n + 1);
    expect(RULES[RULES.length - 1]).toBe(rule);
    expect(recommendFor(ctx(panel), new Set())?.id).toBe("extra");
    off();
    expect(RULES).toHaveLength(n);
    expect(recommendFor(ctx(panel), new Set())).toBeNull();
  });

  it("roughness of a straight line is zero", () => {
    expect(roughness(Array.from({ length: 30 }, (_, i) => [i, i * 2] as [number, number]))).toBe(0);
    expect(roughness(Array.from({ length: 30 }, (_, i) => [i, 5] as [number, number]))).toBe(0);
    expect(roughness([[0, 1], [1, 2]])).toBe(0);
    expect(roughness(alternating.points)).toBeGreaterThan(0.3);
  });

  it("durationWords says minutes and hours", () => {
    expect(durationWords(60)).toBe("1 minute");
    expect(durationWords(300)).toBe("5 minutes");
    expect(durationWords(3600)).toBe("1 hour");
    expect(durationWords(7200)).toBe("2 hours");
  });
});
