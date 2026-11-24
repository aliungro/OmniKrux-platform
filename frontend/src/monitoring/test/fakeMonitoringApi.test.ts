import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, patchJson, postJson, putJson } from "../../api/http";
import type { SourceOut } from "../api/types";
import { installFakeMonitoringApi } from "./fakeMonitoringApi";

afterEach(() => vi.unstubAllGlobals());

describe("fake Monitoring API", () => {
  it("fake API records requests and falls back", async () => {
    const api = installFakeMonitoringApi();
    expect(await getJson("/api/clusters")).toEqual([]);
    expect(await getJson<unknown[]>("/api/monitoring/sources")).toEqual([]);
    const created = await postJson<SourceOut>("/api/monitoring/sources", { name: "Metrics", type: "prometheus", reach: "url", url: "http://prom:9090" });
    expect(created).toMatchObject({ name: "Metrics", type: "prometheus" });
    expect(api.state.sources).toHaveLength(1);
    expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/monitoring/sources", "POST /api/monitoring/sources"]);
    expect(api.requests[1].body).toMatchObject({ name: "Metrics" });
    await expect(postJson("/api/monitoring/sources", { name: "Metrics", type: "prometheus", reach: "url", url: "http://x" })).rejects.toThrow(/already exists/);
    await expect(postJson("/api/monitoring/sources", { name: "", type: "loki", reach: "url", url: "http://x" })).rejects.toThrow("Names are 1 to 80 characters, without line breaks.");
  });

  it("uses a given fallback and seed, and answers queries by text", async () => {
    const fallback = vi.fn().mockResolvedValue(new Response("[1]", { status: 200 }));
    const api = installFakeMonitoringApi(
      { queries: { up: { result_type: "vector", series: [{ labels: {}, points: [[1, 1]] }] } } }, fallback,
    );
    expect(await getJson("/api/other")).toEqual([1]);
    expect(fallback).toHaveBeenCalled();
    const res = await postJson<{ series: unknown[] }>("/api/monitoring/query", { source_id: "s", kind: "instant", query: "up" });
    expect(res.series).toHaveLength(1);
    await expect(postJson("/api/monitoring/query", { source_id: "s", kind: "instant", query: "nope" })).rejects.toThrow();
    expect(api.requests).toHaveLength(2);
  });

  it("renames, links and groups projects", async () => {
    const api = installFakeMonitoringApi();
    const project = await postJson<{ id: string }>("/api/monitoring/setup", { name: "Shop", kind: "custom", sources: [] });
    const renamed = await patchJson<{ name: string }>(`/api/monitoring/projects/${project.id}`, { name: "Shop 2" });
    expect(renamed.name).toBe("Shop 2");
    const group = await postJson<{ id: string; project_ids: string[] }>("/api/monitoring/groups", { name: "All", project_ids: [project.id] });
    expect(group.project_ids).toEqual([project.id]);
    const tree = await getJson<{ projects: { name: string }[]; groups: unknown[] }>("/api/monitoring/tree");
    expect(tree.projects[0].name).toBe("Shop 2");
    expect(tree.groups).toHaveLength(1);
    await expect(putJson(`/api/monitoring/projects/${project.id}/sources/nope`, { filter: "", origin: "user" })).rejects.toThrow();
    expect(api.state.projects[0].group_ids).toEqual([group.id]);
  });

  it("answers /query from queryAnswers first, by project and text, with errors", async () => {
    installFakeMonitoringApi({
      queries: { up: { series: [] } },
      queryAnswers: {
        up: { series: [{ labels: { a: "1" }, points: [] }] },
        "p1|up": { error: { code: "timeout", message: "It took too long." }, status: 504 },
      },
    });
    const res = await postJson<{ series: unknown[] }>("/api/monitoring/query", { source_id: "s", kind: "instant", query: "up" });
    expect(res.series).toHaveLength(1);
    const failed = await fetch("/api/monitoring/query", { method: "POST", body: JSON.stringify({ source_id: "s", project_id: "p1", kind: "instant", query: "up" }) });
    expect(failed.status).toBe(504);
    expect(await failed.json()).toEqual({ detail: { code: "timeout", message: "It took too long." } });
  });

  it("lists dashboards in the tree, saved ones by title then the ready-made views", async () => {
    const api = installFakeMonitoringApi({
      projects: [{ id: "p1", name: "Shop", kind: "custom", cluster_id: null, cluster_name: null, cluster_provider: null, links: [], group_ids: [], created_at: "", updated_at: "" }],
      groups: [{ id: "g1", name: "All", project_ids: ["p1"], created_at: "", updated_at: "" }],
      readyMade: { p1: [{ key: "nodes", id: "ready:p1:nodes", title: "Node health", description: "", missing: [], notes: [], checked: true, check_message: null }] },
    });
    const spec = (title: string) => ({ schemaVersion: 1, title, time: { from: "now-1h", to: "now" }, panels: [] });
    await postJson("/api/monitoring/dashboards", { owner_kind: "project", owner_id: "p1", spec: spec("zeta") });
    await postJson("/api/monitoring/dashboards", { owner_kind: "project", owner_id: "p1", spec: spec("Alpha") });
    const gd = await postJson<{ id: string }>("/api/monitoring/dashboards", { owner_kind: "group", owner_id: "g1", spec: spec("Group view") });
    const tree = await getJson<{ projects: { dashboards: unknown[] }[]; groups: { dashboards: unknown[] }[] }>("/api/monitoring/tree");
    expect(tree.projects[0].dashboards).toEqual([
      { id: expect.any(String), title: "Alpha", ready_made: false },
      { id: expect.any(String), title: "zeta", ready_made: false },
      { id: "ready:p1:nodes", title: "Node health", ready_made: true },
    ]);
    expect(tree.groups[0].dashboards).toEqual([{ id: gd.id, title: "Group view", ready_made: false }]);

    const projectReview = await getJson<{ dashboards: { title: string; versions: number }[] }>("/api/monitoring/projects/p1/delete-review");
    expect(projectReview.dashboards.map((d) => [d.title, d.versions])).toEqual([["Alpha", 1], ["zeta", 1]]);

    const review = await getJson<{ group_id: string; name: string; dashboards: { id: string; title: string; versions: number }[]; token: string }>("/api/monitoring/groups/g1/delete-review");
    expect(review).toEqual({ group_id: "g1", name: "All", dashboards: [{ id: gd.id, title: "Group view", versions: 1 }], token: expect.any(String) });
    const tokenless = await fetch("/api/monitoring/groups/g1", { method: "DELETE" });
    expect(tokenless.status).toBe(409);
    const done = await fetch(`/api/monitoring/groups/g1?token=${review.token}`, { method: "DELETE" });
    expect(done.status).toBe(204);
    expect(Object.keys(api.state.dashboards)).toHaveLength(2);

    const projectDelete = await fetch(`/api/monitoring/projects/p1?token=${review.token}`, { method: "DELETE" });
    expect(projectDelete.status).toBe(204);
    expect(api.state.dashboards).toEqual({});
  });

  it("a group without dashboards deletes without a token, and its review lists none", async () => {
    installFakeMonitoringApi({ groups: [{ id: "g1", name: "All", project_ids: [], created_at: "", updated_at: "" }] });
    expect((await getJson<{ dashboards: unknown[] }>("/api/monitoring/groups/g1/delete-review")).dashboards).toEqual([]);
    expect((await fetch("/api/monitoring/groups/g1", { method: "DELETE" })).status).toBe(204);
  });

  it("refuses batch items and label values the server would refuse", async () => {
    installFakeMonitoringApi({
      projects: [{
        id: "p1", name: "Shop", kind: "custom", cluster_id: null, cluster_name: null, cluster_provider: null,
        links: [{ source_id: "s1", source_name: "s1", source_type: "prometheus", filter: "", filter_origin: "none", created_by_project: false }],
        group_ids: [], created_at: "", updated_at: "",
      }],
      queryAnswers: { up: { series: [] } },
      labelValues: { "p1|job": ["x"] },
    });
    const item = (more: Record<string, unknown>) => ({ source_id: "s1", project_id: "p1", kind: "instant", query: "up", time: 1, ...more });
    const res = await postJson<{ results: { ok: boolean; error: unknown }[] }>("/api/monitoring/query/batch", { queries: [
      item({}),
      item({ project_id: "gone" }),
      item({ source_id: "s2" }),
      item({ kind: "range", time: null, start: 0, end: 60 }),
      item({ kind: "range", time: null, start: 60, end: 60, step: 1 }),
      item({ kind: "range", time: null, start: 0, end: 12000, step: 1 }),
      item({ kind: "range", time: null, start: 0, end: 60, step: 5 }),
    ] });
    expect(res.results.map((r) => r.error)).toEqual([
      null,
      { code: "not_found", message: "That project no longer exists.", status: 404 },
      { code: "not_linked", message: "This source isn't linked to that project.", status: 404 },
      { code: "bad_request", message: "A range query needs a start, an end after it, and a step.", status: 400 },
      { code: "bad_request", message: "A range query needs a start, an end after it, and a step.", status: 400 },
      { code: "bad_request", message: "This range has too many points for the step. Use a larger step.", status: 400 },
      null,
    ]);
    expect(await getJson("/api/monitoring/label-values?source_id=s1&project_id=p1&label=job")).toEqual({ values: ["x"], truncated: false });
    const gone = await fetch("/api/monitoring/label-values?source_id=s1&project_id=gone&label=job");
    expect([gone.status, await gone.json()]).toEqual([404, { detail: { code: "not_found", message: "That project no longer exists." } }]);
    const unlinked = await fetch("/api/monitoring/label-values?source_id=s2&project_id=p1&label=job");
    expect([unlinked.status, await unlinked.json()]).toEqual([404, { detail: { code: "not_linked", message: "This source isn't linked to that project." } }]);
  });

  it("refuses a bad owner kind, and a ready-made view whose project is gone", async () => {
    const spec = { schemaVersion: 1, title: "Nodes", panels: [] };
    const api = installFakeMonitoringApi({
      projects: [{ id: "p1", name: "Shop", kind: "custom", cluster_id: null, cluster_name: null, cluster_provider: null, links: [], group_ids: [], created_at: "", updated_at: "" }],
    });
    const kindWords = { detail: { code: "bad_request", message: 'Choose "project" or "group" as the owner kind.' } };
    const post = await fetch("/api/monitoring/dashboards", { method: "POST", body: JSON.stringify({ owner_kind: "team", owner_id: "p1", spec }) });
    expect([post.status, await post.json()]).toEqual([422, kindWords]);
    const copy = await fetch("/api/monitoring/dashboards/copy", { method: "POST", body: JSON.stringify({ from_id: "x", owner_kind: "team", owner_id: "p1" }) });
    expect([copy.status, await copy.json()]).toEqual([422, kindWords]);

    const id = "ready:p1:nodes";
    const full = { schemaVersion: 1, title: "Node health", description: "", time: { from: "now-6h", to: "now" }, refresh: null, variables: [], panels: [] };
    api.state.dashboards[id] = {
      out: {
        id, owner_kind: "project", owner_id: "p1", owner_name: "Shop", title: "Node health", version: 0, spec: full as never,
        ready_made: true, created_at: null, updated_at: null,
      },
      versions: [],
    };
    expect((await fetch(`/api/monitoring/dashboards/${encodeURIComponent(id)}`)).status).toBe(200);
    api.state.projects = [];
    const gone = await fetch(`/api/monitoring/dashboards/${encodeURIComponent(id)}`);
    expect([gone.status, await gone.json()]).toEqual([404, { detail: { code: "not_found", message: "That dashboard no longer exists." } }]);
    const copyGone = await fetch("/api/monitoring/dashboards/copy", { method: "POST", body: JSON.stringify({ from_id: id, owner_kind: "project", owner_id: "p1" }) });
    expect(copyGone.status).toBe(404);
  });

  it("refuses a batch of the wrong size and label values without a project", async () => {
    installFakeMonitoringApi();
    const empty = await fetch("/api/monitoring/query/batch", { method: "POST", body: JSON.stringify({ queries: [] }) });
    expect(empty.status).toBe(422);
    expect(await empty.json()).toEqual({ detail: { code: "bad_request", message: "Send 1 to 64 queries in one batch." } });
    const values = await fetch("/api/monitoring/label-values?source_id=s&label=job");
    expect(values.status).toBe(400);
    expect(await values.json()).toEqual({ detail: { code: "bad_request", message: "Choose the project whose label values to read." } });
  });

  it("fake API answers an empty overview, no firing and empty lists by default", async () => {
    installFakeMonitoringApi();
    expect(await getJson("/api/monitoring/alerts/overview")).toEqual({
      counts: { rules: 0, firing: 0, pending: 0, cant_check: 0, not_applied: 0 }, firing: [], by_project: {}, by_group: {},
      engine: { enabled: true, running: true, last_tick_at: expect.any(String), rules: 0, behind: 0, note: "" },
    });
    for (const path of ["rules", "contact-points"]) expect(await getJson(`/api/monitoring/alerts/${path}`)).toEqual([]);
    expect(await getJson("/api/monitoring/alerts/silences")).toEqual({ silences: [], problems: [] });
    expect(await getJson("/api/monitoring/alerts/panel-states?dashboard_id=d1")).toEqual({});
    expect(await getJson("/api/monitoring/alerts/channels?project_id=p1")).toEqual({ alertmanager: null, channels: [], message: null });
    expect(await postJson("/api/monitoring/alerts/dry-run", {})).toMatchObject({ fired: 0, periods: [] });
  });

  it("fake API answers rule conflicts with the current version", async () => {
    const api = installFakeMonitoringApi({ projects: [{ id: "p1", name: "Shop", kind: "custom", cluster_id: null, cluster_name: null, cluster_provider: null, links: [], group_ids: [], created_at: "", updated_at: "" }] });
    const body = { name: "Slow", scope: { kind: "project", id: "p1" }, source: { type: "prometheus", id: null }, expr: "up",
      condition: { of: "each", op: "above", threshold: 1, for: "5m", every: "1m" }, severity: "warning", message: "", contact_point_ids: [], engine: "omnikrux", channel: null };
    const made = await postJson<{ rule: { id: string; version: number } }>("/api/monitoring/alerts/rules", body);
    const res = await fetch(`/api/monitoring/alerts/rules/${made.rule.id}`, { method: "PUT", body: JSON.stringify({ ...body, base_version: 9 }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: {
      code: "rule_changed", current_version: 1,
      message: "This rule was changed somewhere else since you opened it (version 1). Open it again.",
    } });
    const gone = await fetch("/api/monitoring/alerts/rules/nope");
    expect(gone.status).toBe(404);
    expect(api.requests.map((r) => r.method + " " + r.url).slice(-2)).toEqual([
      "PUT /api/monitoring/alerts/rules/" + made.rule.id, "GET /api/monitoring/alerts/rules/nope",
    ]);
  });

  it("answers a dashboard save with the seeded alert changes", async () => {
    const change = { target_id: "t1", rule_id: "r1", rule_name: "Slow", project_id: "p1", project_name: "Shop", kind: "review" as const, message: null };
    installFakeMonitoringApi({
      projects: [{ id: "p1", name: "Shop", kind: "custom", cluster_id: null, cluster_name: null, cluster_provider: null, links: [], group_ids: [], created_at: "", updated_at: "" }],
      alertChangesOnSave: [change],
    });
    const spec = { schemaVersion: 1, title: "D", time: { from: "now-1h", to: "now" }, panels: [] };
    const created = await postJson<{ id: string; alert_changes: unknown[] }>("/api/monitoring/dashboards", { owner_kind: "project", owner_id: "p1", spec });
    expect(created.alert_changes).toEqual([]);
    const saved = await putJson<{ alert_changes: unknown[] }>(`/api/monitoring/dashboards/${created.id}`, { base_version: 1, spec: { ...spec, title: "D2" } });
    expect(saved.alert_changes).toEqual([change]);
  });

  it("answers syncs and silences from its seed and its rules", async () => {
    installFakeMonitoringApi({ syncAnswers: { t1: { kind: "done", target: null }, t2: { status: 409, error: { message: "Another change is in progress." } } } });
    expect(await postJson("/api/monitoring/alerts/targets/t1/sync")).toEqual({ kind: "done", target: null });
    await expect(postJson("/api/monitoring/alerts/targets/t2/sync")).rejects.toThrow();
    expect((await fetch("/api/monitoring/alerts/targets/t9/sync", { method: "POST" })).status).toBe(404);
    const made = await postJson<{ id: string }>("/api/monitoring/alerts/silences", { where: { kind: "omnikrux" }, matchers: "a=b", ends_at: "2026-01-02T00:00:00Z", comment: "x" });
    expect((await getJson<{ silences: unknown[] }>("/api/monitoring/alerts/silences")).silences).toHaveLength(1);
    expect((await fetch(`/api/monitoring/alerts/silences/omnikrux/${made.id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("install answers are seeded in part and a contact point's PATCH and DELETE carry its alert changes", async () => {
    const api = installFakeMonitoringApi({ install: { probe: { "http://192.0.2.1:9090": { ok: true } } } });
    expect(api.state.install.tools.available).toBe(false);
    expect(api.state.install.plans).toEqual([]);
    expect(api.state.install.probe).toEqual({ "http://192.0.2.1:9090": { ok: true } });
    const point = await postJson<{ id: string }>("/api/monitoring/alerts/contact-points", { name: "Ops", type: "webhook", settings: {} });
    const patched = await patchJson<{ name: string; alert_changes: unknown[] }>(`/api/monitoring/alerts/contact-points/${point.id}`, { name: "Ops 2" });
    expect(patched).toMatchObject({ name: "Ops 2", alert_changes: [] });
    const res = await fetch(`/api/monitoring/alerts/contact-points/${point.id}?token=review-token`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alert_changes: [] });
    expect(api.state.contactPoints).toEqual([]);
  });
});
