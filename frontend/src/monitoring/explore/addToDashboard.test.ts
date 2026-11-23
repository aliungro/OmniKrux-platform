import { afterEach, describe, expect, it, vi } from "vitest";
import type { GroupOut } from "../api/types";
import { DashboardRequestError, type DashboardSummaryOut } from "../dashboards/api";
import { freeSpot } from "../dashboards/layout";
import { nextPanelId, validateDashboard, type DashboardSpec, type PanelType } from "../dashboards/schema";
import { linkedProject, panel, seedDashboard, spec } from "../test/dashboardSeeds";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import { addPanelToDashboard, CHANGED_TWICE, createDashboardWithPanel, dashboardTargets, explorePanel, freshTitle, type DashboardTarget } from "./addToDashboard";

afterEach(() => vi.unstubAllGlobals());

const project = linkedProject("p1", "Shop", "s1");
const group = (id: string, name: string, ...ids: string[]): GroupOut => ({ id, name, project_ids: ids, created_at: "", updated_at: "" });
const summary = (id: string, title: string, owner_kind: "project" | "group", owner_id: string, ready_made = false): DashboardSummaryOut => ({
  id, title, owner_kind, owner_id, version: ready_made ? 0 : 1, panel_count: 0, updated_at: null, ready_made,
});
const source = { source_id: "s1", source_type: "prometheus" as const };
const empty = async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
const puts = (api: FakeMonitoringApi) => api.requests.filter((r) => r.method === "PUT");
const build = (s: DashboardSpec) => explorePanel({ expr: "up", source, title: "Targets up", panelType: "timeseries", unit: "short" }, nextPanelId(s), "project");

describe("dashboard targets", () => {
  it("targets list the project then its groups and never ready-made views", () => {
    const targets = dashboardTargets(
      project,
      [group("g2", "Zeta", "p1"), group("g1", "Alpha", "p1", "p2"), group("g3", "Other", "p2")],
      [
        summary("d2", "Errors", "project", "p1"), summary("d1", "API latency", "project", "p1"),
        summary("ready:cluster", "Cluster", "project", "p1", true),
        summary("d5", "Edge", "group", "g1"), summary("d4", "Beta", "group", "g1"), summary("d6", "Zed", "group", "g2"),
        summary("d7", "Not mine", "group", "g3"), summary("d8", "Other project", "project", "p2"),
      ],
    );
    expect(targets).toEqual([
      { id: "d1", title: "API latency", ownerKind: "project", ownerName: "Shop" },
      { id: "d2", title: "Errors", ownerKind: "project", ownerName: "Shop" },
      { id: "d4", title: "Beta", ownerKind: "group", ownerName: "Alpha" },
      { id: "d5", title: "Edge", ownerKind: "group", ownerName: "Alpha" },
      { id: "d6", title: "Zed", ownerKind: "group", ownerName: "Zeta" },
    ]);
  });

  it("a new title avoids the taken ones", () => {
    expect(freshTitle([])).toBe("Explore");
    expect(freshTitle(["Explore", "Explore (2)"])).toBe("Explore (3)");
  });
});

describe("explorePanel", () => {
  it("a group target gets a null source", () => {
    const p = explorePanel({ expr: "up", source, title: "Up", panelType: "stat", unit: "short" }, "p-1", "group");
    expect(p.queries[0].source).toEqual({ type: "prometheus", id: null });
    const q = explorePanel({ expr: "up", source, title: "Up", panelType: "stat", unit: "short" }, "p-1", "project");
    expect(q.queries[0].source).toEqual({ type: "prometheus", id: "s1" });
  });

  it("every chart type of explorePanel is a valid panel", () => {
    const types: PanelType[] = ["timeseries", "stat", "bar", "table", "logs"];
    for (const kind of ["project", "group"] as const) {
      for (const panelType of types) {
        const logs = panelType === "logs";
        const p = explorePanel(
          { expr: logs ? '{job="api"}' : "up", source: { source_id: "s1", source_type: logs ? "loki" : "prometheus" }, title: "T", panelType, unit: "bytes" },
          "p-1", kind,
        );
        const out = validateDashboard({ ...spec("t", []), panels: [{ ...p, layout: { x: 0, y: 0, w: 12, h: 8 } }] }, kind);
        expect(out.ok, `${panelType} ${kind}: ${JSON.stringify(out.ok ? [] : out.problems)}`).toBe(true);
      }
    }
  });
});

describe("saving into a dashboard", () => {
  const target: DashboardTarget = { id: "d1", title: "API latency", ownerKind: "project", ownerName: "Shop" };
  function seeded() {
    const d = seedDashboard("d1", { kind: "project", id: "p1", name: "Shop" }, spec("API latency", [panel("p-1", "Latency", "up")]));
    d.out.version = 3;
    return installFakeMonitoringApi({ projects: [project], dashboards: { d1: d } }, empty);
  }

  it("adding places the panel at the free spot and saves with origin explore", async () => {
    const api = seeded();
    const result = await addPanelToDashboard(target, build);
    expect(result).toEqual({ title: "API latency", version: 4 });
    expect(puts(api)).toHaveLength(1);
    const body = puts(api)[0].body as { base_version: number; origin: string; spec: DashboardSpec };
    expect(body.base_version).toBe(3);
    expect(body.origin).toBe("explore");
    const added = body.spec.panels[1];
    expect(added.id).toBe("p-2");
    expect(added.layout).toEqual({ ...freeSpot([body.spec.panels[0]], 12, 8), w: 12, h: 8 });
    expect(added.queries[0].expr).toBe("up");
  });

  it("a conflict is retried once on the newer version", async () => {
    const api = seeded();
    let first = true;
    // Another save lands between the read and the first PUT.
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (first && init?.method === "PUT") {
        first = false;
        const d = api.state.dashboards.d1;
        const other = { ...d.out.spec, panels: [...d.out.spec.panels, panel("p-2", "Other save", "node_load1", { x: 12 })] };
        d.out = { ...d.out, version: 4, spec: other };
      }
      return inner(input, init);
    }));
    const result = await addPanelToDashboard(target, build);
    expect(result.version).toBe(5);
    expect(puts(api)).toHaveLength(2);
    const second = puts(api)[1].body as { base_version: number; spec: DashboardSpec };
    expect(second.base_version).toBe(4);
    expect(second.spec.panels.map((p) => p.title)).toEqual(["Latency", "Other save", "Targets up"]);
    expect(second.spec.panels.map((p) => p.id)).toEqual(["p-1", "p-2", "p-3"]);
  });

  it("two conflicts say try again", async () => {
    const api = seeded();
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") api.state.dashboards.d1.out = { ...api.state.dashboards.d1.out, version: api.state.dashboards.d1.out.version + 1 };
      return inner(input, init);
    }));
    const err = await addPanelToDashboard(target, build).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DashboardRequestError);
    expect((err as Error).message).toBe("That dashboard changed twice while adding. Try again.");
    expect((err as Error).message).toBe(CHANGED_TWICE);
    expect(puts(api)).toHaveLength(2);
  });

  it("a new dashboard gets the panel in one create", async () => {
    const api = installFakeMonitoringApi({ projects: [project] }, empty);
    const made = await createDashboardWithPanel({ kind: "project", id: "p1" }, "Explore", build);
    const posts = api.requests.filter((r) => r.method === "POST" && r.url === "/api/monitoring/dashboards");
    expect(posts).toHaveLength(1);
    expect(api.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    const body = posts[0].body as { owner_kind: string; owner_id: string; spec: DashboardSpec };
    expect(body).toMatchObject({ owner_kind: "project", owner_id: "p1" });
    expect(body.spec.title).toBe("Explore");
    expect(body.spec.panels.map((p) => p.title)).toEqual(["Targets up"]);
    expect(made.title).toBe("Explore");
    expect(made.spec.panels).toHaveLength(1);
  });
});
