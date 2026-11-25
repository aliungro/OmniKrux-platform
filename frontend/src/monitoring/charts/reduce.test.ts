import { describe, expect, it } from "vitest";
import { reduceSeries, tableRows } from "./reduce";
import { panelOf, query, series } from "./panelFixtures";
import type { PanelSpec } from "../dashboards/schema";

const gappy: [number, number | null][] = [[0, 1], [1, null], [2, 3]];

describe("reduceSeries", () => {
  it("ignores gaps", () => {
    expect(reduceSeries(gappy, "last")).toBe(3);
    expect(reduceSeries(gappy, "mean")).toBe(2);
    expect(reduceSeries(gappy, "sum")).toBe(4);
    expect(reduceSeries(gappy, "max")).toBe(3);
    expect(reduceSeries(gappy, "min")).toBe(1);
  });
  it("says nothing when there are no values", () => {
    expect(reduceSeries([], "last")).toBeNull();
    expect(reduceSeries([[0, null]], "mean")).toBeNull();
  });
});

describe("tableRows", () => {
  const table = (queries: ReturnType<typeof query>[], options: Record<string, unknown> = {}) =>
    panelOf("table", options, { queries }) as Extract<PanelSpec, { type: "table" }>;
  const labels = { __name__: "m", namespace: "web", deployment: "api" };

  it("joins queries into columns", () => {
    const out = tableRows(
      [series("a", [1, 5], { labels, queryRef: "A" }), series("b", [9, 7], { labels, queryRef: "B" })],
      table([query("A", "Available"), query("B", "Desired")]),
    );
    expect(out.columns).toEqual(["namespace", "deployment", "Available", "Desired"]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].cells).toEqual(["web", "api", 5, 7]);
  });

  it("names the one value column Value and honours the columns option", () => {
    const out = tableRows([series("a", [2], { labels })], table([query("A")], { columns: ["deployment"] }));
    expect(out.columns).toEqual(["deployment", "Value"]);
  });

  it("puts Project first on a group", () => {
    const out = tableRows([series("a", [2], { labels, projectName: "Shop" })], table([query("A")]));
    expect(out.columns[0]).toBe("Project");
    expect(out.rows[0].cells[0]).toBe("Shop");
  });

  it("keeps rows apart when the columns option hides the labels that differ", () => {
    const a = series("a", [1], { labels: { namespace: "web", deployment: "api" } });
    const b = series("b", [2], { labels: { namespace: "web", deployment: "db" } });
    const out = tableRows([a, b], table([query("A")], { columns: ["namespace"] }));
    expect(out.columns).toEqual(["namespace", "Value"]);
    expect(out.rows.map((r) => r.cells)).toEqual([["web", 1], ["web", 2]]);
  });

  it("gives series that differ only by __name__, or share a label set, a row each", () => {
    const x = series("x", [1], { labels: { __name__: "m1", app: "a" } });
    const y = series("y", [2], { labels: { __name__: "m2", app: "a" } });
    const out = tableRows([x, y], table([query("A")]));
    expect(out.rows.map((r) => r.cells[1])).toEqual([1, 2]);
    expect(new Set(out.rows.map((r) => r.key)).size).toBe(2);
  });

  it("joins queries on the same labels and splits rows when one has more labels", () => {
    const base = { namespace: "web", deployment: "api" };
    const out = tableRows(
      [series("a", [1], { labels: base, queryRef: "A" }), series("b", [2], { labels: { ...base, pod: "p1" }, queryRef: "B" })],
      table([query("A", "Up"), query("B", "Want")]),
    );
    expect(out.columns).toEqual(["namespace", "deployment", "pod", "Up", "Want"]);
    expect(out.rows.map((r) => r.cells)).toEqual([["web", "api", "", 1, null], ["web", "api", "p1", null, 2]]);
  });
});
