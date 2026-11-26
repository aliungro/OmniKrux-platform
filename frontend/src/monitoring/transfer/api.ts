// The transfer routes: exporting, Grafana connections, importing and "Update from source"
// (`/api/monitoring/export`, `/grafana/*`, `/import/*`, `/dashboards/{id}/origin` and
// `/dashboards/{id}/update-from-source*`). Mirrors `backend/omnikrux/monitoring/transfer/`. Its own
// `fetch`: every refusal is `detail = {code, message, key, problems}` and the review screens need
// the code and the key. Loaded only with the lazy Monitoring pages.
//
// Anything that can hold a secret or a file's text is a plain async call, never `useQuery` and
// never a TanStack mutation (a mutation keeps its `variables`): `createGrafana`, `updateGrafana`,
// `testNewGrafana`, `newGrafanaDashboards`, `previewImport`, `commitImport`, `previewUpdate` and
// `applyUpdate`. Call them, then `invalidateMonitoring(client)` where data changed. A token
// therefore never becomes a query key or a cache entry.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { NETWORK_MESSAGE, UNREADABLE_ANSWER } from "../api/query";
import { useMonitoringMutation } from "../api/hooks";
import type { ProjectKind, Reach } from "../api/types";
import type { AlertChangeOut } from "../alerts/api";
import type { DashboardOut } from "../dashboards/api";
import type { OwnerKind, Problem } from "../dashboards/schema";

const BASE = "/api/monitoring";
const enc = encodeURIComponent;

// --- Words of the model ----------------------------------------------------------------------

export type TransferErrorCode =
  | "invalid_input" | "unknown_format" | "too_large" | "not_found" | "wrong_target" | "unlinked_source" | "changed"
  | "name_taken" | "not_importable" | "grafana" | "source_changed" | "no_origin" | "read_only" | "version_conflict"
  | "not_imported" | "not_updated";

export type ExportKind = "dashboard" | "project" | "group";
export type GrafanaAuth = "none" | "basic" | "bearer";
export type ImportFormat = "omnikrux_dashboard" | "omnikrux_project" | "omnikrux_group" | "grafana" | "grafana_instance";
export type OriginKind = "omnikrux" | "grafana";
export type OriginVia = "file" | "paste" | "grafana";

// --- Export and Grafana connections ----------------------------------------------------------

export interface ExportOut {
  file_name: string;
  export: Record<string, unknown>;
  dashboards: number;
  sources: number;
  alerts: number;
}

/** A sign-in as entered; the secrets are write-only. */
export interface GrafanaAuthIn {
  type?: GrafanaAuth;
  username?: string | null;
  password?: string | null;
  token?: string | null;
}

export interface GrafanaIn {
  name?: string | null;
  reach: Reach;
  url?: string | null;
  cluster_id?: string | null;
  namespace?: string | null;
  service?: string | null;
  port?: string | null;
  scheme?: "http" | "https";
  path_prefix?: string;
  auth?: GrafanaAuthIn;
}

/** Every field optional; a field left out keeps what is stored (`auth.type` left out keeps the sign-in). */
export interface GrafanaPatch {
  name?: string | null;
  reach?: Reach | null;
  url?: string | null;
  cluster_id?: string | null;
  namespace?: string | null;
  service?: string | null;
  port?: string | null;
  scheme?: "http" | "https" | null;
  path_prefix?: string | null;
  auth?: GrafanaAuthIn | null;
}

export interface GrafanaAuthOut {
  type: GrafanaAuth;
  username: string | null;
  has_password: boolean;
  has_token: boolean;
}

export interface GrafanaOut {
  id: string;
  name: string;
  reach: Reach;
  url: string | null;
  cluster_id: string | null;
  cluster_name: string | null;
  namespace: string | null;
  service: string | null;
  port: string | null;
  scheme: "http" | "https";
  path_prefix: string;
  auth: GrafanaAuthOut;
  dashboards_imported: number;
  /** The name of another connection that reaches this same Grafana (its target only). */
  same_as?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GrafanaTestOut {
  ok: boolean;
  version: string | null;
  message: string | null;
  dashboards: number | null;
  /** After a good test: a saved connection that already reaches this Grafana. */
  same_as?: string | null;
}

export interface GrafanaDashboardOut {
  uid: string;
  title: string;
  folder: string | null;
  tags: string[];
}

export interface GrafanaDashboardsOut {
  items: GrafanaDashboardOut[];
  truncated: boolean;
}

// --- Import ----------------------------------------------------------------------------------

/** A file's text or pasted text (up to 10 MB; a plain call, never a mutation). */
export interface TextInput {
  kind: "text";
  text: string;
  file_name?: string | null;
  via: "file" | "paste";
}

/** Dashboards of a Grafana: a saved connection (`grafana_id`) or one as entered (`connection`). */
export interface GrafanaInput {
  kind: "grafana";
  grafana_id?: string | null;
  connection?: GrafanaIn | null;
  uids: string[];
}

export type ImportInput = TextInput | GrafanaInput;

export interface TargetIn {
  kind: OwnerKind;
  id: string;
}

export interface NewGroupIn {
  name: string;
  project_ids: string[];
}

export interface ImportPreviewIn {
  input: ImportInput;
  target?: TargetIn | null;
  /** The review's mapping so far: its "Leave its panels out" choices change what the preview lists. */
  mapping?: MappingIn[];
}

export interface SkippedOut {
  where: string;
  what: string;
  reason: string;
}

export interface SourceRefOut {
  key: string;
  type: "prometheus" | "loki";
  type_guessed: boolean;
  name: string;
  detail: string | null;
  suggestion: string | null;
  leave_out: boolean;
  reason: string;
}

export interface BundleSourceOut {
  key: string;
  name: string;
  /** An Alertmanager the exported project linked is listed; no panel reads it. */
  type: "prometheus" | "loki" | "alertmanager";
  where: string;
  filter: string | null;
  auth: string;
}

export interface BundleInfoOut {
  kind: "project" | "group";
  name: string;
  project_kind: ProjectKind | null;
  cluster: string | null;
  sources: BundleSourceOut[];
  projects: string[];
}

export interface PreviewDashboardOut {
  key: string;
  title: string;
  suggested_title: string;
  title_taken: boolean;
  panels: number;
  alerts: number;
  skipped: SkippedOut[];
  problems: Problem[];
  importable: boolean;
  digest: string;
}

export interface ImportPreviewOut {
  format: ImportFormat;
  format_label: string;
  target_kinds: OwnerKind[];
  suggested_target: TargetIn | null;
  bundle: BundleInfoOut | null;
  sources: SourceRefOut[];
  dashboards: PreviewDashboardOut[];
  skipped_total: number;
}

/** A source choice: a linked source, or `leave_out` to import without it. */
export interface MappingIn {
  key: string;
  source_id?: string | null;
  leave_out?: boolean;
}

export interface CommitDashboardIn {
  key: string;
  title: string;
  digest: string;
}

export interface ImportCommitIn {
  input: ImportInput;
  target?: TargetIn | null;
  new_group?: NewGroupIn | null;
  mapping?: MappingIn[];
  dashboards: CommitDashboardIn[];
}

export interface ImportedOut {
  key: string;
  id: string;
  title: string;
  owner_kind: OwnerKind;
  owner_id: string;
}

export interface ImportResultOut {
  dashboards: ImportedOut[];
  group_id: string | null;
  grafana_id: string | null;
  warnings: string[];
  alert_changes: AlertChangeOut[];
}

// --- Update from source ----------------------------------------------------------------------

export interface OriginOut {
  kind: OriginKind;
  via: OriginVia;
  label: string;
  grafana_id: string | null;
  grafana_name: string | null;
  grafana_uid: string | null;
  grafana_version: number | null;
  imported_at: string;
  imported_version: number;
  updated_at: string | null;
  updated_version: number | null;
  /** Whether the source can be read again without a file: its Grafana connection still exists. */
  can_refetch: boolean;
}

export interface UpdatePreviewIn {
  input?: TextInput | null;
  mapping?: MappingIn[];
}

export interface UpdateApplyIn {
  base_version: number;
  digest: string;
  input?: TextInput | null;
  mapping?: MappingIn[];
}

export interface UpdatePreviewOut {
  current_version: number;
  current: Record<string, unknown>;
  incoming: Record<string, unknown>;
  same: boolean;
  skipped: SkippedOut[];
  new_sources: SourceRefOut[];
  identity_warning: string | null;
  title_note: string | null;
  edited_since_import: boolean;
  source_label: string;
  source_version: number | null;
  previous_source_version: number | null;
  /** The source is at the version this dashboard last took: nothing new, whatever was changed here. */
  no_new_version?: boolean;
  digest: string;
}

// --- Errors ----------------------------------------------------------------------------------

/** A transfer request that didn't succeed; `message` is plain words for the reader. `code` is
 * "network" when nothing answered; `key` is the dashboard or source the refusal is about. */
export class TransferRequestError extends Error {
  readonly status: number;
  readonly code: TransferErrorCode | "network" | "grafana";
  readonly key: string | null;
  readonly problems: Problem[];
  readonly currentVersion: number | null;

  constructor(
    status: number,
    code: TransferErrorCode | "network" | "grafana",
    message: string,
    extra: { key?: string | null; problems?: Problem[]; currentVersion?: number | null } = {},
  ) {
    super(message);
    this.name = "TransferRequestError";
    this.status = status;
    this.code = code;
    this.key = extra.key ?? null;
    this.problems = extra.problems ?? [];
    this.currentVersion = extra.currentVersion ?? null;
  }
}

const CODES: readonly (TransferErrorCode | "grafana")[] = [
  "invalid_input", "unknown_format", "too_large", "not_found", "wrong_target", "unlinked_source", "changed", "name_taken",
  "not_importable", "grafana", "source_changed", "no_origin", "read_only", "version_conflict", "not_imported", "not_updated",
];

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

function problemsOf(raw: unknown): Problem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => (isObject(p) && typeof p.path === "string" && typeof p.message === "string" ? [{ path: p.path, message: p.message }] : []));
}

async function failureOf(res: Response): Promise<TransferRequestError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    if (isAbort(err)) throw err;
    return new TransferRequestError(res.status, "invalid_input", UNREADABLE_ANSWER);
  }
  const detail = isObject(body) ? body.detail : undefined;
  if (isObject(detail) && typeof detail.message === "string") {
    return new TransferRequestError(res.status, CODES.find((c) => c === detail.code) ?? "invalid_input", detail.message, {
      key: typeof detail.key === "string" ? detail.key : null,
      problems: problemsOf(detail.problems),
      currentVersion: typeof detail.current_version === "number" ? detail.current_version : null,
    });
  }
  if (typeof detail === "string" && detail) return new TransferRequestError(res.status, "invalid_input", detail);
  if (Array.isArray(detail)) {
    // FastAPI's own validation list (`[{loc, msg}]`), read through the same words as `http.ts`.
    const words = detail.flatMap((d) => (isObject(d) && typeof d.msg === "string" ? [d.msg] : []));
    if (words.length) return new TransferRequestError(res.status, "invalid_input", `The request was refused: ${words.join("; ")}.`);
  }
  return new TransferRequestError(res.status, "invalid_input", UNREADABLE_ANSWER);
}

/** One request; rejects with `TransferRequestError`, an abort passes through unchanged. A 204
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
    throw new TransferRequestError(0, "network", NETWORK_MESSAGE);
  }
  if (!res.ok) throw await failureOf(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new TransferRequestError(res.status, "invalid_input", UNREADABLE_ANSWER);
  }
}

// --- Routes ----------------------------------------------------------------------------------

export const exportItem = (kind: ExportKind, id: string) => request<ExportOut>("POST", "/export", { kind, id });

export const listGrafana = (signal?: AbortSignal) => request<GrafanaOut[]>("GET", "/grafana", undefined, signal);
export const createGrafana = (body: GrafanaIn) => request<GrafanaOut>("POST", "/grafana", body);
export const updateGrafana = (id: string, body: GrafanaPatch) => request<GrafanaOut>("PATCH", `/grafana/${enc(id)}`, body);
export const deleteGrafana = (id: string) => request<void>("DELETE", `/grafana/${enc(id)}`);
export const testNewGrafana = (body: GrafanaIn) => request<GrafanaTestOut>("POST", "/grafana/test", body);
export const testGrafana = (id: string) => request<GrafanaTestOut>("POST", `/grafana/${enc(id)}/test`);
export const grafanaDashboards = (id: string, signal?: AbortSignal) =>
  request<GrafanaDashboardsOut>("GET", `/grafana/${enc(id)}/dashboards`, undefined, signal);
export const newGrafanaDashboards = (body: GrafanaIn, signal?: AbortSignal) =>
  request<GrafanaDashboardsOut>("POST", "/grafana/dashboards", body, signal);

export const previewImport = (body: ImportPreviewIn, signal?: AbortSignal) => request<ImportPreviewOut>("POST", "/import/preview", body, signal);
export const commitImport = (body: ImportCommitIn) => request<ImportResultOut>("POST", "/import/commit", body);

/** Null when the dashboard wasn't imported. */
export const getOrigin = (dashboardId: string, signal?: AbortSignal) =>
  request<OriginOut | null>("GET", `/dashboards/${enc(dashboardId)}/origin`, undefined, signal);
export const previewUpdate = (id: string, body: UpdatePreviewIn, signal?: AbortSignal) =>
  request<UpdatePreviewOut>("POST", `/dashboards/${enc(id)}/update-from-source/preview`, body, signal);
export const applyUpdate = (id: string, body: UpdateApplyIn) => request<DashboardOut>("POST", `/dashboards/${enc(id)}/update-from-source`, body);

// --- Hooks -----------------------------------------------------------------------------------

export const grafanaKey = ["monitoring", "grafana"] as const;

export const useGrafanaConnections = (): UseQueryResult<GrafanaOut[], Error> =>
  useQuery({ queryKey: grafanaKey, queryFn: ({ signal }) => listGrafana(signal) });

/** A saved connection's dashboards; a connection as entered is never a query (`newGrafanaDashboards`). */
export const useGrafanaDashboards = (id: string | null): UseQueryResult<GrafanaDashboardsOut, Error> =>
  useQuery({
    queryKey: ["monitoring", "grafana", id, "dashboards"],
    queryFn: ({ signal }) => grafanaDashboards(id as string, signal),
    enabled: id !== null,
    retry: false,
  });

/** Where an imported dashboard came from (null: it wasn't imported). `enabled` false for a ready-made view. */
export const useOrigin = (dashboardId: string, enabled = true): UseQueryResult<OriginOut | null, Error> =>
  useQuery({ queryKey: ["monitoring", "dashboard", dashboardId, "origin"], queryFn: ({ signal }) => getOrigin(dashboardId, signal), enabled });

/** Bodies without a secret or a file: removing a connection and exporting. */
export const useDeleteGrafana = () => useMonitoringMutation(deleteGrafana);
export const useExportItem = () => useMonitoringMutation((v: { kind: ExportKind; id: string }) => exportItem(v.kind, v.id));
