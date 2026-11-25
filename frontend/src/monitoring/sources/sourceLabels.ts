import type { HealthOut, SourceOut, SourceType } from "../api/types";

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
  loki: "http://loki.example:3100",
  alertmanager: "http://alertmanager.example:9093",
};

/** Whether queries can run on a source of this type: an Alertmanager holds alerts, not metrics or logs. */
export function isQueryable(type: SourceType): type is "prometheus" | "loki" {
  return type === "prometheus" || type === "loki";
}

const TYPE_ORDER: Record<SourceType, number> = { prometheus: 0, loki: 1, alertmanager: 2 };

/** A project's sources in one order everywhere: Prometheus, Loki, Alertmanager, then by name. */
export function sortLinks<T extends { source_type: SourceType; source_name: string }>(links: readonly T[]): T[] {
  return [...links].sort((a, b) => TYPE_ORDER[a.source_type] - TYPE_ORDER[b.source_type] || a.source_name.localeCompare(b.source_name));
}

/** What a source's health reads as: a reading never taken is unknown, whatever its state says. */
export function stateWords(health: HealthOut | undefined, type: SourceType): string {
  const state = health && health.checked_at ? health.state : "unknown";
  if (state === "up") return "Up";
  if (state === "unknown") return "Not checked yet";
  return health?.answered ? `Answers, but not as ${autoTypeName(type)}` : "Can't be reached";
}

/** Where a source is reached: its address, or `<cluster> · <namespace>/<service>`. */
export function whereLabel(source: SourceOut): string {
  if (source.reach === "url") return source.url ?? "";
  const cluster = source.cluster_name ?? source.cluster_id ?? "cluster";
  return `${cluster} · ${source.namespace ?? ""}/${source.service ?? ""}`;
}
