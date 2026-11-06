export type Provider = "aks" | "eks" | "gke" | "oke" | "kind" | "onprem";
export type Environment = "production" | "development" | "unknown";
export type ClusterState = "unknown" | "syncing" | "ready" | "error";
export type StatusClass = "ok" | "warn" | "bad" | "done";

export interface Cluster {
  id: string;
  name: string;
  context_name: string;
  server: string;
  provider: Provider;
  region: string | null;
  environment: Environment;
  state: ClusterState;
  message: string | null;
}

export interface ResourceRow {
  uid: string;
  cluster_id: string;
  kind: string;
  namespace: string | null;
  name: string;
  created_at: string | null;
  columns: Record<string, unknown>;
}

export type WatchMessage =
  | {
      type: "cluster_status";
      cluster_id: string;
      state: "syncing" | "ready" | "error";
      message: string | null;
    }
  | { type: "snapshot"; cluster_id: string; rows: ResourceRow[]; part: number; last: boolean }
  | { type: "upsert"; cluster_id: string; row: ResourceRow }
  | { type: "delete"; cluster_id: string; uid: string };
