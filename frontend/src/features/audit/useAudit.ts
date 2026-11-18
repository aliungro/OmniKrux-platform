import { useInfiniteQuery } from "@tanstack/react-query";
import { getJson } from "../../api/http";
import type { AuditPage } from "../../api/types";

export interface AuditFilters {
  /** A cluster id; "" for every cluster. */
  cluster: string;
  /** An action name (`scale`, `port_forward`, ...); "" for every action. */
  action: string;
  /** Matched by the server against cluster, namespace, kind, name, actor, action, message and details. */
  text: string;
  /** An empty value shows all activity. */
  outcome: "" | "failed";
}

export const NO_AUDIT_FILTER: AuditFilters = { cluster: "", action: "", text: "", outcome: "" };

export const AUDIT_PAGE_SIZE = 100;

export function auditQueryKey(filters: AuditFilters) {
  return ["audit", filters.cluster, filters.action, filters.text.trim(), filters.outcome] as const;
}

function path(filters: AuditFilters, before: number | undefined): string {
  const q = new URLSearchParams();
  if (filters.cluster) q.set("cluster", filters.cluster);
  if (filters.action) q.set("action", filters.action);
  if (filters.text.trim()) q.set("q", filters.text.trim());
  if (filters.outcome) q.set("outcome", filters.outcome);
  if (before !== undefined) q.set("before", String(before));
  q.set("limit", String(AUDIT_PAGE_SIZE));
  return `/api/audit?${q.toString()}`;
}

/**
 * The audit log, newest first, a page at a time: each older page continues from the previous page's
 * `next_before`. Another filter starts again from the newest (never showing the last filter's rows
 * as this one's). The query key starts with "audit", which a change or a port-forward invalidates.
 */
export function useAudit(filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: auditQueryKey(filters),
    queryFn: ({ pageParam, signal }) => getJson<AuditPage>(path(filters, pageParam), signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
    retry: false,
  });
}
