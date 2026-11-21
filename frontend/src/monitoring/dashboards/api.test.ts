import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteGroup, groupDeleteReview } from "../api/client";
import { NETWORK_MESSAGE, UNREADABLE_ANSWER } from "../api/query";
import type { LinkOut, ProjectOut } from "../api/types";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import {
  copyDashboard, createDashboard, DashboardRequestError, deleteDashboard, getDashboard, getVersion, labelValues,
  listDashboards, listVersions, readyMade, restoreVersion, runBatch, saveDashboard, useDashboard, useDashboardMutation,
  useLabelValues,
} from "./api";
import { emptyDashboard, newPanel, type DashboardSpec } from "./schema";

afterEach(() => vi.unstubAllGlobals());

const link = (id: string): LinkOut => ({
  source_id: id, source_name: id, source_type: "prometheus", filter: "", filter_origin: "none", created_by_project: false,
});
const shop: ProjectOut = {
  id: "p1", name: "Shop", kind: "custom", cluster_id: null, cluster_name: null, cluster_provider: null,
  links: [link("s1")], group_ids: [], created_at: "", updated_at: "",
};

const withPanel = (title: string): DashboardSpec => {
  const spec = emptyDashboard(title);
  const panel = newPanel("timeseries", "p-1", { x: 0, y: 0, w: 12, h: 8 });
  panel.queries[0].expr = "up";
  return { ...spec, panels: [panel] };
};

async function refused(p: Promise<unknown>): Promise<DashboardRequestError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(DashboardRequestError);
  return err as DashboardRequestError;
}

describe("dashboard client", () => {
  it("creates, reads, lists, saves and deletes", async () => {
    const api = installFakeMonitoringApi({ projects: [shop] });
    const made = await createDashboard({ owner_kind: "project", owner_id: "p1", spec: withPanel("Overview") });
    expect(made).toMatchObject({ owner_kind: "project", owner_id: "p1", owner_name: "Shop", title: "Overview", version: 1, ready_made: false });
    expect(await getDashboard(made.id)).toEqual(made);
    expect((await listDashboards({ kind: "project", id: "p1" })).map((d) => [d.title, d.panel_count])).toEqual([["Overview", 1]]);
    expect(await listDashboards({ kind: "group", id: "p1" })).toEqual([]);
    const saved = await saveDashboard(made.id, 1, { ...made.spec, title: "Overview 2" });
    expect(saved).toMatchObject({ version: 2, title: "Overview 2" });
    expect((await listVersions(made.id)).map((v) => [v.version, v.origin])).toEqual([[2, "saved"], [1, "created"]]);
    expect((await getVersion(made.id, 1)).spec.title).toBe("Overview");
    expect(await restoreVersion(made.id, 1, 2)).toMatchObject({ version: 3, title: "Overview" });
    await deleteDashboard(made.id, 3);
    expect((await refused(getDashboard(made.id))).message).toBe("That dashboard no longer exists.");
    expect(api.requests.map((r) => `${r.method} ${r.url}`)).toContain(`DELETE /api/monitoring/dashboards/${made.id}?version=3`);
    expect(api.requests.map((r) => r.url)).toContain("/api/monitoring/dashboards?owner_kind=project&owner_id=p1");
  });

  it("a refused save carries the current version", async () => {
    installFakeMonitoringApi({ projects: [shop] });
    const made = await createDashboard({ owner_kind: "project", owner_id: "p1", spec: withPanel("Overview") });
    await saveDashboard(made.id, 1, made.spec);
    const err = await refused(saveDashboard(made.id, 1, made.spec));
    expect(err).toMatchObject({ status: 409, code: "version_conflict", currentVersion: 2, problems: [] });
    expect(err.message).toBe("This dashboard was saved somewhere else since you started (version 2). Review the differences before saving.");
  });

  it("an invalid document carries its problems", async () => {
    installFakeMonitoringApi({ projects: [shop] });
    const spec = withPanel("Bad");
    spec.panels[0].layout.w = 30;
    const err = await refused(createDashboard({ owner_kind: "project", owner_id: "p1", spec }));
    expect(err.code).toBe("invalid_dashboard");
    expect(err.status).toBe(422);
    expect(err.problems[0].path).toBe("panels[0].layout.w");
    expect(err.message).toBe(`${err.problems[0].path}: ${err.problems[0].message}`);
    expect(err.currentVersion).toBeNull();
  });

  it("titles are unique per owner, case-sensitively", async () => {
    installFakeMonitoringApi({ projects: [shop] });
    await createDashboard({ owner_kind: "project", owner_id: "p1", spec: withPanel("Overview") });
    const err = await refused(createDashboard({ owner_kind: "project", owner_id: "p1", spec: withPanel("Overview") }));
    expect(err).toMatchObject({ status: 409, code: "name_taken", message: 'A dashboard named "Overview" already exists. Pick another name.' });
    await expect(createDashboard({ owner_kind: "project", owner_id: "p1", spec: withPanel("overview") })).resolves.toMatchObject({ title: "overview" });
  });

  it("copies with a unique title and the owner's own sources", async () => {
    installFakeMonitoringApi({
      projects: [shop],
      groups: [{ id: "g1", name: "All", project_ids: ["p1"], created_at: "", updated_at: "" }],
    });
    const spec = withPanel("Overview");
    spec.panels[0].queries[0].source.id = "s1";
    const made = await createDashboard({ owner_kind: "project", owner_id: "p1", spec });
    const copy = await copyDashboard({ from_id: made.id, owner_kind: "group", owner_id: "g1" });
    expect(copy).toMatchObject({ title: "Overview (copy)", owner_kind: "group", owner_name: "All" });
    expect(copy.spec.panels[0].queries[0].source.id).toBeNull();
    const again = await copyDashboard({ from_id: made.id, owner_kind: "group", owner_id: "g1" });
    expect(again.title).toBe("Overview (copy) (2)");
    expect((await listVersions(copy.id))[0]).toMatchObject({ origin: "copied", copied_from: "Overview" });
  });

  it("ready-made views are read-only, have no versions and copy under their own title", async () => {
    const id = "ready:p1:nodes";
    const view = withPanel("Node health");
    installFakeMonitoringApi({
      projects: [shop],
      dashboards: {
        [id]: {
          out: { id, owner_kind: "project", owner_id: "p1", owner_name: "Shop", title: "Node health", version: 0, spec: view, ready_made: true, created_at: null, updated_at: null },
          versions: [],
        },
      },
      readyMade: { p1: [{ key: "nodes", id, title: "Node health", description: "Per node.", missing: [], notes: [], checked: true, check_message: null }] },
    });
    expect((await getDashboard(id)).ready_made).toBe(true);
    const err = await refused(saveDashboard(id, 0, view));
    expect(err).toMatchObject({ status: 409, code: "read_only", message: "Ready-made views can't be changed. Copy one to edit it." });
    expect((await refused(listVersions(id))).status).toBe(404);
    expect((await readyMade("p1")).map((v) => v.id)).toEqual([id]);
    expect((await copyDashboard({ from_id: id, owner_kind: "project", owner_id: "p1" })).title).toBe("Node health");
  });

  it("a group with dashboards deletes with its review's token", async () => {
    const api = installFakeMonitoringApi({ projects: [shop], groups: [{ id: "g 1", name: "All", project_ids: ["p1"], created_at: "", updated_at: "" }] });
    await createDashboard({ owner_kind: "group", owner_id: "g 1", spec: emptyDashboard("Fleet") });
    const review = await groupDeleteReview("g 1");
    expect(review.dashboards.map((d) => d.title)).toEqual(["Fleet"]);
    await expect(deleteGroup("g 1")).rejects.toThrow();
    await deleteGroup("g 1", review.token);
    expect(api.state.groups).toEqual([]);
    expect(api.requests.map((r) => `${r.method} ${r.url}`).slice(-3)).toEqual([
      "GET /api/monitoring/groups/g%201/delete-review",
      "DELETE /api/monitoring/groups/g%201",
      `DELETE /api/monitoring/groups/g%201?token=${review.token}`,
    ]);
  });

  it("encodes every id", async () => {
    const api = installFakeMonitoringApi({ projects: [shop] });
    await refused(getDashboard("ready:p 1/x"));
    await refused(listVersions("a/b"));
    expect(api.requests.map((r) => r.url)).toEqual([
      "/api/monitoring/dashboards/ready%3Ap%201%2Fx",
      "/api/monitoring/dashboards/a%2Fb/versions",
    ]);
  });

  it("a failed fetch is a network error in plain words; an unreadable answer says so", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await refused(getDashboard("d1"))).toMatchObject({ status: 0, code: "network", message: NETWORK_MESSAGE });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    expect((await refused(getDashboard("d1"))).message).toBe(UNREADABLE_ANSWER);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 502, statusText: "Bad Gateway" })));
    expect(await refused(getDashboard("d1"))).toMatchObject({ status: 502, message: UNREADABLE_ANSWER });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "The audit log can't be written." }, { status: 503 })));
    expect(await refused(getDashboard("d1"))).toMatchObject({ status: 503, code: "bad_request", message: "The audit log can't be written." });
  });

  it("an aborted request passes the abort through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")));
    await expect(runBatch([])).rejects.toMatchObject({ name: "AbortError" });
  });

  it("runs a batch and reads label values for a project", async () => {
    const api = installFakeMonitoringApi({
      queryAnswers: {
        up: { series: [{ labels: { job: "x" }, points: [[1, 1]] }] },
        "p2|up": { error: { code: "unreachable", message: "Can't reach it." }, status: 502 },
      },
      labelValues: { "p1|namespace": ["a", "b"] },
    });
    const results = await runBatch([
      { source_id: "s1", project_id: "p1", kind: "instant", query: "up", time: 1 },
      { source_id: "s1", project_id: "p2", kind: "instant", query: "up", time: 1 },
      { source_id: "s1", kind: "instant", query: "up", time: 1 },
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(results[0].response?.series).toHaveLength(1);
    expect(results[1].error).toEqual({ code: "unreachable", message: "Can't reach it.", status: 502 });
    expect(results[2].error).toEqual({ code: "bad_request", message: "Pick the project this query belongs to.", status: 422 });
    const values = await labelValues({ sourceId: "s1", projectId: "p1", label: "namespace", match: 'up{job="a b"}', start: 10, end: 20 });
    expect(values).toEqual({ values: ["a", "b"], truncated: false });
    expect(api.requests.at(-1)?.url).toBe(
      "/api/monitoring/label-values?source_id=s1&project_id=p1&label=namespace&match=up%7Bjob%3D%22a+b%22%7D&start=10&end=20",
    );
    await labelValues({ sourceId: "s1", projectId: "p1", label: "namespace", match: "", start: 10, end: 20 });
    expect(api.requests.at(-1)?.url).toBe("/api/monitoring/label-values?source_id=s1&project_id=p1&label=namespace&start=10&end=20");
  });
});

// --- hooks ------------------------------------------------------------------------------------

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

describe("dashboard hooks", () => {
  it("keys dashboards and label values under monitoring", async () => {
    installFakeMonitoringApi({ projects: [shop], labelValues: { "p1|job": ["x"] } });
    const made = await createDashboard({ owner_kind: "project", owner_id: "p1", spec: withPanel("Overview") });
    const client = new QueryClient();
    const p = { sourceId: "s1", projectId: "p1", label: "job", match: "", start: 0, end: 1 };
    const { result } = renderHook(() => [useDashboard(made.id), useLabelValues(p), useLabelValues(null)] as const, { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current[0].data?.title).toBe("Overview"));
    await waitFor(() => expect(result.current[1].data?.values).toEqual(["x"]));
    expect(result.current[2].fetchStatus).toBe("idle");
    const keys = client.getQueryCache().getAll().map((c) => c.queryKey);
    expect(keys).toEqual(expect.arrayContaining([["monitoring", "dashboard", made.id], ["monitoring", "labelValues", p]]));
  });

  it("a dashboard change re-reads Monitoring and the audit log, but not panel data or label values", async () => {
    installFakeMonitoringApi({ projects: [shop] });
    const client = new QueryClient();
    const keys = [["monitoring", "tree"], ["monitoring", "dashboard", "d1"], ["monitoring", "panel", "d1", "p-1", "[]"], ["monitoring", "labelValues", {}], ["audit", "list"]];
    keys.forEach((k) => client.setQueryData(k, 1));
    const { result } = renderHook(() => useDashboardMutation((spec: DashboardSpec) => createDashboard({ owner_kind: "project", owner_id: "p1", spec })), { wrapper: wrapper(client) });
    await act(() => result.current.mutateAsync(withPanel("Overview")));
    const stale = keys.map((k) => client.getQueryState(k)?.isInvalidated);
    expect(stale).toEqual([true, true, false, false, true]);
  });
});
