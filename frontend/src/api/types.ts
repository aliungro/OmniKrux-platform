export type Provider = "aks" | "eks" | "gke" | "oke" | "kind" | "onprem";
export type Environment = "production" | "development" | "unknown";
export type ClusterState = "unknown" | "syncing" | "ready" | "error";
export type StatusClass = "ok" | "warn" | "bad" | "done";

export interface Cluster {
  id: string;
  name: string;
  context_name: string;
  server: string;
  /** The kubeconfig's own address when the console rewrote `server` (e.g. 127.0.0.1 → host.docker.internal). */
  original_server: string | null;
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
  | { type: "delete"; cluster_id: string; uid: string }
  | { type: "cluster_removed"; cluster_id: string };

/* Pod describe — mirrors backend/omnikrux/resources/describe.py field for field. */

export interface OwnerRef {
  kind: string;
  name: string;
}

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  status_class: StatusClass;
  node: string | null;
  pod_ip: string | null;
  host_ip: string | null;
  qos: string | null;
  service_account: string | null;
  owner: OwnerRef | null;
  started_at: string | null;
  resource_version: string;
}

export interface EnvVar {
  name: string;
  /** Always null for anything read from a Secret (or any other reference); `source` names it. */
  value: string | null;
  source: string | null;
}

export interface ContainerInfo {
  name: string;
  image: string;
  state: string;
  state_class: StatusClass;
  ready: boolean;
  restarts: number;
  last_state: string | null;
  last_finished_at: string | null;
  requests: Record<string, string>;
  limits: Record<string, string>;
  limit_hit: string[];
  ports: string[];
  probes: Record<string, string>;
  env: EnvVar[];
  mounts: string[];
}

export interface Condition {
  type: string;
  status: string; // "True" | "False" | "Unknown"
  reason: string | null;
  message: string | null;
}

export interface EventInfo {
  type: string; // "Warning" | "Normal"
  reason: string;
  message: string;
  count: number;
  last_seen: string | null;
}

export interface PodDescribe {
  pod: PodInfo;
  containers: ContainerInfo[];
  init_containers: ContainerInfo[];
  ephemeral_containers: ContainerInfo[];
  conditions: Condition[];
  labels: Record<string, string>;
  annotations: Record<string, string>;
  events: EventInfo[];
  /** Why `events` is empty when listing them failed (Ruling R7); null when they listed fine. */
  events_error: string | null;
}

export interface PodYaml {
  yaml: string;
}
