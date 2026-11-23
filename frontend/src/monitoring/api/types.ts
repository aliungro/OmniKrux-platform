// TypeScript mirrors of the backend's pydantic models for `/api/monitoring/*`, named as they are
// there. Secrets are write-only: they appear in the `*In` shapes and never in an `*Out`.

export type SourceType = "prometheus" | "loki" | "alertmanager";
export type Reach = "url" | "cluster";
export type AuthType = "none" | "basic" | "bearer" | "api_key" | "mtls";
export type ProjectKind = "kubernetes" | "docker" | "servers" | "custom";
export type FilterOrigin = "auto" | "user" | "none";
export type HealthState = "up" | "down" | "unknown";
export type Scheme = "http" | "https";
export type FoundType = "prometheus" | "loki" | "grafana" | "alertmanager";
export type FoundState = "reachable" | "unreachable" | "missing";
export type TreeColor = "aks" | "eks" | "gke" | "oke" | "kind" | "onprem" | "custom";

// --- Sources ---------------------------------------------------------------------------------

export interface AuthIn {
  type?: AuthType;
  username?: string | null;
  password?: string | null;
  token?: string | null;
  header_name?: string | null;
  api_key?: string | null;
  client_cert_pem?: string | null;
  client_key_pem?: string | null;
}

/** On a change, a missing `value` keeps the stored one. */
export interface HeaderIn {
  name: string;
  value?: string | null;
}

export interface SourceIn {
  name?: string | null;
  type: SourceType;
  reach: Reach;
  url?: string | null;
  cluster_id?: string | null;
  namespace?: string | null;
  service?: string | null;
  port?: string | null;
  scheme?: Scheme;
  path_prefix?: string;
  auth?: AuthIn;
  headers?: HeaderIn[];
  ca_pem?: string | null;
}

/** Every field optional; a missing one keeps what is stored. `ca_pem: ""` removes the CA. */
export interface SourcePatch {
  name?: string | null;
  type?: SourceType | null;
  reach?: Reach | null;
  url?: string | null;
  cluster_id?: string | null;
  namespace?: string | null;
  service?: string | null;
  port?: string | null;
  scheme?: Scheme | null;
  path_prefix?: string | null;
  auth?: AuthIn | null;
  headers?: HeaderIn[] | null;
  ca_pem?: string | null;
}

export interface AuthOut {
  type: AuthType;
  username: string | null;
  header_name: string | null;
  has_password: boolean;
  has_token: boolean;
  has_api_key: boolean;
  has_client_key: boolean;
  has_client_cert: boolean;
}

export interface HeaderOut {
  name: string;
  has_value: boolean;
}

export interface ProjectRefOut {
  id: string;
  name: string;
}

export interface HealthOut {
  state: HealthState;
  message: string | null;
  version: string | null;
  checked_at: string | null;
}

export interface SourceOut {
  id: string;
  name: string;
  type: SourceType;
  reach: Reach;
  url: string | null;
  cluster_id: string | null;
  cluster_name: string | null;
  namespace: string | null;
  service: string | null;
  port: string | null;
  scheme: Scheme;
  path_prefix: string;
  auth: AuthOut;
  headers: HeaderOut[];
  has_ca: boolean;
  created_by_project_id: string | null;
  used_by: ProjectRefOut[];
  health: HealthOut;
  created_at: string;
  updated_at: string;
}

export interface TestOut {
  ok: boolean;
  version: string | null;
  message: string | null;
}

export interface MetricFieldOut {
  name: string;
  type: string | null;
  help: string | null;
  unit: string | null;
}

export interface FieldCatalogOut {
  metrics: MetricFieldOut[];
  labels: string[];
  truncated: boolean;
}

export interface AlertingOut {
  omnikrux_engine: boolean;
  tool_engine: "prometheus_rule" | "loki_ruler" | null;
  reason: string | null;
}

export interface SourceDeleteReviewOut {
  source_id: string;
  name: string;
  projects: ProjectRefOut[];
  token: string;
}

// --- Discovery and filter suggestions --------------------------------------------------------

/** The backend's `FoundToolOut`. */
export interface FoundTool {
  type: FoundType;
  state: FoundState;
  namespace: string | null;
  service: string | null;
  port: string | null;
  scheme: Scheme;
  version: string | null;
  message: string | null;
  existing_source_id: string | null;
  detail: string | null;
}

export interface DiscoveryOut {
  cluster_id: string;
  cluster_name: string;
  state: "ok" | "error";
  message: string | null;
  found: FoundTool[];
  checked_at: string;
}

/** Exactly one of `source_id` (a saved source) and `source` (one as entered). */
export interface SuggestIn {
  cluster_id?: string | null;
  kind: ProjectKind;
  source_id?: string | null;
  source?: SourceIn | null;
}

export interface SuggestOut {
  filter: string;
  origin: FilterOrigin;
  reason: string | null;
}

// --- Projects, groups, the tree --------------------------------------------------------------

export interface LinkOut {
  source_id: string;
  source_name: string;
  source_type: SourceType;
  filter: string;
  filter_origin: FilterOrigin;
  created_by_project: boolean;
}

export interface ProjectOut {
  id: string;
  name: string;
  kind: ProjectKind;
  cluster_id: string | null;
  cluster_name: string | null;
  cluster_provider: string | null;
  links: LinkOut[];
  group_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface GroupOut {
  id: string;
  name: string;
  project_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface GroupIn {
  name: string;
  project_ids: string[];
}

/** A missing field keeps what is stored. */
export interface GroupPatch {
  name?: string | null;
  project_ids?: string[] | null;
}

/** A saved dashboard, or (`ready_made`) a project's ready-made view, generated on request. */
export interface TreeDashboard {
  id: string;
  title: string;
  ready_made: boolean;
}

export interface TreeProject {
  id: string;
  name: string;
  kind: ProjectKind;
  cluster_id: string | null;
  color: TreeColor;
  dashboards: TreeDashboard[];
}

export interface TreeGroup {
  id: string;
  name: string;
  project_ids: string[];
  dashboards: TreeDashboard[];
}

export interface TreeOut {
  projects: TreeProject[];
  groups: TreeGroup[];
  source_count: number;
}

export interface ProjectDeleteReviewOut {
  project_id: string;
  name: string;
  sources_removed: ProjectRefOut[];
  sources_kept: { id: string; name: string; used_by: string[] }[];
  sources_unlinked: ProjectRefOut[];
  groups_left: ProjectRefOut[];
  /** Deleted with the project, by title; [] when it has none. */
  dashboards: DashboardRefOut[];
  token: string;
  /** Rules that go with the project; left out of the answer when none (read with `ruleRefs`). */
  alert_rules?: { id: string; name: string }[];
  /** Rules still applied in a cluster, removed first; left out when none. */
  cluster_rules?: { id: string; name: string }[];
}

/** A dashboard an owner's deletion takes with it. */
export interface DashboardRefOut {
  id: string;
  title: string;
  versions: number;
}

/** What deleting a group would do: the dashboards it takes (its projects stay). A group with
 * dashboards deletes only with this `token`. */
export interface GroupDeleteReviewOut {
  group_id: string;
  name: string;
  dashboards: DashboardRefOut[];
  token: string;
  alert_rules?: { id: string; name: string }[];
  cluster_rules?: { id: string; name: string }[];
}

/** Exactly one of `source_id` (a saved source) and `source` (a new one). */
export interface SetupSourceIn {
  source_id?: string | null;
  source?: SourceIn | null;
  filter?: string;
  origin?: FilterOrigin;
}

export interface SetupIn {
  name: string;
  kind: ProjectKind;
  cluster_id?: string | null;
  sources?: SetupSourceIn[];
}

// --- Queries ---------------------------------------------------------------------------------

export type QueryErrorCode =
  | "not_found" | "not_linked" | "bad_request" | "bad_query"
  | "unreachable" | "timeout" | "unauthorized" | "too_large" | "tool_error";

/** One query on one source. With `project_id` the project's filter is added to every selector;
 * every project or group view sends it. Times and the step are seconds. */
export interface QueryRequest {
  source_id: string;
  project_id?: string | null;
  kind: "instant" | "range";
  query: string;
  time?: number | null;
  start?: number | null;
  end?: number | null;
  step?: number | null;
  limit?: number | null;
  direction?: "backward" | "forward";
}

export interface Series {
  labels: Record<string, string>;
  /** Unix seconds and the value; a value that isn't a finite number is null. */
  points: [number, number | null][];
}

export interface Stream {
  labels: Record<string, string>;
  /** Nanosecond timestamp (as the tool sends it) and the log line. */
  entries: [string, string][];
}

export interface QueryResponse {
  result_type: "matrix" | "vector" | "scalar" | "streams";
  series: Series[];
  streams: Stream[];
  warnings: string[];
  truncated: boolean;
  source_id: string;
  source_name: string;
  source_type: SourceType;
  project_id: string | null;
  applied_filter: string;
  /** The text actually sent to the tool, after the filter. */
  query: string;
  took_ms: number;
}
