// The install routes (`/api/monitoring/install/*`): whether the pinned tools are here, a cluster's
// monitoring tools read live, the install and uninstall reviews and the review of the contact
// points in OmniKrux's own Alertmanager (server-built plans, applied through the actions routes),
// and the files and probes for Docker hosts and servers. Mirrors
// `backend/omnikrux/monitoring/install/api.py`, `generate.py` and `probe.py`.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getJson, postJson } from "../../api/http";
import type { Plan } from "../../api/types";
import type { FoundTool } from "../api/types";

const BASE = "/api/monitoring/install";
const enc = encodeURIComponent;

/** What can be installed: metrics (Prometheus, Alertmanager and the exporters) and logs (Loki and Alloy). */
export type Component = "metrics" | "logs";

export type InstallState = "installing" | "installed" | "failed" | "cancelled" | "uninstalling";

/** The tools reachable at an address: the three a probe and the generated files know. */
export type ToolType = "prometheus" | "alertmanager" | "loki";

// --- Tools and settings ----------------------------------------------------------------------

export interface ChartOut {
  key: string;
  version: string;
  app_version: string;
}

/** Whether OmniKrux can install here (its pinned Helm and chart archives); `message` says why not. */
export interface ToolsOut {
  available: boolean;
  message: string | null;
  helm_version: string | null;
  charts: ChartOut[];
}

/** A component's resources; a field left out keeps the value of the settings it updates. */
export interface ResourcesIn {
  cpu_request?: string | null;
  memory_request?: string | null;
  memory_limit?: string | null;
}

/** What the user can set; a field left out (or null) keeps the record's value, else the default. */
export interface InstallSettingsIn {
  namespace?: string | null;
  retention_days?: number | null;
  persist?: boolean | null;
  prometheus_storage?: string | null;
  loki_storage?: string | null;
  alertmanager_storage?: string | null;
  prometheus?: ResourcesIn | null;
  alertmanager?: ResourcesIn | null;
  loki?: ResourcesIn | null;
  alloy?: ResourcesIn | null;
}

export interface ResourcesOut {
  cpu_request: string;
  memory_request: string;
  memory_limit: string;
}

export interface InstallSettingsOut {
  namespace: string;
  retention_days: number;
  persist: boolean;
  prometheus_storage: string;
  loki_storage: string;
  alertmanager_storage: string;
  prometheus: ResourcesOut;
  alertmanager: ResourcesOut;
  loki: ResourcesOut;
  alloy: ResourcesOut;
}

/** A setting that doesn't fit, shown beside its field (`field` is its name, e.g. `prometheus.memory_limit`). */
export interface SettingProblemOut {
  field: string;
  message: string;
}

export interface FactsOut {
  default_storage_class: string | null;
  kube_version: string;
}

// --- The install and uninstall reviews -------------------------------------------------------

export interface InstallPlanIn {
  cluster_id: string;
  components: Component[];
  settings?: InstallSettingsIn | null;
  project_id?: string | null;
}

/** The install review and the settings it was made with; problems block the plan. */
export interface InstallPlanOut {
  plan: Plan;
  settings: InstallSettingsOut;
  problems: SettingProblemOut[];
  facts: FactsOut;
}

export interface UninstallPlanIn {
  delete_data?: boolean;
}

// --- A cluster's tools -----------------------------------------------------------------------

/** How OmniKrux's contact points stand in its own Alertmanager. */
export interface ContactsOut {
  state: "none" | "in_sync" | "needs_review" | "failed";
  message: string | null;
  applied_at: string | null;
  contact_points: number;
  rules: number;
}

/** The contact points' review, or `done` when what is applied is what OmniKrux wants. */
export type ContactsSyncOut = { kind: "review"; plan: Plan } | { kind: "done"; contacts: ContactsOut };

export interface SourceRefOut {
  id: string;
  name: string;
}

export interface InstallOut {
  namespace: string;
  components: Component[];
  settings: InstallSettingsOut;
  state: InstallState;
  message: string | null;
  job_id: string | null;
  /** Chart key → the version installed. */
  charts: Record<string, string>;
  /** Chart key → the version this OmniKrux ships. */
  shipped: Record<string, string>;
  update_available: boolean;
  sources: Record<ToolType, SourceRefOut | null>;
  contacts: ContactsOut;
}

export interface WorkloadOut {
  kind: string;
  name: string;
  label: string;
  ready: number;
  desired: number;
  why: string | null;
}

export interface ReleaseOut {
  release: string;
  label: string;
  chart: string;
  version: string | null;
  /** Helm's status, or "missing" when Helm has no record of it. */
  status: string;
  revision: number | null;
  deployed_at: string | null;
  workloads: WorkloadOut[];
}

/** A cluster's tools, read live at `checked_at`; a read that failed gives `problem` and no releases. */
export interface InstallStatusOut {
  cluster_id: string;
  cluster_name: string;
  tools: ToolsOut;
  install: InstallOut | null;
  releases: ReleaseOut[];
  /** Prometheus, Loki and Alertmanager the user runs elsewhere in the cluster. */
  others: FoundTool[];
  checked_at: string;
  problem: string | null;
}

// --- Docker hosts and servers ----------------------------------------------------------------

export interface GenerateIn {
  kind: "docker" | "servers";
  address: string;
  retention_days?: number;
  servers?: string[];
}

export interface GeneratedFile {
  name: string;
  content: string;
  executable: boolean;
}

export interface GeneratedOut {
  kind: "docker" | "servers";
  files: GeneratedFile[];
  urls: Partial<Record<ToolType, string>>;
  ports: number[];
}

export interface ProbeIn {
  tools: { type: ToolType; url: string }[];
}

export interface ProbeResultOut {
  type: ToolType;
  url: string;
  ok: boolean;
  version: string | null;
  message: string | null;
}

export interface ProbeOut {
  results: ProbeResultOut[];
}

// --- Routes ----------------------------------------------------------------------------------

export const installTools = () => getJson<ToolsOut>(`${BASE}/tools`);
export const installStatus = (clusterId: string) => getJson<InstallStatusOut>(`${BASE}/clusters/${enc(clusterId)}`);
export const planInstall = (body: InstallPlanIn) => postJson<InstallPlanOut>(`${BASE}/plan`, body);
export const planUninstall = (clusterId: string, body: UninstallPlanIn = {}) =>
  postJson<Plan>(`${BASE}/clusters/${enc(clusterId)}/uninstall/plan`, body);
export const syncContacts = (clusterId: string) => postJson<ContactsSyncOut>(`${BASE}/clusters/${enc(clusterId)}/contacts/sync`);
/** Nothing is stored or audited. */
export const generateFiles = (body: GenerateIn) => postJson<GeneratedOut>(`${BASE}/generate`, body);
/** Nothing is stored or audited. */
export const probeTools = (body: ProbeIn, signal?: AbortSignal) => postJson<ProbeOut>(`${BASE}/probe`, body, signal ? { signal } : {});

// --- Hooks -----------------------------------------------------------------------------------

export const installKeys = {
  tools: ["monitoring", "install", "tools"] as const,
  status: (clusterId: string) => ["monitoring", "install", "status", clusterId] as const,
};

export const useInstallTools = (): UseQueryResult<ToolsOut> => useQuery({ queryKey: installKeys.tools, queryFn: () => installTools() });

/** A cluster's tools, read live; none read while `clusterId` is null. */
export const useInstallStatus = (clusterId: string | null, opts: { refetchInterval?: number } = {}): UseQueryResult<InstallStatusOut> =>
  useQuery({
    queryKey: installKeys.status(clusterId ?? ""),
    queryFn: () => installStatus(clusterId as string),
    enabled: clusterId !== null,
    ...(opts.refetchInterval === undefined ? {} : { refetchInterval: opts.refetchInterval }),
  });
