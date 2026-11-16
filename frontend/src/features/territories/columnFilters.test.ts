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

it("labels every filter variant", () => {
 const c=col("Node");
 expect(chipLabel({key:"x",op:"contains",text:"api"},c)).toBe('Node contains "api"');
 expect(chipLabel({key:"x",op:"oneOf",values:[""]},c)).toBe("Node: (none)");
 expect(chipLabel({key:"x",op:"oneOf",values:["a","b"]},c)).toBe("Node: a, b");
 expect(chipLabel({key:"x",op:"within",seconds:3600},c)).toBe("Node: within 1 h");
 expect(chipLabel({key:"x",op:"olderThan",seconds:300},c)).toBe("Node: older than 5 min");
 expect(chipLabel({key:"x",op:"between",min:1,max:3},c)).toBe("Node: 1–3");
 expect(chipLabel({key:"x",op:"between",min:1,max:null},c)).toBe("Node: ≥ 1");
 expect(chipLabel({key:"x",op:"between",min:null,max:3},c)).toBe("Node: ≤ 3");
});
it("missing values fail time and number filters and both numeric bounds are inclusive", () => {
 const t=col("at","time"), n=col("n","number");
 expect(compileColumnFilters([{key:"at",op:"within",seconds:300}],[t],now)(row("x"))).toBe(false);
 expect(compileColumnFilters([{key:"at",op:"olderThan",seconds:300}],[t],now)(row("x"))).toBe(false);
 const p=compileColumnFilters([{key:"n",op:"between",min:1,max:3}],[n],now);
 expect([p(row("x")),p(row("x",{n:1})),p(row("x",{n:3})),p(row("x",{n:4}))]).toEqual([false,true,true,false]);
});
it("rejects malformed persisted filters and accepts UI pick values", () => {
 expect(validColumnFilter({key:"x",op:"oneOf",values:Array(201).fill("a")})).toBeNull();
 expect(validColumnFilter({key:"x",op:"within",seconds:-1})).toBeNull();
 expect(validColumnFilter({key:"x",op:"between",min:null,max:null})).toBeNull();
 expect(validColumnFilter({key:"x",op:"oneOf",values:["x".repeat(501)]})).not.toBeNull();
});
