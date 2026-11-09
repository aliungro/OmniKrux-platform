import { describe, expect, it } from "vitest";
import type { ColumnSpec, ResourceRow } from "../../api/types";
import { chipLabel, compileColumnFilters, filterUiFor, compareBy, validColumnFilter } from "./columnFilters";
const col = (key: string, type: ColumnSpec["type"] = "text"): ColumnSpec => ({ key, label: key, type, width: "m" });
const row = (name: string, columns: Record<string, unknown> = {}): ResourceRow => ({ uid: name, name, cluster_id: "c", kind: "Pod", namespace: null, created_at: null, labels: {}, columns });
const now = new Date("2026-11-09T12:00:00Z");
describe("column filters", () => {
  it("filter ui follows the column type", () => { expect(filterUiFor(col("node"))).toBe("pick"); expect(filterUiFor(col("pods", "pods"))).toBeNull(); });
  it("contains is case-insensitive", () => { expect(compileColumnFilters([{ key: "name", op: "contains", text: "WEB" }], [col("name")], now)(row("web-1"))).toBe(true); });
  it("one of matches listed values and (none)", () => { const p = compileColumnFilters([{ key: "node", op: "oneOf", values: ["", "a"] }], [col("node")], now); expect(p(row("x"))).toBe(true); expect(p(row("x", { node: "b" }))).toBe(false); });
  it("within and older than use the row's time", () => { const c = col("last_seen", "time"); const r = row("x", { last_seen: "2026-11-09T11:30:00Z" }); expect(compileColumnFilters([{ key: c.key, op: "within", seconds: 3600 }], [c], now)(r)).toBe(true); expect(compileColumnFilters([{ key: c.key, op: "olderThan", seconds: 3600 }], [c], now)(r)).toBe(false); });
  it("between is inclusive with optional bounds", () => { const c = col("restarts", "number"); expect(compileColumnFilters([{ key: c.key, op: "between", min: 2, max: null }], [c], now)(row("x", { restarts: 2 }))).toBe(true); });
  it("a row without a value fails value filters", () => { expect(compileColumnFilters([{ key: "x", op: "contains", text: "" }], [col("x")], now)(row("x"))).toBe(false); });
  it("a filter on a missing column is ignored", () => { expect(compileColumnFilters([{ key: "x", op: "contains", text: "a" }], [], now)(row("x"))).toBe(true); });
  it("chip labels read as written", () => { expect(chipLabel({ key: "node", op: "oneOf", values: ["a", "b", "c"] }, col("node"))).toBe("node: a +2"); });
  it("sort puts missing values last and breaks ties by name", () => { const c = col("n", "number"); expect([row("z"), row("b", {n: 1}), row("a", {n: 1})].sort(compareBy(c, "desc")).map(x => x.name)).toEqual(["a", "b", "z"]); });
  it("invalid stored filters are rejected", () => { expect(validColumnFilter({ key: "x", op: "contains", text: "x".repeat(501) })).toBeNull(); });
});

it("column filters over 10,000 rows run in one pass", () => {
  const predicate = compileColumnFilters([{key:"node",op:"oneOf",values:["node-1"]}], [col("node")], now);
  const rows = Array.from({length:10_000}, (_, i) => row(String(i), {node:`node-${i % 2}`}));
  const start = performance.now(); expect(rows.filter(predicate)).toHaveLength(5000); expect(performance.now() - start).toBeLessThan(1000);
});
