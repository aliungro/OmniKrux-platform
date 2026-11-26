import { describe, expect, it } from "vitest";
import { formatLabels, legendName, seriesNames } from "./legend";

describe("legend", () => {
  it("legend templates", () => {
    expect(legendName("{{route}}", { route: "/a" }, "A")).toBe("/a");
    expect(legendName("", { __name__: "up", job: "x" }, "A")).toBe('{job="x"}');
    expect(legendName("", {}, "sum(up)")).toBe("sum(up)");
  });

  it("fills every placeholder, spaces allowed, and leaves a missing label empty", () => {
    expect(legendName("{{ method }} {{route}} ({{code}})", { method: "GET", route: "/a" }, "A")).toBe("GET /a ()");
    expect(legendName("{{__name__}} on {{job}}", { __name__: "up", job: "x" }, "A")).toBe("up on x");
    expect(legendName("total", { job: "x" }, "A")).toBe("total");
    // A whitespace-only template is no template.
    expect(legendName("  ", { job: "x" }, "A")).toBe('{job="x"}');
  });

  it("formats label sets sorted and without the metric name", () => {
    expect(formatLabels({ c: "d", a: "b", __name__: "up" })).toBe('{a="b", c="d"}');
    expect(formatLabels({ __name__: "up" })).toBe("up");
    expect(formatLabels({})).toBe("{}");
    expect(formatLabels({ a: 'x"y\\z' })).toBe('{a="x\\"y\\\\z"}');
  });
});

describe("seriesNames", () => {
  it("series are named by the labels that differ", () => {
    const sets = [
      { __name__: "cpu", namespace: "demo", pod: "api-1", job: "kubelet" },
      { __name__: "cpu", namespace: "demo", pod: "api-2", job: "kubelet" },
      { __name__: "cpu", namespace: "shop", pod: "web-1", job: "kubelet" },
    ];
    expect(seriesNames(sets)).toEqual(["namespace=demo, pod=api-1", "namespace=demo, pod=api-2", "namespace=shop, pod=web-1"]);
    // __name__ counts only when it differs; a label one series lacks tells it apart.
    expect(seriesNames([{ __name__: "a", x: "1" }, { __name__: "b", x: "1" }])).toEqual(["__name__=a", "__name__=b"]);
    expect(seriesNames([{ x: "1" }, { x: "1", y: "2" }])).toEqual(["", "y=2"]);
  });

  it("a single series keeps its metric name", () => {
    expect(seriesNames([{ __name__: "up", job: "api" }])).toEqual(["up"]);
    expect(seriesNames([{ job: "api" }])).toEqual([""]);
  });
});
