// The dashboard routes (`/api/monitoring/dashboards*`, ready-made views, `/query/batch`,
// `/label-values`), their hooks, and the mutation that re-reads what a dashboard change touches.
// Its own `fetch`: every refusal here is `detail = {code, message, problems?, current_version?}`,
// which M1's `HttpError` would reduce to its status. Only dashboard code imports this module.

import {
  useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationResult, type UseQueryResult,
} from "@tanstack/react-query";
import { NETWORK_MESSAGE, UNREADABLE_ANSWER } from "../api/query";
import type { QueryErrorCode, QueryRequest, QueryResponse } from "../api/types";
import type { AlertChangeOut } from "../alerts/api";
import type { DashboardSpec, OwnerKind, Problem } from "./schema";

const BASE = "/api/monitoring";
const enc = encodeURIComponent;

// --- Shapes (mirrors of the backend's models) --------------------------------------------------

export type DashboardErrorCode =
  | "invalid_dashboard" | "version_conflict" | "name_taken" | "not_found" | "unknown_owner" | "read_only" | "bad_request";
export type ReadyKey = "cluster" | "nodes" | "namespaces" | "workloads" | "pods" | "logs";
export type ReadyNeed = "kube_state" | "cadvisor" | "node_exporter";
export type VersionOrigin = "created" | "copied" | "saved" | "restored" | "imported" | "updated";

export interface DashboardOut {
  id: string;
  owner_kind: OwnerKind;
  owner_id: string;
  /** Empty when the owner is gone. */
  owner_name: string;
  title: string;
  /** 0 for a ready-made view. */
  version: number;
  spec: DashboardSpec;
  ready_made: boolean;
  /** Null for a ready-made view (generated on request, never stored). */
  created_at: string | null;
  updated_at: string | null;
  /** What a save did to the rules of its panels in their tools (empty when nothing changed there). */
  alert_changes: AlertChangeOut[];
}

export interface DashboardSummaryOut {
  id: string;
  owner_kind: OwnerKind;
  owner_id: string;
  title: string;
  version: number;
  panel_count: number;
  updated_at: string | null;
  ready_made: boolean;
}

export interface VersionOut {
  version: number;
  saved_at: string;
  title: string;
  panel_count: number;
  origin: VersionOrigin;
  restored_from: number | null;
  copied_from: string | null;
}

export interface VersionDetailOut {
  version: number;
  saved_at: string;
  spec: DashboardSpec;
}

/** `checked` false: the metric names couldn't be read (`check_message` says why), and
 * `missing` and `notes` are empty, never guessed. */
export interface ReadyMadeOut {
  key: ReadyKey;
  id: string;
  title: string;
  description: string;
  missing: ReadyNeed[];
  notes: string[];
  checked: boolean;
  check_message: string | null;
  /** The Prometheus a Prometheus view reads (the one that holds its metrics); null for the Logs overview. */
  source_name: string | null;
}

export interface LabelValuesOut {
  /** Sorted, at most 1000. */
  values: string[];
  /** The label has more values than shown. */
  truncated: boolean;
}

/** What an empty answer is checked against: the query that ran, on its project, over its range
 * (seconds). Prometheus sends the query's metric names, Loki its stream selector. */
export interface WhyEmptyIn {
  source_id: string;
  project_id: string;
  query: string;
  start: number;
  end: number;
  metrics?: string[];
  selector?: string | null;
}

export type WhyEmptyReason =
  | "missing_metric" | "nothing_matched" | "missing_labels" | "no_streams" | "older_lines" | "filtered_out" | "unknown";

/** Why it was empty, in OmniKrux's words; `message` is null exactly for `unknown` (nothing proved). */
export interface WhyEmptyOut {
  reason: WhyEmptyReason;
  message: string | null;
}

export interface BatchError {
  code: QueryErrorCode;
  message: string;
  /** The HTTP status the same query alone would have answered. */
  status: number;
}

export interface BatchItemOut {
  ok: boolean;
  response: QueryResponse | null;
  error: BatchError | null;
}

// --- Errors -----------------------------------------------------------------------------------

/** A dashboard, batch or label-values request that didn't succeed; `message` is plain words for
 * the reader (the server's own, or what to check when nothing answered). */
export class DashboardRequestError extends Error {
  readonly status: number;
  /** A dashboard route's code, a query route's code, or "network" when nothing answered. */
  readonly code: DashboardErrorCode | QueryErrorCode | "network";
  readonly problems: Problem[];
  readonly currentVersion: number | null;

  constructor(
    status: number,
    code: DashboardErrorCode | QueryErrorCode | "network",
    message: string,
    problems: Problem[] = [],
    currentVersion: number | null = null,
  ) {
    super(message);
    this.name = "DashboardRequestError";
    this.status = status;
    this.code = code;
    this.problems = problems;
    this.currentVersion = currentVersion;
  }
}

const CODES: readonly (DashboardErrorCode | QueryErrorCode)[] = [
  "invalid_dashboard", "version_conflict", "name_taken", "not_found", "unknown_owner", "read_only", "bad_request",
  "not_linked", "bad_query", "unreachable", "timeout", "unauthorized", "too_large", "tool_error",
];

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

function problemsOf(raw: unknown): Problem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => (isObject(p) && typeof p.path === "string" && typeof p.message === "string" ? [{ path: p.path, message: p.message }] : []));
}

async function failureOf(res: Response): Promise<DashboardRequestError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    if (isAbort(err)) throw err;
    return new DashboardRequestError(res.status, "bad_request", UNREADABLE_ANSWER);
  }
  const detail = isObject(body) ? body.detail : undefined;
  if (isObject(detail) && typeof detail.message === "string") {
    const code = CODES.find((c) => c === detail.code) ?? "bad_request";
    const current = typeof detail.current_version === "number" ? detail.current_version : null;
    return new DashboardRequestError(res.status, code, detail.message, problemsOf(detail.problems), current);
  }
  if (typeof detail === "string" && detail) return new DashboardRequestError(res.status, "bad_request", detail);
  if (Array.isArray(detail)) {
    // FastAPI's own validation list (`[{loc, msg}]`); these routes read their input themselves.
    const words = detail.flatMap((d) => (isObject(d) && typeof d.msg === "string" ? [d.msg] : []));
    if (words.length) return new DashboardRequestError(res.status, "bad_request", `The request was refused: ${words.join("; ")}.`);
  }
  return new DashboardRequestError(res.status, "bad_request", UNREADABLE_ANSWER);
}

/** One request; rejects with `DashboardRequestError`, an abort passes through unchanged. A 204
 * resolves to undefined. */
async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new DashboardRequestError(0, "network", NETWORK_MESSAGE);
  }
  if (!res.ok) throw await failureOf(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new DashboardRequestError(res.status, "bad_request", UNREADABLE_ANSWER);
  }
}

// --- Routes -----------------------------------------------------------------------------------

export const getDashboard = (id: string, signal?: AbortSignal) => request<DashboardOut>("GET", `/dashboards/${enc(id)}`, undefined, signal);

export function listDashboards(owner?: { kind: OwnerKind; id: string }): Promise<DashboardSummaryOut[]> {
  const query = owner ? `?owner_kind=${enc(owner.kind)}&owner_id=${enc(owner.id)}` : "";
  return request("GET", `/dashboards${query}`);
}

export const createDashboard = (body: { owner_kind: OwnerKind; owner_id: string; spec: DashboardSpec }) =>
  request<DashboardOut>("POST", "/dashboards", body);

/** 409 `version_conflict` (with `currentVersion`) when another save landed since `baseVersion`. */
export const saveDashboard = (id: string, baseVersion: number, spec: DashboardSpec, origin: "editor" | "explore" = "editor") =>
  request<DashboardOut>("PUT", `/dashboards/${enc(id)}`, { base_version: baseVersion, spec, origin });

export const deleteDashboard = (id: string, version: number) =>
  request<void>("DELETE", `/dashboards/${enc(id)}?version=${enc(String(version))}`);

/** Newest first. Ready-made ids (`ready:…`) answer 404: never ask for their versions. */
export const listVersions = (id: string) => request<VersionOut[]>("GET", `/dashboards/${enc(id)}/versions`);

export const getVersion = (id: string, v: number) =>
  request<VersionDetailOut>("GET", `/dashboards/${enc(id)}/versions/${enc(String(v))}`);

export const restoreVersion = (id: string, v: number, baseVersion: number) =>
  request<DashboardOut>("POST", `/dashboards/${enc(id)}/versions/${enc(String(v))}/restore`, { base_version: baseVersion });

/** `title` null or left out: the source's title, made unique for the owner. */
export const copyDashboard = (body: { from_id: string; owner_kind: OwnerKind; owner_id: string; title?: string | null }) =>
  request<DashboardOut>("POST", "/dashboards/copy", body);

export const readyMade = (projectId: string) => request<ReadyMadeOut[]>("GET", `/projects/${enc(projectId)}/ready-made`);

/** One label's values through the project's filter. `match` must already have its variables
 * substituted (`interpolate`); an empty one is left out. Times are seconds. */
export function labelValues(
  p: { sourceId: string; projectId: string; label: string; match: string; start: number; end: number },
  signal?: AbortSignal,
): Promise<LabelValuesOut> {
  const params = new URLSearchParams({ source_id: p.sourceId, project_id: p.projectId, label: p.label });
  if (p.match.trim() !== "") params.set("match", p.match);
  params.set("start", String(p.start));
  params.set("end", String(p.end));
  return request("GET", `/label-values?${params.toString()}`, undefined, signal);
}

/** Every query in one request; each item succeeds or fails on its own, in the order sent. At
 * most 64 items (see `runRequests` in runPanel.ts for more). */
export async function runBatch(queries: QueryRequest[], signal?: AbortSignal): Promise<BatchItemOut[]> {
  const out = await request<{ results: BatchItemOut[] }>("POST", "/query/batch", { queries }, signal);
  return out.results;
}

/** Why a query that ran came back empty. A plain read: it changes nothing, so no mutation cache. */
export const whyEmpty = (body: WhyEmptyIn, signal?: AbortSignal) =>
  request<WhyEmptyOut>("POST", "/query/why-empty", body, signal);

// --- Hooks ------------------------------------------------------------------------------------

export const dashboardKey = (id: string) => ["monitoring", "dashboard", id] as const;
export const versionsKey = (id: string) => ["monitoring", "dashboard", id, "versions"] as const;
export const readyMadeKey = (projectId: string) => ["monitoring", "readyMade", projectId] as const;

export const useDashboard = (id: string): UseQueryResult<DashboardOut, DashboardRequestError> =>
  useQuery<DashboardOut, DashboardRequestError>({ queryKey: dashboardKey(id), queryFn: ({ signal }) => getDashboard(id, signal), retry: false });

/** A saved dashboard's versions. Never for a ready-made view: `ready:…` ids answer 404 here. */
export const useVersions = (id: string, enabled = true): UseQueryResult<VersionOut[], DashboardRequestError> =>
  useQuery<VersionOut[], DashboardRequestError>({ queryKey: versionsKey(id), queryFn: () => listVersions(id), enabled, retry: false });

export const useReadyMade = (projectId: string): UseQueryResult<ReadyMadeOut[], DashboardRequestError> =>
  useQuery<ReadyMadeOut[], DashboardRequestError>({ queryKey: readyMadeKey(projectId), queryFn: () => readyMade(projectId), retry: false });

export type LabelValuesParams = Parameters<typeof labelValues>[0];

/** A variable's values; `null` waits. */
export const useLabelValues = (p: LabelValuesParams | null): UseQueryResult<LabelValuesOut, DashboardRequestError> =>
  useQuery<LabelValuesOut, DashboardRequestError>({
    queryKey: ["monitoring", "labelValues", p],
    queryFn: ({ signal }) => labelValues(p as LabelValuesParams, signal),
    enabled: p !== null,
    retry: false,
  });

/**
 * Keys a dashboard change leaves alone: panel queries, label values, catalogs and empty reasons did not change, and
 * an alert's dry run answers for the alert as written in an open Alert tab, which a save doesn't change.
 */
function keepsData(key: readonly unknown[]): boolean {
  return key[0] === "monitoring"
    && (key[1] === "panel" || key[1] === "labelValues" || key[1] === "catalog" || key[1] === "why-empty"
      || (key[1] === "alerts" && key[2] === "dryRun"));
}

/**
 * After a dashboard change: re-reads Monitoring (tree, dashboards, versions, lists) and the audit
 * log, but not panel data or label values. `gone`: a dashboard just deleted, whose own reads are
 * left alone rather than asked again (they would only answer 404).
 */
export function refreshAfterDashboardChange(client: QueryClient, gone?: string): Promise<unknown> {
  return Promise.all([
    client.invalidateQueries({
      queryKey: ["monitoring"],
      predicate: (q) => !keepsData(q.queryKey) && !(gone !== undefined && q.queryKey[1] === "dashboard" && q.queryKey[2] === gone),
    }),
    client.invalidateQueries({ queryKey: ["audit"] }),
  ]);
}

/**
 * A dashboard change (create, save, delete, restore, copy). On success it re-reads Monitoring
 * (tree, dashboards, versions, lists) and the audit log, but not panel data or label values, so a
 * save doesn't re-run every panel. No dashboard body holds a secret, so TanStack may keep it.
 */
export function useDashboardMutation<V, R>(fn: (vars: V) => Promise<R>): UseMutationResult<R, DashboardRequestError, V> {
  const client = useQueryClient();
  return useMutation<R, DashboardRequestError, V>({
    mutationFn: fn,
    onSuccess: () => refreshAfterDashboardChange(client),
  });
}

export const ownerDashboardsKey = (owner: { kind: OwnerKind; id: string }) => ["monitoring", "dashboards", owner.kind, owner.id] as const;

/** An owner's saved dashboards, by title (ready-made views are not in this list). */
export const useOwnerDashboards = (owner: { kind: OwnerKind; id: string }): UseQueryResult<DashboardSummaryOut[], DashboardRequestError> =>
  useQuery<DashboardSummaryOut[], DashboardRequestError>({ queryKey: ownerDashboardsKey(owner), queryFn: () => listDashboards(owner), retry: false });
