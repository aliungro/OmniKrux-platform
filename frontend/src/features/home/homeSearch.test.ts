import { expect, it } from "vitest";
import type { Cluster, KindInfo, ResourceRow } from "../../api/types";
import { PODS, DEPLOYMENTS } from "../../test/kinds";
import type { Territory } from "../territories/model";
import { matchTier } from "../palette/commands";
import { searchHome } from "./homeSearch";

const cluster: Cluster = { id: "c1", name: "prod-east", context_name: "prod", server: "https://east:6443", original_server: null, provider: "aks", region: "east", environment: "production", state: "ready", message: null };
const row: ResourceRow = { uid: "p1", cluster_id: "c1", name: "web", kind: "Pod", namespace: "demo", created_at: null, columns: {}, labels: {} };
const territory: Territory = { cluster, state: "ready", message: null, rows: [row], total: 1, failing: 0, pending: 0 };

it("groups are capped at eight and ordered", () => {
  const kinds: KindInfo[] = Array.from({ length: 12 }, (_, i) => ({ ...DEPLOYMENTS, key: `web${i}.apps`, label: `Web${i}`, plural_label: `web${i}` }));
  const results = searchHome("web", {
    clusters: Array.from({ length: 12 }, (_, i) => ({ ...cluster, id: `c${i}`, name: `web${i}` })),
    kinds, pods: [{ ...territory, rows: Array.from({ length: 12 }, (_, i) => ({ ...row, uid: `p${i}`, name: `web${i}` })) }],
    pinned: kinds.map(k => k.key).reverse(),
  });
  expect(results.map(r => r.group)).toEqual([...Array(8).fill("Clusters"), ...Array(8).fill("Kinds"), ...Array(8).fill("Pods"), ...Array(8).fill("Find")]);
  expect(results.filter(r => r.group === "Find").map(r => r.kind.key)).toEqual(["web11.apps", "web10.apps", "web9.apps", "web8.apps", "web7.apps", "web6.apps", "web5.apps", "web4.apps"]);
});

it("pods come only from ready clusters", () => {
  const pods = [territory, ...(["unknown", "syncing", "error", "absent"] as const).map(state => ({ ...territory, state, rows: [{ ...row, name: `web-${state}` }] }))];
  expect(searchHome("web", { clusters: [], kinds: [], pods, pinned: [] })).toEqual([{ group: "Pods", row, cluster }]);
});

it("find offers only served pinned non-pod kinds for a nonempty query", () => {
  const ctx = { clusters: [cluster], kinds: [PODS, DEPLOYMENTS, { ...DEPLOYMENTS, key: "gone.apps", clusters: [] }], pods: [], pinned: ["pods", "gone.apps", "missing.apps", "deployments.apps"] };
  expect(searchHome("  needle  ", ctx)).toEqual([{ group: "Find", kind: DEPLOYMENTS, text: "needle" }]);
  expect(searchHome("   ", ctx)).toEqual([]);
});

it("uses the palette match tiers with normalized queries and stable ties", () => {
  expect(matchTier("  DEPLOY  ", ["Deployments"])).toBe(1);
  expect(matchTier("dpl", ["Deployments"])).toBe(2);
  expect(matchTier("po", ["po", "Pods"])).toBe(0);
  expect(matchTier("zzz", ["Pods"])).toBeNull();
  const results = searchHome("web", { clusters: [{ ...cluster, name: "web-api" }, { ...cluster, name: "w-e-b" }, { ...cluster, name: "web" }], kinds: [], pods: [], pinned: [] });
  expect(results.map(r => r.group === "Clusters" && r.cluster.name)).toEqual(["web", "web-api", "w-e-b"]);
});
