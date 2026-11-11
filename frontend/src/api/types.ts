export type Provider = "aks" | "eks" | "gke" | "oke" | "kind" | "onprem";
export type Environment = "production" | "development" | "unknown";
/** `absent`: the cluster doesn't serve the watched kind (its message says so); says nothing about the cluster. */
export type ClusterState = "unknown" | "syncing" | "ready" | "error" | "absent";
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
  labels: Record<string, string>;
}

export interface ContainerState {
  name: string;
  init: boolean;
  state: "ready" | "running" | "waiting" | "failing" | "done";
  reason: string | null;
  restarts: number;
}

/* Kinds — mirrors backend/omnikrux/resources/catalog.py (GET /api/kinds). */

export type ColumnType = "text" | "number" | "status" | "age" | "time" | "cpu" | "memory" | "object" | "pods";

export interface ColumnSpec {
  /** The row's `columns` key; `name`, `namespace` and `age` read the row's own fields. */
  key: string;
  label: string;
  type: ColumnType;
  /** s: 70px, m: 1fr, l: 2fr (Name is always at least 200px). */
  width: "s" | "m" | "l";
}

export interface ServedKind {
  /** kubectl's fully qualified resource name (`deployments.apps`), or `helm-releases`. */
  key: string;
  group: string;
  version: string;
  kind: string;
  plural: string;
  /** Singular, e.g. "Deployment" or "Helm release". */
  label: string;
  /** For copy such as "No deployments" (Ruling R18). */
  plural_label: string;
  namespaced: boolean;
  short_names: string[];
  columns: ColumnSpec[];
  /** `recent`: newest `last seen` / `updated` first; `status`: failing first, then by name. */
  sort: "status" | "recent";
  builtin: boolean;
  verbs: string[];
  verbs_by_cluster?: Record<string, string[]>;
  /** The clusters that serve it. */
  clusters: string[];
}

export type KindInfo = ServedKind;

export interface ClusterKindsStatus {
  state: "ok" | "error";
  message: string | null;
  /** API groups that didn't answer, with why in plain words; their kinds are missing for now. */
  failed_groups: Record<string, string>;
}

export interface KindsResponse {
  kinds: KindInfo[];
  clusters: Record<string, ClusterKindsStatus>;
}

/** An `object` column: what a row points at; `kind_key` is null for a kind the console can't name. */
export interface ObjectColumn {
  kind_key: string | null;
  namespace: string | null;
  name: string;
  label: string;
}

/** Where a click goes — mirrors describe.py `Link`: an object of `kind_key`; a null namespace is a cluster-scoped kind. */
export interface Link {
  kind_key: string;
  namespace: string | null;
  name: string;
}

export type WatchMessage =
  | {
      type: "cluster_status";
      cluster_id: string;
      state: "syncing" | "ready" | "error" | "absent";
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
  /** Null for a kind the console can't name (a CRD owner). */
  link: Link | null;
}

export interface PodInfo {
  name: string;
  namespace: string;
  status: string;
  status_class: StatusClass;
  node: string | null;
  node_link: Link | null;
  pod_ip: string | null;
  host_ip: string | null;
  qos: string | null;
  service_account: string | null;
  service_account_link: Link | null;
  owner: OwnerRef | null;
  started_at: string | null;
  resource_version: string;
}

export interface EnvVar {
  name: string;
  /** A declared literal or the pod namespace for `metadata.namespace`. Other references are null. */
  value: string | null;
  source: string | null;
  /** The ConfigMap or Secret it is read from. */
  link: Link | null;
}

export interface Volume {
  name: string;
  /** The volume source's field: "configMap", "secret", "emptyDir", … */
  type: string;
  /** For configMap, secret and persistentVolumeClaim volumes. */
  link: Link | null;
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
  volumes: Volume[];
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

/* Any kind's describe — mirrors backend/omnikrux/resources/describe_any.py field for field. */

export interface Field {
  label: string;
  value: string | null;
  link: Link | null;
}

export interface Cell {
  text: string | null;
  link: Link | null;
  cls: StatusClass | null;
}

export interface Section {
  title: string;
  columns: string[];
  rows: Cell[][];
  /** Why there are no rows, or where to look instead. */
  note: string | null;
}

export interface SecretKey {
  key: string;
  /** Bytes of the decoded value. */
  size: number;
}

export interface ResourceDescribe {
  kind_key: string;
  kind: string;
  name: string;
  namespace: string | null;
  uid: string;
  resource_version: string;
  created_at: string | null;
  fields: Field[];
  sections: Section[];
  conditions: Condition[];
  labels: Record<string, string>;
  annotations: Record<string, string>;
  owner: Link | null;
  events: EventInfo[];
  /** Why `events` is empty when listing them failed. */
  events_error: string | null;
  /** Secrets only: key names and sizes, never values. */
  secret_keys: SecretKey[] | null;
  /** A workload's matchLabels as "k=v,k2=v2", for its pods' logs; null for other kinds, or when it selects with expressions. */
  pod_selector: string | null;
}

/** `GET …/resources/{kind}/{name}/yaml`: a Secret's values are masked by the server. */
export interface ResourceYaml {
  yaml: string;
}

/** The body of `POST …/secrets/{ns}/{name}/reveal`: one key. */
export interface RevealIn {
  key: string;
}

/**
 * The answer to a reveal (sent `no-store`). Held in component state only: never in the query
 * cache, a URL, a log or browser storage.
 */
export interface RevealOut {
  key: string;
  value: string;
  /** base64: the value isn't UTF-8 text. */
  encoding: "utf-8" | "base64";
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

/* Metrics — mirrors backend/omnikrux/metrics/models.py. */

export type MetricsState = "ok" | "unavailable" | "error";

export interface Usage {
  cpu_m: number;
  memory_b: number;
  /** metrics-server's own timestamp for the measurement. */
  at: string;
  window_s: number;
  /** metrics-server has nothing newer than a minute or so before we asked. */
  stale: boolean;
}

export interface NodeSize {
  cpu_m: number | null;
  memory_b: number | null;
}

export interface ClusterMetrics {
  state: MetricsState;
  message: string | null;
  fetched_at: string | null;
  /** "ns/name" for pods, "name" for nodes; empty unless `state` is ok. */
  items: Record<string, Usage>;
  nodes?: Record<string, NodeSize>;
}

export interface MetricsOut {
  kind: "pods" | "nodes";
  clusters: Record<string, ClusterMetrics>;
}

export interface ContainerUsage {
  name: string;
  cpu_m: number;
  memory_b: number;
  cpu_request_m: number | null;
  cpu_limit_m: number | null;
  memory_request_b: number | null;
  memory_limit_b: number | null;
}

export interface PodMetrics {
  state: MetricsState;
  message: string | null;
  at: string | null;
  window_s: number | null;
  stale: boolean;
  containers: ContainerUsage[];
}

export interface NodeMetrics {
  state: MetricsState;
  message: string | null;
  at: string | null;
  window_s: number | null;
  stale: boolean;
  cpu_m: number | null;
  memory_b: number | null;
  allocatable_cpu_m: number | null;
  allocatable_memory_b: number | null;
  capacity_cpu_m: number | null;
  capacity_memory_b: number | null;
}

/* Actions — mirrors backend/omnikrux/actions (pipeline.py PlanIn / PlanOut / ApplyOut, jobs.py JobOut, workloads.py Revision). */

export type ActionName = "edit" | "scale" | "restart" | "rollback" | "delete" | "cordon" | "uncordon" | "drain" | "evict";

/** What a change acts on; a null namespace is a cluster-scoped kind. */
export interface ActionTarget {
  cluster_id: string;
  kind_key: string;
  namespace: string | null;
  name: string;
}

/** The body of `POST /api/actions/plan`. */
export interface PlanRequest {
  action: ActionName;
  target: ActionTarget;
  params?: Record<string, unknown>;
}

/** The plan's cluster: what the dialog names, whatever is selected. */
export interface PlanCluster {
  id: string;
  name: string;
  provider: string;
  environment: string;
}

/** A change as the server worked it out; it is kept there 300 s and applied once, by id. */
export interface Plan {
  plan_id: string;
  action: ActionName;
  target: ActionTarget;
  /** The target's Kind on the plan's cluster, e.g. "Deployment". */
  kind: string;
  cluster: PlanCluster;
  title: string;
  summary: string[];
  warnings: string[];
  /** Non-empty: the plan can't be applied. */
  blocked: string[];
  /** Both sides rendered (and a Secret's values masked) by the server. */
  diff: { before: string; after: string } | null;
  /** The text to type before applying; null: no typing. */
  confirm_text: string | null;
  apply_label: string;
  expires_at: string;
}

/** The answer to `POST /api/actions/{plan_id}/apply`; `started`: a job carries on (`job_id`). */
export interface ApplyResult {
  outcome: "succeeded" | "started";
  message: string;
  job_id: string | null;
  audit_id: number;
}

/** A pod a job is held up by, e.g. one a PodDisruptionBudget protects for now. */
export interface JobBlocked {
  namespace: string;
  name: string;
  message: string;
}

export interface Job {
  id: string;
  action: string;
  state: "running" | "succeeded" | "failed" | "cancelled";
  message: string;
  total: number;
  done: number;
  blocked: JobBlocked[];
  started_at: string;
  finished_at: string | null;
}

/** One of a deployment's revisions (its ReplicaSets), newest first. */
export interface Revision {
  revision: number;
  created_at: string | null;
  images: string[];
  current: boolean;
}

/* Port-forwards — mirrors backend/omnikrux/portforward/manager.py ForwardIn / ForwardOut. */

export interface ForwardIn {
  cluster_id: string;
  namespace: string;
  kind: "pod" | "service";
  name: string;
  port: number;
}

export interface ForwardOut {
  id: string;
  cluster_id: string;
  cluster_name: string;
  provider: string;
  namespace: string;
  kind: "pod" | "service";
  name: string;
  remote_port: number;
  local_port: number;
  /** "127.0.0.1:30001": the listener is IPv4 only. */
  address: string;
  /** The pod the latest connection went to. */
  pod: string | null;
  state: "listening" | "error";
  /** Why it is in error, in the server's words. */
  message: string | null;
  connections: number;
  started_at: string;
}

/* The audit log — mirrors backend/omnikrux/audit/store.py AuditOut / AuditPage. */

export type AuditAction =
  | "edit"
  | "scale"
  | "restart"
  | "rollback"
  | "delete"
  | "cordon"
  | "uncordon"
  | "drain"
  | "evict"
  | "shell"
  | "debug_container"
  | "node_shell"
  | "port_forward"
  | "secret_reveal";

export type AuditOutcome = "started" | "succeeded" | "failed" | "ended" | "unknown";

export interface AuditRecord {
  id: number;
  started_at: string;
  finished_at: string | null;
  actor: string;
  action: AuditAction | string;
  cluster_id: string;
  cluster_name: string;
  provider: string;
  namespace: string | null;
  kind: string;
  name: string | null;
  outcome: AuditOutcome | string;
  message: string | null;
  diff: string | null;
  details: Record<string, unknown> | null;
}

export interface AuditPage {
  /** Newest first. */
  records: AuditRecord[];
  /** Pass as `before` for the next (older) page; null on the last. */
  next_before: number | null;
}
