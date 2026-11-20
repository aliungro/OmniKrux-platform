import type { SourceOut, SourceType } from "../api/types";

export function sourceTypeLabel(type: SourceType): "Prometheus-compatible" | "Loki" {
  return type === "loki" ? "Loki" : "Prometheus-compatible";
}

/** Where a source is reached: its address, or `<cluster> · <namespace>/<service>`. */
export function whereLabel(source: SourceOut): string {
  if (source.reach === "url") return source.url ?? "";
  const cluster = source.cluster_name ?? source.cluster_id ?? "cluster";
  return `${cluster} · ${source.namespace ?? ""}/${source.service ?? ""}`;
}
