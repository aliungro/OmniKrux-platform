// frontend/src/features/territories/model.test.ts
import { describe, it, expect } from "vitest";
import { buildTerritories, chipsFor, countFilters, flatten, formatAge, kindCount, matchesFilter, namespacesIn, podsPerNode, withDiscoveryFailures, type Filters } from "./model";
import type { KindInfo, ResourceRow } from "../../api/types";
import { applyMessage, emptyWatchState } from "../../api/watchState";
const now = new Date("2026-11-06T16:00:00");
const r = (uid: string, status: string, cls: string, extra = {}): ResourceRow => ({ uid, cluster_id: "c1", kind: "Pod", namespace: "payments", name: uid, created_at: "", labels: {}, columns: { status, status_class: cls, node: "n1", ...extra } });
const cl = { id: "c1", name: "aks-prod-weu", context_name: "x", server: "https://x", original_server: null, provider: "aks", region: null, environment: "production", state: "unknown", message: null } as const;
const state = () => applyMessage(emptyWatchState(), { type: "snapshot", cluster_id: "c1", part: 0, last: true,
  rows: [r("ok-1", "Running", "ok"), r("crash", "CrashLoopBackOff", "bad", { last_restart_at: "2026-11-06T14:04:14" }), r("wait", "Pending", "warn")] });

describe("territories model", () => {
  it("sorts failing first and counts ignore filters", () => {
    const [t] = buildTerritories([cl], state(), { status: "failing", text: "", namespace: null }, now);
    expect(t.rows.map(x => x.uid)).toEqual(["crash"]);
    expect([t.total, t.failing, t.pending]).toEqual([3, 1, 1]);
  });
  it("text filter matches name, namespace, node", () => {
    expect(matchesFilter(r("a", "Running", "ok"), { status: "all", text: "PAYM", namespace: null }, now)).toBe(true);
    expect(matchesFilter(r("a", "Running", "ok"), { status: "all", text: "zzz", namespace: null }, now)).toBe(false);
  });
  it("restartedToday uses local day", () => {
    const [t] = buildTerritories([cl], state(), { status: "restartedToday", text: "", namespace: null }, now);
    expect(t.rows.map(x => x.uid)).toEqual(["crash"]);
  });
  it("flatten emits a band then rows", () => {
    const flat = flatten(buildTerritories([cl], state(), { status: "all", text: "", namespace: null }, now));
    expect(flat.map(x => x.type)).toEqual(["band", "row", "row", "row"]);
  });
  it("flatten puts the inspector right after the inspected row, in its own cluster only", () => {
    const ts = buildTerritories([cl], state(), { status: "all", text: "", namespace: null }, now);
    const flat = flatten(ts, { clusterId: "c1", uid: "wait" });
    expect(flat.map(x => x.type)).toEqual(["band", "row", "row", "inspector", "row"]);
    expect(flat[3].type === "inspector" && flat[3].row.uid).toBe("wait");
    expect(flatten(ts, { clusterId: "other", uid: "wait" }).map(x => x.type)).not.toContain("inspector");
  });
});

describe("territories model details", () => {
  it("sorts bad, then warn, then ok, then by name", () => {
    const [t] = buildTerritories([cl], state(), { status: "all", text: "", namespace: null }, now);
    expect(t.rows.map(x => x.uid)).toEqual(["crash", "wait", "ok-1"]);
  });
  it("pending covers Pending, ContainerCreating and Init: only when warn", () => {
    const f = { status: "pending", text: "", namespace: null } as const;
    expect(matchesFilter(r("a", "ContainerCreating", "warn"), f, now)).toBe(true);
    expect(matchesFilter(r("a", "Init:0/1", "warn"), f, now)).toBe(true);
    expect(matchesFilter(r("a", "Init:CrashLoopBackOff", "bad"), f, now)).toBe(false);
    expect(matchesFilter(r("a", "Running", "ok"), f, now)).toBe(false);
  });
  it("restartedToday excludes yesterday and pods that never restarted", () => {
    const f = { status: "restartedToday", text: "", namespace: null } as const;
    expect(matchesFilter(r("a", "Running", "ok", { last_restart_at: "2026-11-05T23:59:00" }), f, now)).toBe(false);
    expect(matchesFilter(r("a", "Running", "ok", { last_restart_at: null }), f, now)).toBe(false);
  });
  it("text filter matches node", () => {
    expect(matchesFilter(r("a", "Running", "ok"), { status: "all", text: "N1", namespace: null }, now)).toBe(true);
  });
  it("state comes from the watch, falling back to the cluster", () => {
    expect(buildTerritories([cl], emptyWatchState(), { status: "all", text: "", namespace: null }, now)[0].state).toBe("unknown");
    const w = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "error", message: "boom" });
    const [t] = buildTerritories([cl], w, { status: "all", text: "", namespace: null }, now);
    expect([t.state, t.message, t.rows]).toEqual(["error", "boom", []]);
  });
  it.each([["error", "Can't reach this cluster: timeout"], ["syncing", null]] as const)(
    "%s territory hides previously received rows and counts", (st, message) => {
      const w = applyMessage(state(), { type: "cluster_status", cluster_id: "c1", state: st, message });
      const [t] = buildTerritories([cl], w, { status: "all", text: "", namespace: null }, now);
      expect([t.state, t.message]).toEqual([st, message]);
      expect(t.rows).toEqual([]);
      expect([t.total, t.failing, t.pending]).toEqual([0, 0, 0]);
    });
  it("ready territory shows its rows", () => {
    const w = applyMessage(state(), { type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    expect(buildTerritories([cl], w, { status: "all", text: "", namespace: null }, now)[0].rows).toHaveLength(3);
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

describe("territory memoization", () => {
  const ready = (cluster_id: string) => ({ type: "cluster_status", cluster_id, state: "ready", message: null }) as const;
  const cl2 = { ...cl, id: "c2", name: "kind-dev" };
  const all = { status: "all", text: "", namespace: null } as const;
  const base = () => {
    let w = applyMessage(state(), ready("c1"));
    w = applyMessage(w, { type: "snapshot", cluster_id: "c2", part: 0, last: true, rows: [{ ...r("x", "Running", "ok"), cluster_id: "c2" }] });
    return applyMessage(w, ready("c2"));
  };

  it("unchanged cluster keeps its territory object", () => {
    const w = base();
    const [t1, t2] = buildTerritories([cl, cl2], w, all, now);
    const w2 = applyMessage(w, { type: "upsert", cluster_id: "c2", row: { ...r("y", "Running", "ok"), cluster_id: "c2" } });
    const [u1, u2] = buildTerritories([cl, cl2], w2, { status: "all", text: "", namespace: null }, new Date(now.getTime() + 30_000));
    expect(u1).toBe(t1);
    expect(u1.rows).toBe(t1.rows);
    expect(u2).not.toBe(t2);
    expect(u2.rows.map((x) => x.uid)).toEqual(["x", "y"]);
  });

  it("rebuilds when the filter, the minute, the cluster or its status changes", () => {
    const w = base();
    const [t] = buildTerritories([cl], w, all, now);
    const failing = buildTerritories([cl], w, { status: "failing", text: "", namespace: null }, now)[0];
    expect(failing).not.toBe(t);
    expect(failing.rows.map((x) => x.uid)).toEqual(["crash"]);
    // Both filters stay cached side by side for the same rows.
    expect(buildTerritories([cl], w, all, now)[0]).toBe(t);
    expect(buildTerritories([cl], w, { status: "failing", text: "", namespace: null }, now)[0]).toBe(failing);
    expect(buildTerritories([cl], w, all, new Date(now.getTime() + 60_000))[0]).not.toBe(t);
    expect(buildTerritories([{ ...cl }], w, all, now)[0]).not.toBe(t);
    const errored = applyMessage(w, { type: "cluster_status", cluster_id: "c1", state: "error", message: "boom" });
    const [e] = buildTerritories([cl], errored, all, now);
    expect([e.state, e.rows]).toEqual(["error", []]);
  });

  it("a cluster without rows keeps its territory too", () => {
    const w = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "syncing", message: null });
    const [t] = buildTerritories([cl], w, all, now);
    const w2 = applyMessage(w, { type: "upsert", cluster_id: "c2", row: { ...r("y", "Running", "ok"), cluster_id: "c2" } });
    expect(buildTerritories([cl], w2, all, now)[0]).toBe(t);
  });
});

describe("filter and kind counts", () => {
  const ready = (cluster_id: string) => ({ type: "cluster_status", cluster_id, state: "ready", message: null }) as const;
  const cl2 = { ...cl, id: "c2", name: "kind-dev" };
  const all = { status: "all", text: "", namespace: null } as const;
  it("count every row of ready territories, ignoring the filter", () => {
    let w = applyMessage(state(), ready("c1"));
    w = applyMessage(w, { type: "snapshot", cluster_id: "c2", part: 0, last: true,
      rows: [{ ...r("b2", "Error", "bad", { last_restart_at: "2026-11-06T09:00:00" }), cluster_id: "c2" }] });
    w = applyMessage(w, ready("c2"));
    const ts = buildTerritories([cl, cl2], w, all, now);
    expect(countFilters(ts, now)).toEqual({ failing: 2, pending: 1, restartedToday: 2 });
    expect(kindCount(ts)).toBe(4);
  });
  it("territories that are not ready count nothing", () => {
    const ts = buildTerritories([cl], state(), all, now); // snapshot but no ready status yet
    // No number at all until a cluster has reported: never a made-up 0.
    expect(countFilters(ts, now)).toEqual({});
    expect(kindCount(ts)).toBeNull();
  });
  it("pod count is zero, not unknown, once a ready cluster has no pods", () => {
    const w = applyMessage(emptyWatchState(), ready("c1"));
    expect(kindCount(buildTerritories([cl], w, all, now))).toBe(0);
  });
});

const kindInfo = (over: Partial<KindInfo> = {}): KindInfo => ({
  key: "deployments.apps", group: "apps", version: "v1", kind: "Deployment", plural: "deployments", label: "Deployment",
  plural_label: "deployments", namespaced: true, short_names: [], builtin: true, verbs: [], clusters: ["c1"], sort: "status",
  columns: [
    { key: "name", label: "Name", type: "text", width: "l" },
    { key: "namespace", label: "Namespace", type: "text", width: "m" },
    { key: "status", label: "Status", type: "status", width: "m" },
    { key: "age", label: "Age", type: "age", width: "s" },
  ],
  ...over,
});
const EVENTS = kindInfo({
  key: "events", kind: "Event", label: "Event", plural: "events", plural_label: "events", sort: "recent",
  columns: [
    { key: "namespace", label: "Namespace", type: "text", width: "m" },
    { key: "status", label: "Type", type: "status", width: "s" },
    { key: "last_seen", label: "Last seen", type: "time", width: "s" },
  ],
});
const ready = (cluster_id: string) => ({ type: "cluster_status", cluster_id, state: "ready", message: null }) as const;
const snap = (rows: ResourceRow[], cluster_id = "c1") =>
  applyMessage(applyMessage(emptyWatchState(), { type: "snapshot", cluster_id, part: 0, last: true, rows }), ready(cluster_id));
const ALL: Filters = { status: "all", text: "", namespace: null };

describe("kinds in the model", () => {
  it("events sort newest first", () => {
    const ev = (uid: string, last_seen: string | null, cls = "ok") =>
      ({ ...r(uid, cls === "ok" ? "Normal" : "Warning", cls), kind: "Event", columns: { status: "Normal", status_class: cls, last_seen } });
    const w = snap([ev("old", "2026-11-06T10:00:00Z"), ev("new", "2026-11-06T15:00:00Z"), ev("never", null), ev("mid", "2026-11-06T12:00:00Z", "warn")]);
    const [t] = buildTerritories([cl], w, ALL, now, EVENTS);
    expect(t.rows.map((x) => x.uid)).toEqual(["new", "mid", "old", "never"]);
  });
  it("helm releases sort by updated, newest first", () => {
    const helm = kindInfo({ key: "helm-releases", sort: "recent" });
    const rel = (uid: string, updated: string) => ({ ...r(uid, "deployed", "ok"), columns: { status: "deployed", status_class: "ok", updated } });
    const [t] = buildTerritories([cl], snap([rel("a", "2026-11-01T00:00:00Z"), rel("b", "2026-11-05T00:00:00Z")]), ALL, now, helm);
    expect(t.rows.map((x) => x.uid)).toEqual(["b", "a"]);
  });
  it("text filter matches labels and images", () => {
    const row = { ...r("web-1", "Running", "ok", { images: ["nginx:1.27", "envoyproxy/envoy:v1.31"] }), labels: { app: "web", tier: "frontend" } };
    const f = (text: string): Filters => ({ status: "all", text, namespace: null });
    expect(matchesFilter(row, f("app=web"), now)).toBe(true);
    expect(matchesFilter(row, f("tier=front"), now)).toBe(true);
    expect(matchesFilter(row, f("ENVOY"), now)).toBe(true);
    expect(matchesFilter(row, f("nginx:1.27"), now)).toBe(true);
    expect(matchesFilter(row, f("app=api"), now)).toBe(false);
    expect(matchesFilter({ ...row, labels: undefined } as unknown as ResourceRow, f("app=web"), now)).toBe(false);
  });
  it("namespace filter keeps one namespace", () => {
    const w = snap([r("a", "Running", "ok"), { ...r("b", "Running", "ok"), namespace: "kube-system" }]);
    const [t] = buildTerritories([cl], w, { status: "all", text: "", namespace: "kube-system" }, now);
    expect(t.rows.map((x) => x.uid)).toEqual(["b"]);
    expect(t.total).toBe(2);
    expect(namespacesIn(buildTerritories([cl], w, ALL, now))).toEqual(["kube-system", "payments"]);
  });
  it("an absent territory has no rows and is excluded from counts", () => {
    let w = snap([r("a", "Running", "ok")]);
    w = applyMessage(w, { type: "cluster_status", cluster_id: "c2", state: "absent", message: "This cluster doesn't serve deployments.apps." });
    const cl2 = { ...cl, id: "c2", name: "kind-dev" };
    const ts = buildTerritories([cl, cl2], w, ALL, now, kindInfo());
    expect([ts[1].state, ts[1].message, ts[1].rows, ts[1].total]).toEqual(["absent", "This cluster doesn't serve deployments.apps.", [], 0]);
    expect(kindCount(ts)).toBe(1);
    expect(kindCount([ts[1]])).toBeNull();
    expect(countFilters(ts, now, kindInfo())).toEqual({ failing: 0, pending: 0 });
    expect(countFilters([ts[1]], now, kindInfo())).toEqual({});
  });
  it("chips follow the kind", () => {
    const keys = (k: KindInfo) => chipsFor(k).map((c) => c.status);
    expect(keys(kindInfo({ key: "pods" }))).toEqual(["failing", "pending", "restartedToday"]);
    expect(keys(EVENTS)).toEqual(["warnings"]);
    expect(keys(kindInfo())).toEqual(["failing", "pending"]);
    expect(keys(kindInfo({ key: "services", columns: [{ key: "name", label: "Name", type: "text", width: "l" }] }))).toEqual([]);
  });
  it("pending means any warning for kinds other than pods", () => {
    const rows = [r("a", "Progressing", "warn"), r("b", "Failed", "bad"), r("c", "Available", "ok")];
    const ts = buildTerritories([cl], snap(rows), { status: "pending", text: "", namespace: null }, now, kindInfo());
    expect(ts[0].rows.map((x) => x.uid)).toEqual(["a"]);
    expect(countFilters(buildTerritories([cl], snap(rows), ALL, now, kindInfo()), now, kindInfo())).toEqual({ failing: 1, pending: 1 });
    const ev = [{ ...r("w", "Warning", "warn") }, { ...r("n", "Normal", "ok") }];
    expect(countFilters(buildTerritories([cl], snap(ev), ALL, now, EVENTS), now, EVENTS)).toEqual({ warnings: 1 });
  });
  it("pods per node counts pods that aren't Completed, on ready clusters only", () => {
    const p = (uid: string, node: string | null, status = "Running", cls = "ok") => r(uid, status, cls, { node });
    let w = snap([p("a", "n1"), p("b", "n1"), p("c", "n2"), p("done", "n1", "Completed", "done"), p("unscheduled", null, "Pending", "warn")]);
    w = applyMessage(w, { type: "snapshot", cluster_id: "c2", part: 0, last: true, rows: [{ ...p("x", "n9"), cluster_id: "c2" }] });
    const counts = podsPerNode(w);
    expect(counts.get("c1")).toEqual(new Map([["n1", 2], ["n2", 1]]));
    expect(counts.has("c2")).toBe(false); // no ready status yet: no number rather than a wrong one
  });
});

describe("discovery failures", () => {
  const widgets = kindInfo({ key: "widgets.example.omnikrux.dev", group: "example.omnikrux.dev", plural: "widgets", plural_label: "widgets" });
  const reason = "The example.omnikrux.dev API didn't answer (503: the server is currently unable to handle the request); its kinds are hidden until it does.";
  const absent = (cluster_id: string) => ({ type: "cluster_status", cluster_id, state: "absent", message: "This cluster doesn't serve widgets.example.omnikrux.dev." }) as const;
  const cl2 = { ...cl, id: "c2", name: "kind-dev" };
  it("an absent kind whose API group failed says the group failed, not that the kind is missing", () => {
    const w = applyMessage(applyMessage(emptyWatchState(), absent("c1")), absent("c2"));
    const ts = buildTerritories([cl, cl2], w, ALL, now, widgets);
    const clusters = {
      c1: { state: "ok", message: null, failed_groups: { "example.omnikrux.dev": reason } },
      c2: { state: "ok", message: null, failed_groups: {} },
    } as const;
    const out = withDiscoveryFailures(ts, clusters, widgets);
    expect(out[0].discoveryFailed).toBe(`Can't list widgets on this cluster right now: ${reason}`);
    expect(out[0].state).toBe("absent");
    // The cluster whose discovery answered really doesn't serve it.
    expect(out[1]).toBe(ts[1]);
    // Nothing failed anywhere: the same array, so memoized views stay put.
    expect(withDiscoveryFailures(ts, { c1: clusters.c2 }, widgets)).toBe(ts);
    expect(withDiscoveryFailures(ts, undefined, widgets)).toBe(ts);
  });
});
