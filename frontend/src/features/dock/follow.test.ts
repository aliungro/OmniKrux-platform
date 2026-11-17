import { describe, expect, it } from "vitest";
import type { ResourceRow } from "../../api/types";
import type { WatchState } from "../../api/watchState";
import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import type { Session } from "./dockState";
import { FOLLOW_SETTLE_MS, followUpdate, holdNote, podGone } from "./follow";

const pod = (name: string, over: Partial<ResourceRow> = {}): ResourceRow => ({
  uid: `uid-${name}`, cluster_id: "c1", kind: "Pod", namespace: "payments", name, created_at: null,
  labels: {}, columns: {}, ...over,
});

const watch = (state: WatchState["clusters"][string]["state"], rows: ResourceRow[]): Pick<WatchState, "clusters" | "rows"> => ({
  clusters: { c1: { state, message: null } },
  rows: { c1: new Map(rows.map((r) => [r.uid, r])) },
});

const target = { clusterId: "c1", namespace: "payments", pod: "crasher" };

describe("followUpdate", () => {
  it("followUpdate covers a pod, another kind, no selection and an unloaded row", () => {
    const row = pod("crasher");
    const ref = { clusterId: "c1", uid: row.uid };
    expect(FOLLOW_SETTLE_MS).toBe(250);
    expect(followUpdate("pods", ref, row)).toEqual({ row });
    expect(followUpdate("deployments.apps", ref, row)).toEqual({ hold: "notPod" });
    expect(followUpdate("pods", null, undefined)).toEqual({ hold: "noSelection" });
    expect(followUpdate("deployments.apps", null, undefined)).toEqual({ hold: "noSelection" });
    expect(followUpdate("pods", ref, undefined)).toEqual({ hold: "noSelection" });
  });
});

describe("podGone", () => {
  it("podGone is false while the cluster is not ready", () => {
    for (const state of ["unknown", "syncing", "error", "absent"] as const) {
      expect(podGone(target, watch(state, []))).toBe(false);
    }
    expect(podGone(target, { clusters: {}, rows: {} })).toBe(false);
  });

  it("a pod recreated under the same name is not gone", () => {
    const recreated = pod("crasher", { uid: "uid-crasher-2" });
    expect(podGone(target, watch("ready", [pod("other"), recreated]))).toBe(false);
  });

  it("podGone is true when the ready cluster has no such pod", () => {
    expect(podGone(target, watch("ready", [pod("other")]))).toBe(true);
    // Same name in another namespace is another pod.
    expect(podGone(target, watch("ready", [pod("crasher", { namespace: "billing" })]))).toBe(true);
    expect(podGone(target, { clusters: { c1: { state: "ready", message: null } }, rows: {} })).toBe(true);
  });
});

describe("holdNote", () => {
  const s = (hold?: Session["hold"]): Session => ({
    id: "f",
    kind: "logs",
    cluster: {
      id: "c1", name: "kind-omnikrux-dev", context_name: "kind-omnikrux-dev", server: "https://x",
      ...FILE_CLUSTER_METADATA, original_server: null,
      provider: "kind", region: null, environment: "development", state: "ready", message: null,
    },
    namespace: "payments",
    pod: "crasher",
    container: "app",
    containers: ["app"],
    follow: true,
    hold,
  });

  it("hold notes say what is shown and why", () => {
    expect(holdNote(s("notPod"))).toBe("Still showing crasher: the selected row isn't a pod.");
    expect(holdNote(s("noSelection"))).toBe("Still showing crasher: no row is selected.");
    expect(holdNote(s("gone"))).toBe("crasher is gone: it was deleted or replaced. Select another pod to follow its log.");
    expect(holdNote(s())).toBeNull();
  });
});
