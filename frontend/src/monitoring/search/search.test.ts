import { describe, expect, it } from "vitest";
import type { SourceOut, TreeOut } from "../api/types";
import { buildSearchIndex, searchMonitoring } from "./search";

const tree: TreeOut = {
  projects: [
    { id: "p1", name: "prod-east", kind: "kubernetes", cluster_id: "c1", color: "gke", dashboards: [] },
    { id: "p2", name: "api prod", kind: "docker", cluster_id: null, color: "onprem", dashboards: [] },
    { id: "p3", name: "Reproduction", kind: "servers", cluster_id: null, color: "onprem", dashboards: [] },
    { id: "p4", name: "Zeta", kind: "kubernetes", cluster_id: "c2", color: "gke", dashboards: [] },
    { id: "p5", name: "Mine", kind: "custom", cluster_id: null, color: "custom", dashboards: [] },
  ],
  groups: [{ id: "g1", name: "Production group", project_ids: ["p1", "p2"], dashboards: [] }],
  source_count: 2,
};
const source = (id: string, name: string, type: "prometheus" | "loki"): SourceOut => ({ id, name, type }) as SourceOut;
const sources = [source("s1", "Metrics", "prometheus"), source("s2", "Logs", "loki")];
const index = buildSearchIndex({ tree, sources, clusterNames: { c1: "east-cluster", c2: "prod-cluster" } });

describe("search", () => {
  it("builds subtitles and views", () => {
    const by = (id: string) => index.find((e) => e.id === id)!;
    expect(by("p1").subtitle).toBe("Kubernetes · east-cluster");
    expect(by("p2").subtitle).toBe("Docker host");
    expect(by("p3").subtitle).toBe("Servers");
    expect(by("p5").subtitle).toBe("Your own project");
    expect(by("g1").subtitle).toBe("2 projects");
    expect(by("s1").subtitle).toBe("Prometheus-compatible");
    expect(by("s2").subtitle).toBe("Loki");
    expect(by("s2").view).toEqual({ page: "source", id: "s2" });
    expect(by("p1").view).toEqual({ page: "project", id: "p1" });
    expect(by("g1").view).toEqual({ page: "group", id: "g1" });
  });

  it("search ranks name starts first", () => {
    const names = searchMonitoring(index, "prod").map((e) => e.name);
    // name starts (by name), a word starts, name contains, subtitle contains
    expect(names).toEqual(["prod-east", "Production group", "api prod", "Reproduction", "Zeta"]);
  });

  it("is case-insensitive, limited and empty for blank text", () => {
    expect(searchMonitoring(index, "PROD-E")[0].id).toBe("p1");
    expect(searchMonitoring(index, "prod", 2)).toHaveLength(2);
    expect(searchMonitoring(index, "  ")).toEqual([]);
    expect(searchMonitoring(index, "nothing-like-this")).toEqual([]);
  });
});
