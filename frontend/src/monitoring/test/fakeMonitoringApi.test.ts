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
});
