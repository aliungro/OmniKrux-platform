import { describe, expect, it } from "vitest";
import type { SourceOut, TreeOut } from "../api/types";
import { buildSearchIndex, FIND_MORE, findResults, hitSubtitle, searchMonitoring } from "./search";

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

  it("search finds dashboards by title with their owner", () => {
    const withDashboards: TreeOut = {
      projects: [{
        id: "p1", name: "prod-east", kind: "kubernetes", cluster_id: "c1", color: "gke",
        dashboards: [{ id: "d1", title: "API latency", ready_made: false }, { id: "ready:p1:pods", title: "Pod health", ready_made: true }],
      }],
      groups: [{ id: "g1", name: "Everything", project_ids: ["p1"], dashboards: [{ id: "d2", title: "Fleet latency", ready_made: false }] }],
      source_count: 0,
    };
    const found = buildSearchIndex({ tree: withDashboards, sources: [] });
    const hits = searchMonitoring(found, "latency");
    expect(hits.map((h) => [h.kind, h.name, h.subtitle, h.view])).toEqual([
      ["dashboard", "API latency", "Dashboard · prod-east", { page: "dashboard", id: "d1" }],
      ["dashboard", "Fleet latency", "Dashboard · Everything", { page: "dashboard", id: "d2" }],
    ]);
    expect(searchMonitoring(found, "pod health").map((h) => [h.subtitle, h.view])).toEqual([
      ["Ready-made view · prod-east", { page: "dashboard", id: "ready:p1:pods" }],
    ]);
    // The owner's name finds its dashboards too.
    expect(searchMonitoring(found, "everything").map((h) => h.name)).toEqual(["Everything", "Fleet latency"]);
  });

  it("a dashboard result says Ready-made view first", () => {
    const owned: TreeOut = {
      projects: [{
        id: "p1", name: "A project with a long name that a narrow list cuts", kind: "custom", cluster_id: null, color: "custom",
        dashboards: [{ id: "d1", title: "Cluster health", ready_made: false }, { id: "ready:p1:cluster", title: "Cluster health", ready_made: true }],
      }],
      groups: [], source_count: 0,
    };
    const hits = searchMonitoring(buildSearchIndex({ tree: owned, sources: [] }), "cluster health");
    // What tells the two apart comes first, so a cut line keeps it; the second line isn't doubled.
    expect(hits.map(hitSubtitle)).toEqual([
      "Dashboard · A project with a long name that a narrow list cuts",
      "Ready-made view · A project with a long name that a narrow list cuts",
    ]);
    expect(hitSubtitle(index.find((e) => e.id === "p1")!)).toBe("Project · Kubernetes · east-cluster");
  });

  it("find lists pages and says how many more matched", () => {
    const withPages = buildSearchIndex({ tree, sources, clusterNames: { c1: "east-cluster" }, pages: true });
    expect(withPages.filter((e) => e.kind === "page").map((e) => [e.name, e.subtitle, e.view])).toEqual([
      ["Home", "Page", { page: "home" }],
      ["Explore", "Page", { page: "explore" }],
      ["Alerts", "Page", { page: "alerts" }],
      ["Sources", "Page", { page: "sources" }],
      ["Import", "Page", { page: "import" }],
    ]);
    expect(findResults(withPages, "expl").shown.map((e) => e.name)).toEqual(["Explore"]);
    expect(hitSubtitle(findResults(withPages, "alerts").shown[0])).toBe("Page");
    // Without `pages`, the index is as before (Home's own search).
    expect(index.some((e) => e.kind === "page")).toBe(false);
    // "o" matches more than eight: eight are shown, and the rest counted.
    const all = searchMonitoring(withPages, "o", 100);
    expect(all.length).toBeGreaterThan(8);
    const { shown, more } = findResults(withPages, "o");
    expect(shown).toEqual(all.slice(0, 8));
    expect(more).toBe(all.length - 8);
    expect(findResults(withPages, "zeta")).toEqual({ shown: [withPages.find((e) => e.id === "p4")], more: 0 });
    expect(findResults(withPages, "  ")).toEqual({ shown: [], more: 0 });
    expect(FIND_MORE).toBe("{n} more: keep typing to narrow them down.");
  });
});
