import { describe, expect, it } from "vitest";
import { newPanel, type PanelSpec, type QuerySpec } from "./schema";
import { isLokiLogQuery, logQueryFirst, logQueryInChart } from "./logQueries";

const q = (ref: string, expr: string, type: "loki" | "prometheus" = "loki", hidden = false): QuerySpec =>
  ({ ref, source: { type, id: null }, expr, legend: "", hidden });
const chart = (...queries: QuerySpec[]): PanelSpec => ({ ...newPanel("timeseries", "p", { x: 0, y: 0, w: 4, h: 4 }), queries });

describe("log queries", () => {
  it("a Loki selector is a log query, a LogQL metric query or a PromQL one is not", () => {
    expect(isLokiLogQuery(q("A", '{job="x"}'))).toBe(true);
    expect(isLokiLogQuery(q("A", '  {job="x"} |= "err"'))).toBe(true);
    expect(isLokiLogQuery(q("A", 'sum(count_over_time({job="x"}[5m]))'))).toBe(false);
    expect(isLokiLogQuery(q("A", '{job="x"}', "prometheus"))).toBe(false);
  });

  it("only a chart panel with a visible log query is a log query in a chart", () => {
    expect(logQueryInChart(chart(q("A", '{job="x"}')))).toBe(true);
    expect(logQueryInChart(chart(q("A", "up", "prometheus"), q("B", '{job="x"}')))).toBe(true);
    expect(logQueryInChart(chart(q("A", '{job="x"}', "loki", true)))).toBe(false);
    expect(logQueryInChart({ ...chart(q("A", '{job="x"}')), type: "logs" } as PanelSpec)).toBe(false);
  });

  it("the first visible log query moves to the front", () => {
    const p = chart(q("A", "up", "prometheus"), q("B", '{a="1"}', "loki", true), q("C", '{job="x"}'));
    expect(logQueryFirst(p).queries.map((x) => x.ref)).toEqual(["C", "A", "B"]);
    const first = chart(q("A", '{job="x"}'));
    expect(logQueryFirst(first)).toBe(first);
  });
});
