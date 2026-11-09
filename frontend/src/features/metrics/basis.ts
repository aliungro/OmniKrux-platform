import type { NodeSize, ResourceRow } from "../../api/types";

export type Basis = "limit" | "request" | "node" | "allocatable";

/** The honest positive capacity to compare with, in preference order. */
export function usageBasis(
  row: ResourceRow,
  resource: "cpu" | "memory",
  nodeSize: NodeSize | null,
): { of: number; basis: Basis } | null {
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  const unit = resource === "cpu" ? "m" : "b";
  if (row.kind === "Node") {
    const of = row.columns[`allocatable_${resource}_${unit}`];
    return positive(of) ? { of, basis: "allocatable" } : null;
  }
  const limit = row.columns[`${resource}_limit_${unit}`];
  if (positive(limit)) return { of: limit, basis: "limit" };
  const request = row.columns[`${resource}_request_${unit}`];
  if (positive(request)) return { of: request, basis: "request" };
  const of = resource === "cpu" ? nodeSize?.cpu_m : nodeSize?.memory_b;
  return positive(of) ? { of, basis: "node" } : null;
}
