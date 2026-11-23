import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emptyDashboard, newAlert, newPanel, validateDashboard, type DashboardSpec } from "../dashboards/schema";
import { RATE_INTERVAL_FLOOR } from "../dashboards/interpolate";
import { isLogQuery, parseDuration, renderMessage, ruleExpr, threeDigits } from "./ruleExpr";

const backendTests = join(dirname(fileURLToPath(import.meta.url)), "../../../../backend/tests/monitoring");
const read = <T>(name: string): T => JSON.parse(readFileSync(join(backendTests, name), "utf8"));

interface ExprCase {
  name: string;
  doc: DashboardSpec;
  panel_id: string;
  expected: string | null;
  problem: string | null;
}
interface MessageCase {
  name: string;
  message: string;
  labels: Record<string, string>;
  value: number | null;
  expected: string;
}

const exprCases = read<ExprCase[]>("alert_expr_cases.json");
const messageCases = read<MessageCase[]>("alert_message_cases.json");

describe.each(exprCases)("shared expr case $name", (c) => {
  const panel = c.doc.panels.find((p) => p.id === c.panel_id)!;
  it("gives the server's text or words", () => {
    const out = ruleExpr(c.doc, panel);
    if (c.problem === null) expect(out).toEqual({ ok: true, expr: c.expected });
    else expect(out).toEqual({ ok: false, problem: c.problem });
  });
  it("agrees with the document validator", () => {
    const v = validateDashboard(c.doc, "project");
    if (c.problem === null) expect(v.ok).toBe(true);
    else expect(v).toEqual({ ok: false, problems: [{ path: "panels[0].alert.query", message: c.problem }] });
  });
});

describe.each(messageCases)("shared message case $name", (c) => {
  it("renders as the server does", () => {
    expect(renderMessage(c.message, c.labels, c.value)).toBe(c.expected);
  });
});

describe("rule expr", () => {
  const panelWith = (expr: string, every: "30s" | "1m" | "5m" = "1m") => {
    const p = newPanel("timeseries", "p-1", { x: 0, y: 0, w: 12, h: 8 });
    p.queries[0].expr = expr;
    p.alert = { ...newAlert(p, 1), every };
    return { spec: { ...emptyDashboard("D"), panels: [p] }, panel: p };
  };

  it("the message case file has the triple brace row", () => {
    expect(messageCases.some((c) => c.message === "{{{value}}}")).toBe(true);
    expect(messageCases.length).toBe(14);
  });

  it("$__rate_interval follows the chart's floor", () => {
    expect(RATE_INTERVAL_FLOOR).toBe(240);
    const rate = (every: "30s" | "1m" | "5m") => {
      const { spec, panel } = panelWith("rate(x[$__rate_interval])", every);
      return ruleExpr(spec, panel);
    };
    expect(rate("30s")).toEqual({ ok: true, expr: "rate(x[4m])" });
    expect(rate("5m")).toEqual({ ok: true, expr: "rate(x[20m])" });
  });

  it("refuses a panel without an alert and a query that isn't there", () => {
    const { spec, panel } = panelWith("up");
    expect(ruleExpr(spec, { ...panel, alert: null })).toEqual({ ok: false, problem: "This panel has no alert." });
    expect(ruleExpr(spec, { ...panel, alert: { ...panel.alert!, query: "Z" } })).toEqual({
      ok: false,
      problem: "Use the ref of one of this panel's queries, like A.",
    });
  });

  it("reads durations and log queries like the server", () => {
    expect(parseDuration("0s")).toBe(0);
    expect(parseDuration("24h")).toBe(86400);
    for (const bad of ["", "5", "05m", "1d", "-1s", "5m "]) expect(parseDuration(bad)).toBeNull();
    expect(isLogQuery('  {app="api"} |= "x"')).toBe(true);
    expect(isLogQuery("sum(rate(x[5m]))")).toBe(false);
  });

  it("writes three digits in full, ties to the even digit", () => {
    expect(threeDigits(0.125)).toBe("0.125");
    expect(threeDigits(1.125)).toBe("1.12");
    expect(threeDigits(1.375)).toBe("1.38");
    expect(threeDigits(-0)).toBe("-0");
    expect(threeDigits(12345678)).toBe("12300000");
  });

  it("a value that isn't a number is a dash", () => {
    expect(renderMessage("{{value}}", {}, Number.NaN)).toBe("–");
    expect(renderMessage("{{value}}", {}, Infinity)).toBe("–");
  });
});
