import { describe, expect, it } from "vitest";
import type { FiringOut, OverviewOut, RuleOut, TargetState } from "../api";
import { listRows } from "./listModel";

const NOW = Date.parse("2026-11-23T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const rule = (id: string, name: string, scope: { kind: "project" | "group"; id: string; name: string }, state: TargetState = "ok", more: Partial<RuleOut> = {}): RuleOut => ({
  id, name, scope, source_type: "prometheus", source_id: null, expr: "up", condition: { of: "each", op: "above", threshold: 1, for: "5m", every: "1m" },
  severity: "warning", message: "", contact_points: [], engine: "omnikrux", channel: null, paused: false, origin: "page", panel: null,
  state, firing_since: null, targets: [], removing: false, version: 1, created_at: ago(60), updated_at: ago(60), ...more,
});

const firing = (r: RuleOut, severity: FiringOut["severity"], minutes: number): FiringOut => ({
  rule_id: r.id, rule_name: r.name, target_id: `t-${r.id}`, project_id: r.scope.id, project_name: r.scope.name, severity,
  since: ago(minutes), instances: 1, summary: "", where: "in Prometheus",
});

const overviewOf = (f: FiringOut[]): OverviewOut => ({
  counts: { rules: 0, firing: f.length, pending: 0, cant_check: 0, not_applied: 0 }, firing: f, by_project: {}, by_group: {},
  engine: { enabled: true, running: true, last_tick_at: null, rules: 0, behind: 0, note: "" },
});

const dev = { kind: "project" as const, id: "p1", name: "kind-omnikrux-dev" };
const east = { kind: "project" as const, id: "p2", name: "prod-east" };
const production = { kind: "group" as const, id: "g1", name: "Production" };

describe("listRows", () => {
  it("listRows pins firing on top and groups by project and group", () => {
    const crash = rule("r1", "PodCrashLooping", dev, "firing");
    const errors = rule("r3", "HighErrorRate", east, "firing");
    const rules = [
      rule("r6", "ErrorBudgetBurn", production), errors, rule("r5", "LokiIngestErrors", east), rule("r4", "LatencyHigh", east),
      rule("r2", "NodeNotReady", dev), crash,
    ];
    const rows = listRows(rules, overviewOf([firing(crash, "critical", 12), firing(errors, "warning", 3)]), NOW);
    expect(rows.map((r) => [r.kind, r.label, r.right ?? null])).toEqual([
      ["heading", "Firing", null],
      ["rule", "PodCrashLooping", "12m"],
      ["rule", "HighErrorRate", "3m"],
      ["heading", "kind-omnikrux-dev", null],
      ["rule", "NodeNotReady", "ok"],
      ["rule", "PodCrashLooping", "firing"],
      ["heading", "prod-east", null],
      ["rule", "HighErrorRate", "firing"],
      ["rule", "LatencyHigh", "ok"],
      ["rule", "LokiIngestErrors", "ok"],
      ["heading", "Group · Production", null],
      ["rule", "ErrorBudgetBurn", "ok"],
    ]);
    // Pinned dots by severity; firing under the owner is rose; every key is its own.
    expect(rows[1]).toMatchObject({ ruleId: "r1", tone: "bad", dot: true });
    expect(rows[2]).toMatchObject({ ruleId: "r3", tone: "warn", dot: true });
    expect(rows[5]).toMatchObject({ ruleId: "r1", tone: "bad" });
    expect(rows[5].dot).toBeUndefined();
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("has no Firing heading when nothing fires, and says each state in lower case", () => {
    const states: TargetState[] = ["ok", "pending", "unreachable", "not_applied", "paused", "no_data", "error", "waiting"];
    const rules = states.map((st, i) => rule(`r${i}`, `Rule ${i}`, dev, st));
    const rows = listRows(rules, overviewOf([]), NOW);
    expect(rows[0]).toMatchObject({ kind: "heading", label: "kind-omnikrux-dev" });
    expect(rows.slice(1).map((r) => r.right)).toEqual(["ok", "pending", "can't check", "not applied", "paused", "no data", "error", "loading"]);
    // A query error isn't an alert firing: warn, not rose.
    expect(rows.find((r) => r.state === "error")?.tone).toBe("warn");
  });

  it("pins a group rule once, from the project that fired first, and info in lavender", () => {
    const burn = rule("r1", "ErrorBudgetBurn", production, "firing", { severity: "info" });
    const rows = listRows([burn], overviewOf([firing(burn, "info", 2), { ...firing(burn, "info", 40), project_id: "p9" }]), NOW);
    expect(rows.filter((r) => r.key.startsWith("firing:"))).toEqual([
      { key: "firing:r1", kind: "rule", label: "ErrorBudgetBurn", ruleId: "r1", state: "firing", right: "40m", tone: "focus", dot: true },
    ]);
  });

  it("a paused rule reads paused", () => {
    const rows = listRows([rule("r1", "Quiet", dev, "ok", { paused: true })], undefined, NOW);
    expect(rows[1]).toMatchObject({ right: "paused", tone: "muted" });
  });
});
