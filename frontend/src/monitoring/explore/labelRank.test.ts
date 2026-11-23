import { describe, expect, it } from "vitest";
import { MAX_ONLY_LABELS, rankOnlyLabels } from "./LabelChips";

// The labels of kube_pod_container_status_restarts_total from kube-state-metrics, alphabetical as
// the catalog lists them.
const KSM = [
  "app_kubernetes_io_component", "app_kubernetes_io_instance", "app_kubernetes_io_managed_by",
  "app_kubernetes_io_name", "app_kubernetes_io_part_of", "app_kubernetes_io_version",
  "container", "helm_sh_chart", "instance", "job", "label_app", "namespace", "pod", "uid",
];

describe("rankOnlyLabels", () => {
  it("offers the useful kube-state-metrics labels first", () => {
    const shown = rankOnlyLabels(KSM, { only: {}, split: null, loki: [] });
    expect(shown).toHaveLength(MAX_ONLY_LABELS);
    expect(shown).toEqual(["namespace", "pod", "container", "job", "instance", "uid"]);
  });

  it("puts chosen labels first, then the ones Loki also has", () => {
    const shown = rankOnlyLabels(KSM, { only: { app_kubernetes_io_name: "x" }, split: null, loki: ["container", "uid"] });
    expect(shown).toEqual(["app_kubernetes_io_name", "container", "uid", "namespace", "pod", "job"]);
  });

  it("a chosen label past the cap can still be turned off", () => {
    const shown = rankOnlyLabels(KSM, { only: { helm_sh_chart: "a" }, split: null, loki: [] });
    expect(shown[0]).toBe("helm_sh_chart");
  });

  it("the split label is never an Only chip", () => {
    expect(rankOnlyLabels(KSM, { only: {}, split: "namespace", loki: [] })).not.toContain("namespace");
  });

  it("then the split, status and level labels, then the rest with chart labels last", () => {
    const labels = ["zone", "app_kubernetes_io_name", "level", "code", "route", "alpha", "label_team", "helm_sh_chart", "topology_kubernetes_io_region"];
    expect(rankOnlyLabels(labels, { only: {}, split: null, loki: [] }, labels.length)).toEqual([
      "route", "code", "level", "alpha", "zone",
      "app_kubernetes_io_name", "helm_sh_chart", "label_team", "topology_kubernetes_io_region",
    ]);
  });

  it("a label named like an object key is an ordinary label", () => {
    expect(rankOnlyLabels(["constructor", "toString"], { only: {}, split: null, loki: [] })).toEqual(["constructor", "toString"]);
  });
});
