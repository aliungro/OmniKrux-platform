// Status answers for the Monitoring tools tests.
import type { ContactsOut, InstallOut, InstallSettingsOut, InstallStatusOut, ReleaseOut, ToolsOut } from "./api";

export const SETTINGS: InstallSettingsOut = {
  namespace: "monitoring",
  retention_days: 15,
  persist: true,
  prometheus_storage: "20Gi",
  loki_storage: "10Gi",
  alertmanager_storage: "1Gi",
  prometheus: { cpu_request: "200m", memory_request: "1Gi", memory_limit: "2Gi" },
  alertmanager: { cpu_request: "20m", memory_request: "64Mi", memory_limit: "128Mi" },
  loki: { cpu_request: "100m", memory_request: "256Mi", memory_limit: "1Gi" },
  alloy: { cpu_request: "50m", memory_request: "128Mi", memory_limit: "256Mi" },
};

export const TOOLS: ToolsOut = {
  available: true,
  message: null,
  helm_version: "v3.16.2",
  charts: [
    { key: "kube-prometheus-stack", version: "66.2.1", app_version: "v0.78.1" },
    { key: "loki", version: "6.21.0", app_version: "3.2.1" },
    { key: "alloy", version: "0.9.2", app_version: "v1.4.3" },
  ],
};

export const CONTACTS: ContactsOut = { state: "none", message: null, applied_at: null, contact_points: 0, rules: 0 };

export const release = (over: Partial<ReleaseOut> = {}): ReleaseOut => ({
  release: "omnikrux-metrics",
  label: "Prometheus and Alertmanager",
  chart: "kube-prometheus-stack",
  version: "66.2.1",
  status: "deployed",
  revision: 1,
  deployed_at: "2026-11-24T10:00:00Z",
  workloads: [{ kind: "StatefulSet", name: "prometheus", label: "Prometheus", ready: 1, desired: 1, why: null }],
  ...over,
});

export const lokiRelease = (over: Partial<ReleaseOut> = {}): ReleaseOut =>
  release({
    release: "omnikrux-loki", label: "Loki", chart: "loki", version: "6.21.0",
    workloads: [{ kind: "StatefulSet", name: "loki", label: "Loki", ready: 1, desired: 1, why: null }],
    ...over,
  });

export const record = (over: Partial<InstallOut> = {}): InstallOut => ({
  namespace: "monitoring",
  components: ["metrics"],
  settings: SETTINGS,
  state: "installed",
  message: null,
  job_id: null,
  charts: { "kube-prometheus-stack": "66.2.1" },
  shipped: { "kube-prometheus-stack": "66.2.1" },
  update_available: false,
  sources: { prometheus: null, alertmanager: null, loki: null },
  contacts: CONTACTS,
  ...over,
});

/** A cluster's status as the fake serves it (without `tools`, which the fake adds). */
export const status = (over: Partial<Omit<InstallStatusOut, "tools">> = {}): Omit<InstallStatusOut, "tools"> => ({
  cluster_id: "c1",
  cluster_name: "kind-install",
  install: null,
  releases: [],
  others: [],
  checked_at: "2026-11-24T10:04:12",
  problem: null,
  ...over,
});
