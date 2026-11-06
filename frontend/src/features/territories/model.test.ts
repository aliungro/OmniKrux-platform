// frontend/src/features/territories/model.test.ts
import { describe, it, expect } from "vitest";
import { buildTerritories, flatten, formatAge, matchesFilter } from "./model";
import { applyMessage, emptyWatchState } from "../../api/watchState";
const now = new Date("2026-11-06T16:00:00");
const r = (uid: string, status: string, cls: string, extra = {}) => ({ uid, cluster_id: "c1", kind: "Pod", namespace: "payments", name: uid, created_at: "", columns: { status, status_class: cls, node: "n1", ...extra } });
const cl = { id: "c1", name: "aks-prod-weu", context_name: "x", server: "https://x", provider: "aks", region: null, environment: "production", state: "unknown", message: null } as const;
const state = () => applyMessage(emptyWatchState(), { type: "snapshot", cluster_id: "c1", part: 0, last: true,
  rows: [r("ok-1", "Running", "ok"), r("crash", "CrashLoopBackOff", "bad", { last_restart_at: "2026-11-06T14:04:14" }), r("wait", "Pending", "warn")] });

describe("territories model", () => {
  it("sorts failing first and counts ignore filters", () => {
    const [t] = buildTerritories([cl], state(), { status: "failing", text: "" }, now);
    expect(t.rows.map(x => x.uid)).toEqual(["crash"]);
    expect([t.total, t.failing, t.pending]).toEqual([3, 1, 1]);
  });
  it("text filter matches name, namespace, node", () => {
    expect(matchesFilter(r("a", "Running", "ok"), { status: "all", text: "PAYM" }, now)).toBe(true);
    expect(matchesFilter(r("a", "Running", "ok"), { status: "all", text: "zzz" }, now)).toBe(false);
  });
  it("restartedToday uses local day", () => {
    const [t] = buildTerritories([cl], state(), { status: "restartedToday", text: "" }, now);
    expect(t.rows.map(x => x.uid)).toEqual(["crash"]);
  });
  it("flatten emits a band then rows", () => {
    const flat = flatten(buildTerritories([cl], state(), { status: "all", text: "" }, now));
    expect(flat.map(x => x.type)).toEqual(["band", "row", "row", "row"]);
  });
});

describe("territories model details", () => {
  it("sorts bad, then warn, then ok, then by name", () => {
    const [t] = buildTerritories([cl], state(), { status: "all", text: "" }, now);
    expect(t.rows.map(x => x.uid)).toEqual(["crash", "wait", "ok-1"]);
  });
  it("pending covers Pending, ContainerCreating and Init: only when warn", () => {
    const f = { status: "pending", text: "" } as const;
    expect(matchesFilter(r("a", "ContainerCreating", "warn"), f, now)).toBe(true);
    expect(matchesFilter(r("a", "Init:0/1", "warn"), f, now)).toBe(true);
    expect(matchesFilter(r("a", "Init:CrashLoopBackOff", "bad"), f, now)).toBe(false);
    expect(matchesFilter(r("a", "Running", "ok"), f, now)).toBe(false);
  });
  it("restartedToday excludes yesterday and pods that never restarted", () => {
    const f = { status: "restartedToday", text: "" } as const;
    expect(matchesFilter(r("a", "Running", "ok", { last_restart_at: "2026-11-05T23:59:00" }), f, now)).toBe(false);
    expect(matchesFilter(r("a", "Running", "ok", { last_restart_at: null }), f, now)).toBe(false);
  });
  it("text filter matches node", () => {
    expect(matchesFilter(r("a", "Running", "ok"), { status: "all", text: "N1" }, now)).toBe(true);
  });
  it("state comes from the watch, falling back to the cluster", () => {
    expect(buildTerritories([cl], emptyWatchState(), { status: "all", text: "" }, now)[0].state).toBe("unknown");
    const w = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "error", message: "boom" });
    const [t] = buildTerritories([cl], w, { status: "all", text: "" }, now);
    expect([t.state, t.message, t.rows]).toEqual(["error", "boom", []]);
  });
  it.each([["error", "Can't reach this cluster: timeout"], ["syncing", null]] as const)(
    "%s territory hides previously received rows and counts", (st, message) => {
      const w = applyMessage(state(), { type: "cluster_status", cluster_id: "c1", state: st, message });
      const [t] = buildTerritories([cl], w, { status: "all", text: "" }, now);
      expect([t.state, t.message]).toEqual([st, message]);
      expect(t.rows).toEqual([]);
      expect([t.total, t.failing, t.pending]).toEqual([0, 0, 0]);
    });
  it("ready territory shows its rows", () => {
    const w = applyMessage(state(), { type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    expect(buildTerritories([cl], w, { status: "all", text: "" }, now)[0].rows).toHaveLength(3);
  });
  it.each([
    ["2026-11-06T15:59:15", "45s"],
    ["2026-11-06T15:48:00", "12m"],
    ["2026-11-06T13:00:00", "3h"],
    ["2026-10-28T16:00:00", "9d"],
    ["2026-11-06T16:00:30", "0s"],
  ])("age of %s is %s", (created, age) => {
    expect(formatAge(created, now)).toBe(age);
  });
  it.each([[null], [""], ["not a date"]])("age of %s is unknown", (created) => {
    expect(formatAge(created, now)).toBe("—");
  });
});
