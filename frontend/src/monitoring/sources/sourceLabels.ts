import type { SourceOut, SourceType } from "../api/types";

export function sourceTypeLabel(type: SourceType): "Prometheus-compatible" | "Loki" | "Alertmanager" {
  if (type === "alertmanager") return "Alertmanager";
  return type === "loki" ? "Loki" : "Prometheus-compatible";
}

/** The name a source gets when none is typed: its tool, then where it is. */
export function autoTypeName(type: SourceType): string {
  return type === "alertmanager" ? "Alertmanager" : type === "loki" ? "Loki" : "Prometheus";
}

/** The example in the address field, per type. */
export const ADDRESS_EXAMPLE: Record<SourceType, string> = {
  prometheus: "http://prometheus.example:9090",
  loki: "http://prometheus.example:9090",
  alertmanager: "http://alertmanager.example:9093",
};

/** Whether queries can run on a source of this type: an Alertmanager holds alerts, not metrics or logs. */
export function isQueryable(type: SourceType): type is "prometheus" | "loki" {
  return type === "prometheus" || type === "loki";
}

/** Where a source is reached: its address, or `<cluster> · <namespace>/<service>`. */
export function whereLabel(source: SourceOut): string {
  if (source.reach === "url") return source.url ?? "";
  const cluster = source.cluster_name ?? source.cluster_id ?? "cluster";
  return `${cluster} · ${source.namespace ?? ""}/${source.service ?? ""}`;
}
