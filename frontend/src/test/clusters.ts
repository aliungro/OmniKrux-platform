import type { Cluster } from "../api/types";

export const FILE_CLUSTER_METADATA = {
  source: "file",
  kubernetes_version: null,
  node_pools: [],
  node_count: null,
  cloud: null,
  cloud_note: null,
} satisfies Pick<Cluster, "source" | "kubernetes_version" | "node_pools" | "node_count" | "cloud" | "cloud_note">;
