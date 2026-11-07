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
  /** The owner's matchLabels as "k=v,k2=v2", for its pods' logs; null when it has none or couldn't be read. */
  selector: string | null;
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

/** `POST …/pods/{ns}/{name}/debug`: `target` is null when the asked-for container wasn't running (Ruling R12). */
export interface DebugContainer {
  container: string;
  target: string | null;
}

/** `POST …/nodes/{node}/shell`: the node-shell pod to open a shell in. */
export interface NodeShellPod {
  namespace: string;
  pod: string;
  container: string;
}

export interface PodYaml {
  yaml: string;
}

/* Logs — mirrors backend/omnikrux/logs (stream.py LogLine / Marker, api.py messages). */

export interface LogLine {
  pod: string;
  container: string;
  /** RFC 3339 as the kubelet stamped it; null for a line without a stamp. */
  ts: string | null;
  text: string;
}

/** Something that happened to the stream, e.g. "Container restarted at …"; prefixed "{pod}: " in selector mode. */
export interface LogMarker {
  marker: string;
}

export type LogMessage =
  | { type: "lines"; lines: (LogLine | LogMarker)[] }
  /** Lines the server dropped because the page read them too slowly. */
  | { type: "dropped"; count: number }
  | { type: "status"; state: "streaming" | "ended" | "error"; message: string | null };

/**
 * What a log pane shows. The dock (Task 13) builds one per logs session and renders
 * `<LogPane key={sessionId} session={…} />`; the pane keeps its own toggles, so a new session
 * needs a new key.
 */
export interface LogSession {
  clusterId: string;
  /** For the pane header, which names the cluster as "cluster / namespace / pod (container)". */
  clusterName: string;
  provider: Provider;
  namespace: string;
  /** Exactly one of `pod` and `selector` is set: one pod's log, or every pod a label selector matches. */
  pod?: string;
  selector?: string;
  /** The container to show first; null lets the server pick the pod's first container. */
  container: string | null;
  /** Every container the picker offers (init, regular and ephemeral); may be empty. */
  containers: string[];
  /** Open on the previous run's log (the `p` shortcut). */
  previous?: boolean;
}

/** What the server sends on `WS /api/exec` (the browser sends `stdin` and `resize` frames). */
export type ExecMessage =
  | { type: "stdout" | "stderr"; data: string }
  /**
   * The shell ended; the server closes the socket after this. `code` is null when unknown.
   * `cannot_run`: the command couldn't start in the container (no shell there, say).
   */
  | { type: "exit"; code: number | null; message: string | null; cannot_run?: boolean }
  /** The shell couldn't be opened or broke; the server closes the socket after this. */
  | { type: "error"; message: string };

/**
 * What a shell pane shows. The dock (Task 13) builds one per shell session and renders
 * `<ShellPane key={sessionId} session={…} />`; a new session needs a new key (a fresh shell).
 * A node shell is the same thing with the node-shell pod as `pod` and `cleanupPod: true`.
 */
export interface ShellSession {
  clusterId: string;
  /** For the pane header, which names the cluster as "cluster / namespace / pod (container)". */
  clusterName: string;
  provider: Provider;
  namespace: string;
  pod: string;
  /** Null lets the server pick the pod's first container. */
  container: string | null;
  /** True for node shells: the server deletes the pod when the session ends. */
  cleanupPod: boolean;
}
