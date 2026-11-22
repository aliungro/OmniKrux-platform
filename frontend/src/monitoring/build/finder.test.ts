import { describe, expect, it } from "vitest";
import { FINDER_MAX_RESULTS, buildFinderIndex, findPanels } from "./finder";
import { CAT, bigCatalog, catalog, counter, gauge } from "./testCatalogs";

describe("findPanels", () => {
  it("errors by route finds the 5xx rate by route first", () => {
    const [top] = findPanels(buildFinderIndex(CAT), "errors by route");
    expect(top.title).toBe("Http requests errors per second by route");
    expect(top.expr).toBe('sum by (route) (rate(http_requests_total{status=~"5.."}[$__rate_interval]))');
  });

  it("logs words find streams", () => {
    const r = findPanels(buildFinderIndex(CAT), "api logs");
    expect(r[0]).toMatchObject({ title: "Logs from app=api", panelType: "logs", expr: '{app="api"}' });
  });

  it("p99 latency picks the histogram with that quantile", () => {
    const [top] = findPanels(buildFinderIndex(CAT), "p99 latency");
    expect(top.title).toBe("p99 Http request duration");
    expect(top.expr.startsWith("histogram_quantile(0.99,")).toBe(true);
  });

  it("synonyms and plurals match", () => {
    expect(findPanels(buildFinderIndex(CAT), "crashes")[0].title).toBe("Pod restarts per second");
  });

  it("words that match nothing find nothing", () => {
    expect(findPanels(buildFinderIndex(CAT), "banana")).toEqual([]);
    expect(findPanels(buildFinderIndex(CAT), "show me the")).toEqual([]);
  });

  it("a split the metric lacks ranks it lower", () => {
    const r = findPanels(buildFinderIndex(CAT), "errors by route");
    const lines = r.findIndex((c) => c.title === "Error lines from level=error");
    const lastHttp = r.map((c) => c.expr.includes("http_requests_total")).lastIndexOf(true);
    expect(lines).toBeGreaterThan(lastHttp);
  });

  it("keeps the best candidate per query and at most the limit", () => {
    const r = findPanels(buildFinderIndex(CAT), "errors by route");
    expect(new Set(r.map((c) => c.expr)).size).toBe(r.length);
    expect(r.length).toBeLessThanOrEqual(FINDER_MAX_RESULTS);
    expect(findPanels(buildFinderIndex(CAT), "errors by route", 1)).toHaveLength(1);
  });

  it("never offers a name it can't write", () => {
    const odd = catalog([counter("http_requests_total", ["route"]), counter("bad-name_total", ["route"])]);
    const r = findPanels(buildFinderIndex(odd), "requests");
    expect(r.map((c) => c.expr)).toEqual(["sum(rate(http_requests_total[$__rate_interval]))"]);
  });

  it("writes catalog values with escaping", () => {
    const c = catalog([], [{ name: "app", values: ['a"b'], sourceId: "loki", projectIds: [] }]);
    const [top] = findPanels(buildFinderIndex(c), "logs app");
    expect(top.expr).toBe('{app="a\\"b"}');
  });

  it("reads gauges as plain values", () => {
    const c = catalog([gauge("queue_depth", ["name"])]);
    expect(findPanels(buildFinderIndex(c), "queue")[0]).toMatchObject({ title: "Queue depth", expr: "queue_depth" });
  });

  it("matching 5000 metrics stays under 50 ms", () => {
    const index = buildFinderIndex(bigCatalog(5000));
    const texts = ["e", "er", "err", "erro", "errors", "errors by", "errors by route"];
    for (const text of texts) findPanels(index, text); // warm up
    const t0 = performance.now();
    for (const text of texts) findPanels(index, text);
    expect((performance.now() - t0) / texts.length).toBeLessThan(50);
  });
});
