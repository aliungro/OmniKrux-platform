import { describe, expect, it } from "vitest";
import { catalogOf, metric, projectOf, source } from "./fixtures";
import { ownerCatalog } from "./merge";
import { browseMetrics, isCounter } from "./metrics";

const catalogWith = (...metrics: ReturnType<typeof metric>[]) =>
  ownerCatalog([{ project: projectOf("a"), catalog: catalogOf("a", source("s1", { metrics })), error: null }], "project");

describe("browseMetrics", () => {
  it("families collapse into one histogram entry", () => {
    const fam = "http_request_duration_seconds";
    const list = browseMetrics(catalogWith(
      metric(`${fam}_bucket`, { type: "histogram", family: fam, labels: ["le", "path"], series: 20 }),
      metric(`${fam}_sum`, { family: fam, labels: ["path"], series: 4 }),
      metric(`${fam}_count`, { family: fam, labels: ["path", "code"], series: 4, help: "Latency." }),
      metric("up", { type: "gauge" }),
    ));
    expect(list.map((m) => m.name)).toEqual([fam, "up"]);
    expect(list[0]).toMatchObject({ kind: "histogram", typeLabel: "histogram", labels: ["code", "path"], series: 4, help: "Latency." });
  });

  it("a summary lists once", () => {
    const list = browseMetrics(catalogWith(
      metric("rpc_seconds", { type: "summary", family: "rpc_seconds", labels: ["quantile", "svc"], series: 6 }),
      metric("rpc_seconds_sum", { family: "rpc_seconds", labels: ["svc"], series: 2 }),
      metric("rpc_seconds_count", { family: "rpc_seconds", labels: ["svc"], series: 2 }),
      metric("native_seconds", { type: "histogram", family: "native_seconds", labels: ["le", "svc"], series: 5 }),
    ));
    expect(list.map((m) => m.name)).toEqual(["native_seconds", "rpc_seconds"]);
    expect(list[1]).toMatchObject({ kind: "summary", labels: ["svc"], series: 2 });
    expect(list[0]).toMatchObject({ kind: "histogram", labels: ["svc"], series: 5 });
  });

  it("kinds follow the type, or the _total suffix without one", () => {
    const list = browseMetrics(catalogWith(
      metric("a_total"), metric("b_total", { type: "gauge" }), metric("c", { type: "counter" }), metric("d"),
      metric("e_info", { type: "info" }), metric("f", { series: null }),
    ));
    expect(Object.fromEntries(list.map((m) => [m.name, [m.kind, m.typeLabel]]))).toEqual({
      a_total: ["counter", "counter"], b_total: ["gauge", "gauge"], c: ["counter", "counter"],
      d: ["unknown", "—"], e_info: ["unknown", "—"], f: ["unknown", "—"],
    });
    expect(list.find((m) => m.name === "f")?.series).toBe(0);
  });

  it("browseMetrics skips names that can't be written", () => {
    const list = browseMetrics(catalogWith(
      metric("good_name:rate", { labels: ["ok", "bad-label", "9x"] }), metric("bad name"), metric("9lives"), metric("bad.dot"),
    ));
    expect(list.map((m) => m.name)).toEqual(["good_name:rate"]);
    expect(list[0].labels).toEqual(["ok"]);
  });
});

describe("isCounter", () => {
  it("counters are known by type or _total", () => {
    const catalog = catalogWith(metric("a", { type: "counter" }), metric("b_total", { type: "gauge" }), metric("c_total"), metric("d"));
    expect(isCounter(catalog, "a")).toBe(true);
    expect(isCounter(catalog, "b_total")).toBe(false);
    expect(isCounter(catalog, "c_total")).toBe(true);
    expect(isCounter(catalog, "d")).toBe(false);
    expect(isCounter(catalog, "missing_total")).toBe(true);
  });
});
