import { describe, expect, it } from "vitest";
import { formatLabels, legendName } from "./legend";

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
