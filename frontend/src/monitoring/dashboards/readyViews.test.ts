import { describe, expect, it } from "vitest";
import type { ProjectOut } from "../api/types";
import { readyAddedBy, readyViewTitles } from "./readyViews";

const FIVE = ["Cluster health", "Node health", "Namespace health", "Workload health", "Pod health"];
const link = (type: "prometheus" | "loki") =>
  ({ source_id: type, source_name: type, source_type: type, filter: "", filter_origin: "none", created_by_project: false }) as ProjectOut["links"][number];
const project = (kind: ProjectOut["kind"], ...types: ("prometheus" | "loki")[]) => ({ kind, links: types.map(link) }) as ProjectOut;

describe("ready-made view rules", () => {
  it("readyViewTitles matches the backend rules", () => {
    expect(readyViewTitles("kubernetes", { prometheus: true, loki: true })).toEqual([...FIVE, "Logs overview"]);
    expect(readyViewTitles("kubernetes", { prometheus: true, loki: false })).toEqual(FIVE);
    for (const kind of ["docker", "servers", "custom"] as const) {
      expect(readyViewTitles(kind, { prometheus: true, loki: true })).toEqual(["Node health", "Logs overview"]);
    }
    expect(readyViewTitles("kubernetes", { prometheus: false, loki: true })).toEqual(["Logs overview"]);
    expect(readyViewTitles("docker", { prometheus: false, loki: false })).toEqual([]);
  });

  it("readyAddedBy names what a new link would add, and nothing when the type is linked", () => {
    expect(readyAddedBy(project("kubernetes"), "loki")).toEqual(["Logs overview"]);
    expect(readyAddedBy(project("kubernetes"), "prometheus")).toEqual(FIVE);
    expect(readyAddedBy(project("kubernetes", "prometheus"), "loki")).toEqual(["Logs overview"]);
    expect(readyAddedBy(project("kubernetes", "loki"), "loki")).toEqual([]);
    expect(readyAddedBy(project("docker", "loki"), "prometheus")).toEqual(["Node health"]);
  });
});
