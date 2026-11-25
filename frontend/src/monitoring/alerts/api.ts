// The alerts routes (`/api/monitoring/alerts/*`), their shapes, hooks and mutations. Its own
// `fetch`: the rule routes refuse with `detail = {code, message, field?, current_version?}`, the
// pipeline's sync answer with a plain `{"detail": "words"}`, contact points with a string or a
// validation list; one failure type reads all of them. Only alerts and dashboard code import this
// module; it stays out of the startup bundle.
//
// Contact point calls (create, update, test) carry secrets: they are plain functions, never
// `useMonitoringMutation`, because TanStack keeps a mutation's `variables`. Call them, then
// `refreshAlerts(client)`; the form clears its secret inputs after the call. No alerts change
// refetches an open dry run (`refreshAlerts`).

import { useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import type { QueryErrorCode } from "../api/types";
import type { Plan } from "../../api/types";
import { NETWORK_MESSAGE, UNREADABLE_ANSWER } from "../api/query";
import type { DashboardErrorCode, DashboardOut } from "../dashboards/api";
import type { Problem } from "../dashboards/schema";

const BASE = "/api/monitoring/alerts";
const enc = encodeURIComponent;

// --- Words of the model --------------------------------------------------------------------------

export type Engine = "omnikrux" | "tool";
export type ToolKind = "prometheus_rule" | "loki_ruler";
export type Severity = "critical" | "warning" | "info";
export type Op = "above" | "below";
export type Of = "each" | "total";
export type ScopeKind = "project" | "group";
export type Origin = "page" | "panel";
export type SourceType = "prometheus" | "loki";
export type Every = "30s" | "1m" | "5m";
export type TargetState = "ok" | "pending" | "firing" | "no_data" | "unreachable" | "error" | "paused" | "waiting" | "not_applied";
export type ToolState = "in_sync" | "needs_review" | "failed";
export type HistoryKind = "firing" | "resolved" | "cant_check" | "checking_again" | "error" | "applied" | "apply_failed" | "removed";
export type AlertChangeKind = "review" | "written" | "failed" | "removed" | "contacts";
export type ContactPointType = "slack" | "email" | "teams" | "pagerduty" | "webhook";

// --- Shapes (mirrors of the backend's models, named as they are) ---------------------------------

export interface RuleIn {
  name: string;
  scope: { kind: ScopeKind; id: string };
  /** `id` null: the scope's first source of the type (always so for a group). */
  source: { type: SourceType; id: string | null };
  expr: string;
  condition: { of: Of; op: Op; threshold: number; for: string; every: Every };
  severity: Severity;
  message: string;
  contact_point_ids: string[];
  engine: Engine;
  channel: { receiver: string; labels: Record<string, string> } | null;
}

export interface RuleSaveIn extends RuleIn {
  base_version: number;
}

export interface InstanceOut {
  labels: Record<string, string>;
  state: "pending" | "firing";
  active_since: string;
  fired_at: string | null;
  /** Null when the check read no number. */
  value: number | null;
  silenced: boolean;
  message: string | null;
}

export interface TargetOut {
  id: string;
  project_id: string;
  project_name: string;
  engine: Engine;
  tool: ToolKind | null;
  where: string;
  engine_note: string | null;
  /** "waiting" carries a `message` while a tool's rule is being brought up. */
  state: TargetState;
  state_since: string;
  last_eval_at: string | null;
  message: string | null;
  eval_expr: string;
  rule_text: string;
  tool_state: ToolState | null;
  tool_message: string | null;
  leaving: boolean;
  instances: InstanceOut[];
  /** The tool that holds (or may hold) a copy of the rule, whatever checks it now: a Loki group
   * or PrometheusRule left behind after a move to OmniKrux. Absent from older answers. */
  tool_copy?: ToolKind | null;
}

export interface PanelLinkOut {
  dashboard_id: string;
  dashboard_title: string;
  panel_id: string;
  panel_title: string;
}

export interface ContactPointRefOut {
  id: string;
  name: string;
  type: ContactPointType;
}

export interface RuleOut {
  id: string;
  name: string;
  scope: { kind: ScopeKind; id: string; name: string };
  source_type: SourceType;
  source_id: string | null;
  expr: string;
  condition: { of: Of; op: Op; threshold: number; for: string; every: string };
  severity: Severity;
  message: string;
  contact_points: ContactPointRefOut[];
  engine: Engine;
  channel: { receiver: string; labels: Record<string, string> } | null;
  paused: boolean;
  origin: Origin;
  panel: PanelLinkOut | null;
  state: TargetState;
  firing_since: string | null;
  targets: TargetOut[];
  /** A deleted rule still taking its targets out of their tools. */
  removing: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface AlertChangeOut {
  target_id: string;
  rule_id: string;
  rule_name: string;
  project_id: string;
  project_name: string;
  kind: AlertChangeKind;
  message: string | null;
  /** The tool the change is in; absent or null when unknown (a failed change reads as Loki's). */
  tool?: ToolKind | null;
  /** A `contacts` change: the cluster whose OmniKrux-installed Alertmanager needs a review (absent otherwise). */
  cluster_id?: string | null;
}

export interface RuleChangeOut {
  /** Null after a delete. */
  rule: RuleOut | null;
  changes: AlertChangeOut[];
}

export interface HistoryOut {
  at: string;
  kind: HistoryKind;
  project_name: string;
  labels: Record<string, string> | null;
  value: number | null;
  message: string | null;
}

export interface FiringOut {
  rule_id: string;
  rule_name: string;
  target_id: string;
  project_id: string;
  project_name: string;
  severity: Severity;
  since: string;
  instances: number;
  /** How many of the firing instances a silence mutes: they still fire, nobody is told. */
  silenced: number;
  summary: string;
  where: string;
}

export interface EngineOut {
  enabled: boolean;
  running: boolean;
  last_tick_at: string | null;
  rules: number;
  behind: number;
  note: string;
}

export interface OverviewOut {
  counts: { rules: number; firing: number; pending: number; cant_check: number; not_applied: number };
  firing: FiringOut[];
  by_project: Record<string, number>;
  by_group: Record<string, number>;
  engine: EngineOut;
}

export interface CapabilityOut {
  project_id: string;
  project_name: string;
  source_id: string | null;
  source_name: string | null;
  tool: ToolKind | null;
  reason: string | null;
  /** The source is one of the tools OmniKrux installed, with its own Alertmanager (the server always sends it). */
  installed_by_omnikrux?: boolean;
}

export interface TargetRefOut {
  target_id: string;
  project_name: string;
  cluster_name: string | null;
}

export interface RuleDeleteReviewOut {
  id: string;
  name: string;
  panel: PanelLinkOut | null;
  cluster_removals: TargetRefOut[];
  loki_removals: TargetRefOut[];
  token: string;
}

export interface AttachIn {
  dashboard_id: string;
  panel_id: string;
  base_version: number;
}

export interface AttachOut {
  dashboard: DashboardOut;
  rule: RuleOut;
}

export interface PanelAlertStateOut {
  rule_id: string;
  name: string;
  state: TargetState;
  since: string | null;
}

export interface ChannelsOut {
  alertmanager: { id: string; name: string } | null;
  channels: { receiver: string; labels: Record<string, string>; usable: boolean; reason: string | null }[];
  message: string | null;
}

/** A project or group delete review names its rules; an empty list is left out of the answer. */
export interface RuleRefOut {
  id: string;
  name: string;
}

/** Read `alert_rules` / `cluster_rules` of an owner's delete review: missing means none. */
export const ruleRefs = (list: RuleRefOut[] | undefined): RuleRefOut[] => list ?? [];

/** The answer to a sync: a plan to review and apply, or done (`target` null: it went). */
export type SyncOut = { kind: "review"; plan: Plan } | { kind: "done"; target: TargetOut | null };

export interface DryRunIn {
  scope: { kind: ScopeKind; id: string };
  source: { type: SourceType; id: string | null };
  expr: string;
  of: Of;
  op: Op;
  threshold: number;
  for: string;
  every: Every;
  /** 600 to 86400; the server's default is 21600 (6 hours). */
  window_seconds?: number;
  /** Up to 20 thresholds to count as well. */
  candidates?: number[];
  suggest?: boolean;
}

export interface PeriodOut {
  /** Seconds. */
  start: number;
  end: number;
  ongoing: boolean;
}

export interface DryRunProjectOut {
  project_id: string;
  project_name: string;
  fired: number;
  firing_now: boolean;
  periods: PeriodOut[];
  series: number;
  /** Set: this project's query failed, and it counted nothing. */
  error: { code: QueryErrorCode; message: string } | null;
}

export interface DryRunOut {
  /** Seconds. */
  start: number;
  end: number;
  step: number;
  fired: number;
  firing_now: boolean;
  periods: PeriodOut[];
  projects: DryRunProjectOut[];
  candidates: { threshold: number; fired: number }[];
  took_ms: number;
}

export interface ContactPointIn {
  name: string;
  type: ContactPointType;
  settings?: Record<string, unknown>;
  /** Secrets are write-only: they go in here and never come back. */
  secrets?: Record<string, string | null>;
}

/** Every field optional: settings merge onto the stored ones; a secret left out or `null` keeps
 * its stored value, `""` clears an optional one. `type` can't change. */
export interface ContactPointPatch {
  name?: string;
  type?: ContactPointType;
  settings?: Record<string, unknown>;
  secrets?: Record<string, string | null>;
}

export interface ContactPointOut {
  id: string;
  name: string;
  type: ContactPointType;
  settings: Record<string, unknown>;
  /** The names of the secrets that are set, never their values. */
  secrets_set: string[];
  summary: string;
  used_by: RuleRefOut[];
  last_delivery: { at: string; ok: boolean; message: string | null } | null;
  created_at: string;
  updated_at: string;
}

/** The PATCH answer: the contact point and what it changed in the rules' tools (a `contacts` review). */
export type ContactPointChangedOut = ContactPointOut & { alert_changes: AlertChangeOut[] };

/** The DELETE answer: what removing the contact point changed in the rules' tools. */
export interface ContactPointDeleteOut {
  alert_changes: AlertChangeOut[];
}

export interface ContactPointDeleteReviewOut {
  id: string;
  name: string;
  used_by: RuleRefOut[];
  token: string;
}

export interface ContactPointTestOut {
  ok: boolean;
  message: string;
}

export type SilenceWhereIn = { kind: "omnikrux" } | { kind: "alertmanager"; source_id: string };

export interface SilenceIn {
  where: SilenceWhereIn;
  matchers: string;
  /** Null or left out: now. */
  starts_at?: string | null;
  ends_at: string;
  comment: string;
}

export interface SilenceOut {
  id: string;
  where: { kind: "omnikrux" | "alertmanager"; source_id: string | null; source_name: string | null };
  matchers: string;
  starts_at: string;
  ends_at: string;
  comment: string;
  created_by: string;
  state: "active" | "pending" | "expired";
  /** Instances an OmniKrux silence matches now; null for an Alertmanager's. */
  affects: number | null;
}

export interface SilencesOut {
  silences: SilenceOut[];
  /** An Alertmanager that couldn't be read, in words; it never hides the others. */
  problems: { source_name: string; message: string }[];
}

export interface SilencePreviewOut {
  affects: number;
  rules: string[];
}

// --- Errors -----------------------------------------------------------------------------------

export type RuleErrorCode = "invalid_rule" | "rule_changed" | "not_found" | "unknown_scope" | "panel_rule" | "tool_rule";
export type AlertErrorCode = RuleErrorCode | DashboardErrorCode | QueryErrorCode | "invalid_silence" | "network";

const CODES: readonly AlertErrorCode[] = [
  "invalid_rule", "rule_changed", "not_found", "unknown_scope", "panel_rule", "tool_rule", "invalid_silence",
  "invalid_dashboard", "version_conflict", "name_taken", "unknown_owner", "read_only", "bad_request",
  "not_linked", "bad_query", "unreachable", "timeout", "unauthorized", "too_large", "tool_error",
];

/**
 * An alerts request that didn't succeed; `message` is plain words for the reader (the server's
 * own, or what to check when nothing answered). `code` "bad_request" when the server gave only
 * words (the pipeline's sync answer, a contact point's 409). `field` names the value a refusal is
 * about (`secrets.<name>` for a secret that must be entered again).
 */
export class AlertRequestError extends Error {
  readonly status: number;
  readonly code: AlertErrorCode;
  readonly currentVersion: number | null;
  readonly problems: Problem[];
  readonly field: string | null;

  constructor(
    status: number,
    code: AlertErrorCode,
    message: string,
    extra: { currentVersion?: number | null; problems?: Problem[]; field?: string | null } = {},
  ) {
    super(message);
    this.name = "AlertRequestError";
    this.status = status;
    this.code = code;
    this.currentVersion = extra.currentVersion ?? null;
    this.problems = extra.problems ?? [];
    this.field = extra.field ?? null;
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

function problemsOf(raw: unknown): Problem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) => (isObject(p) && typeof p.path === "string" && typeof p.message === "string" ? [{ path: p.path, message: p.message }] : []));
}

async function failureOf(res: Response): Promise<AlertRequestError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    if (isAbort(err)) throw err;
    return new AlertRequestError(res.status, "bad_request", UNREADABLE_ANSWER);
  }
  const detail = isObject(body) ? body.detail : undefined;
  // `{code, message, ...}`: the rule, silence, dashboard and dry-run routes (a 502/504 too).
  if (isObject(detail) && typeof detail.message === "string") {
    return new AlertRequestError(res.status, CODES.find((c) => c === detail.code) ?? "bad_request", detail.message, {
      currentVersion: typeof detail.current_version === "number" ? detail.current_version : null,
      problems: problemsOf(detail.problems),
      field: typeof detail.field === "string" ? detail.field : null,
    });
  }
  // `{"detail": "words"}`: the pipeline's sync answer and contact point refusals.
  if (typeof detail === "string" && detail) return new AlertRequestError(res.status, "bad_request", detail);
  if (Array.isArray(detail)) {
    // A validation list (`[{loc, msg}]`); a secret that must be entered again names its field.
    const words = detail.flatMap((d) => (isObject(d) && typeof d.msg === "string" ? [d.msg] : []));
    const secret = detail.find((d) => isObject(d) && d.type === "secret_needed" && Array.isArray(d.loc));
    const loc = isObject(secret) && Array.isArray(secret.loc) ? secret.loc : [];
    const field = loc.length >= 3 && loc[1] === "secrets" ? `secrets.${String(loc[2])}` : null;
    if (words.length) return new AlertRequestError(res.status, "bad_request", words.join(" "), { field });
  }
  return new AlertRequestError(res.status, "bad_request", UNREADABLE_ANSWER);
}

/** One request; rejects with `AlertRequestError`, an abort passes through unchanged. A 204
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
    throw new AlertRequestError(0, "network", NETWORK_MESSAGE);
  }
  if (!res.ok) throw await failureOf(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new AlertRequestError(res.status, "bad_request", UNREADABLE_ANSWER);
  }
}

// --- Routes: rules ----------------------------------------------------------------------------

export function listRules(scope?: { kind: ScopeKind; id: string }, signal?: AbortSignal): Promise<RuleOut[]> {
  const query = scope ? `?scope_kind=${enc(scope.kind)}&scope_id=${enc(scope.id)}` : "";
  return request("GET", `/rules${query}`, undefined, signal);
}
export const getRule = (id: string, signal?: AbortSignal) => request<RuleOut>("GET", `/rules/${enc(id)}`, undefined, signal);
/** Newest first. */
export const ruleHistory = (id: string, limit = 50, signal?: AbortSignal) =>
  request<HistoryOut[]>("GET", `/rules/${enc(id)}/history?limit=${enc(String(limit))}`, undefined, signal);
export const createRule = (body: RuleIn) => request<RuleChangeOut>("POST", "/rules", body);
/** 409 `rule_changed` (with `currentVersion`) when another save landed since `base_version`. */
export const saveRule = (id: string, body: RuleSaveIn) => request<RuleChangeOut>("PUT", `/rules/${enc(id)}`, body);
export const pauseRule = (id: string) => request<RuleOut>("POST", `/rules/${enc(id)}/pause`);
export const resumeRule = (id: string) => request<RuleOut>("POST", `/rules/${enc(id)}/resume`);
export const ruleDeleteReview = (id: string) => request<RuleDeleteReviewOut>("GET", `/rules/${enc(id)}/delete-review`);
export const deleteRule = (id: string, token: string) => request<RuleChangeOut>("DELETE", `/rules/${enc(id)}?token=${enc(token)}`);
export const attachRule = (id: string, body: AttachIn) => request<AttachOut>("POST", `/rules/${enc(id)}/attach`, body);
/** A PrometheusRule is a cluster change: the answer is its review (applied through the actions
 * routes); a Loki rule is written at once. */
export const syncTarget = (targetId: string) => request<SyncOut>("POST", `/targets/${enc(targetId)}/sync`);

// --- Routes: reading --------------------------------------------------------------------------

export const alertOverview = (signal?: AbortSignal) => request<OverviewOut>("GET", "/overview", undefined, signal);
/** By panel id. */
export const panelStates = (dashboardId: string, signal?: AbortSignal) =>
  request<Record<string, PanelAlertStateOut>>("GET", `/panel-states?dashboard_id=${enc(dashboardId)}`, undefined, signal);

export interface CapabilityParams {
  scope: { kind: ScopeKind; id: string };
  sourceType: SourceType;
  sourceId?: string | null;
}
export function capabilities(p: CapabilityParams, signal?: AbortSignal): Promise<CapabilityOut[]> {
  const params = new URLSearchParams({ scope_kind: p.scope.kind, scope_id: p.scope.id, source_type: p.sourceType });
  if (p.sourceId) params.set("source_id", p.sourceId);
  return request("GET", `/capabilities?${params.toString()}`, undefined, signal);
}
export const channels = (projectId: string, signal?: AbortSignal) =>
  request<ChannelsOut>("GET", `/channels?project_id=${enc(projectId)}`, undefined, signal);

/** How often the condition would have fired. Changes nothing. A 502 or 504 carries
 * `detail.message` (every project failed, or the run took too long). */
export const dryRunAlert = (body: DryRunIn, signal?: AbortSignal) => request<DryRunOut>("POST", "/dry-run", body, signal);

// --- Routes: contact points (the calls that hold a secret are plain functions) --------------------

export const listContactPoints = () => request<ContactPointOut[]>("GET", "/contact-points");
export const createContactPoint = (body: ContactPointIn) => request<ContactPointOut>("POST", "/contact-points", body);
export const updateContactPoint = (id: string, body: ContactPointPatch) =>
  request<ContactPointChangedOut>("PATCH", `/contact-points/${enc(id)}`, body);
export const contactPointDeleteReview = (id: string) =>
  request<ContactPointDeleteReviewOut>("GET", `/contact-points/${enc(id)}/delete-review`);
export const deleteContactPoint = (id: string, token: string) =>
  request<ContactPointDeleteOut>("DELETE", `/contact-points/${enc(id)}?token=${enc(token)}`);
/** A test of the saved contact point. */
export const testContactPoint = (id: string) => request<ContactPointTestOut>("POST", `/contact-points/${enc(id)}/test`);
/** A test of a contact point as entered; nothing is stored. */
export const testUnsavedContactPoint = (body: ContactPointIn) => request<ContactPointTestOut>("POST", "/contact-points/test", body);

// --- Routes: silences -------------------------------------------------------------------------

export const listSilences = (signal?: AbortSignal) => request<SilencesOut>("GET", "/silences", undefined, signal);
export const previewSilence = (body: SilenceIn) => request<SilencePreviewOut>("POST", "/silences/preview", body);
export const createSilence = (body: SilenceIn) => request<SilenceOut>("POST", "/silences", body);
/** Ends it now; an Alertmanager's silence needs its `sourceId`. */
export const expireSilence = (kind: "omnikrux" | "alertmanager", id: string, sourceId?: string | null) =>
  request<void>("DELETE", `/silences/${enc(kind)}/${enc(id)}${sourceId ? `?source_id=${enc(sourceId)}` : ""}`);

// --- Hooks ------------------------------------------------------------------------------------

const ALERTS = ["monitoring", "alerts"] as const;
export const alertsKeys = {
  overview: [...ALERTS, "overview"] as const,
  rules: (scope?: { kind: ScopeKind; id: string }) => [...ALERTS, "rules", scope?.kind ?? null, scope?.id ?? null] as const,
  rule: (id: string) => [...ALERTS, "rule", id] as const,
  history: (id: string) => [...ALERTS, "rule", id, "history"] as const,
  panelStates: (dashboardId: string) => [...ALERTS, "panelStates", dashboardId] as const,
  contactPoints: [...ALERTS, "contactPoints"] as const,
  silences: [...ALERTS, "silences"] as const,
  capabilities: (p: CapabilityParams | null) => [...ALERTS, "capabilities", p] as const,
  channels: (projectId: string | null) => [...ALERTS, "channels", projectId] as const,
  dryRun: (body: DryRunIn | null) => [...ALERTS, "dryRun", body] as const,
};

const REFETCH_MS = 15_000;

type Result<T> = UseQueryResult<T, AlertRequestError>;

export const useAlertOverview = (): Result<OverviewOut> =>
  useQuery<OverviewOut, AlertRequestError>({
    queryKey: alertsKeys.overview, queryFn: ({ signal }) => alertOverview(signal), refetchInterval: REFETCH_MS, retry: false,
  });

export const useRules = (scope?: { kind: ScopeKind; id: string }): Result<RuleOut[]> =>
  useQuery<RuleOut[], AlertRequestError>({ queryKey: alertsKeys.rules(scope), queryFn: ({ signal }) => listRules(scope, signal), retry: false });

export const useRule = (id: string): Result<RuleOut> =>
  useQuery<RuleOut, AlertRequestError>({ queryKey: alertsKeys.rule(id), queryFn: ({ signal }) => getRule(id, signal), retry: false });

export const useRuleHistory = (id: string): Result<HistoryOut[]> =>
  useQuery<HistoryOut[], AlertRequestError>({ queryKey: alertsKeys.history(id), queryFn: ({ signal }) => ruleHistory(id, 50, signal), retry: false });

export const usePanelStates = (dashboardId: string): Result<Record<string, PanelAlertStateOut>> =>
  useQuery<Record<string, PanelAlertStateOut>, AlertRequestError>({
    queryKey: alertsKeys.panelStates(dashboardId), queryFn: ({ signal }) => panelStates(dashboardId, signal),
    refetchInterval: REFETCH_MS, retry: false,
  });

export const useContactPoints = (): Result<ContactPointOut[]> =>
  useQuery<ContactPointOut[], AlertRequestError>({ queryKey: alertsKeys.contactPoints, queryFn: () => listContactPoints(), retry: false });

export const useSilences = (): Result<SilencesOut> =>
  useQuery<SilencesOut, AlertRequestError>({ queryKey: alertsKeys.silences, queryFn: ({ signal }) => listSilences(signal), retry: false });

/** Where a rule on this scope and source type can run; `null` waits. */
export const useCapabilities = (p: CapabilityParams | null): Result<CapabilityOut[]> =>
  useQuery<CapabilityOut[], AlertRequestError>({
    queryKey: alertsKeys.capabilities(p), queryFn: ({ signal }) => capabilities(p as CapabilityParams, signal), enabled: p !== null, retry: false,
  });

/** A project's Alertmanager channels; `null` waits. */
export const useChannels = (projectId: string | null): Result<ChannelsOut> =>
  useQuery<ChannelsOut, AlertRequestError>({
    queryKey: alertsKeys.channels(projectId), queryFn: ({ signal }) => channels(projectId as string, signal), enabled: projectId !== null, retry: false,
  });

/** The dry run of `body`; `null` waits. The caller debounces what it passes. A failed run isn't
 * retried: the answer already says why. */
export const useDryRun = (body: DryRunIn | null): Result<DryRunOut> =>
  useQuery<DryRunOut, AlertRequestError>({
    queryKey: alertsKeys.dryRun(body), queryFn: ({ signal }) => dryRunAlert(body as DryRunIn, signal), enabled: body !== null, retry: false,
    // Six hours replayed again only when the rule changes, not when the window gets focus back.
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  });

// --- Mutations (none of these bodies holds a secret) ------------------------------------------

/**
 * After an alerts change: everything Monitoring shows is read again, and so is the audit log, but
 * not a dry run: it answers for the rule as written in an open form or Alert tab, which the change
 * didn't touch, and asking again would only replace an answer that is still current.
 */
export async function refreshAlerts(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["monitoring"], predicate: (q) => !(q.queryKey[1] === "alerts" && q.queryKey[2] === "dryRun") }),
    client.invalidateQueries({ queryKey: ["audit"] }),
  ]);
}

/** An alerts change whose body holds no secret: `refreshAlerts` after it. */
function useAlertsMutation<V, R>(fn: (vars: V) => Promise<R>): UseMutationResult<R, Error, V> {
  const client = useQueryClient();
  return useMutation<R, Error, V>({ mutationFn: fn, onSuccess: () => refreshAlerts(client) });
}

type Mutation<V, R> = UseMutationResult<R, Error, V>;

export const useCreateRule = (): Mutation<RuleIn, RuleChangeOut> => useAlertsMutation(createRule);
export const useSaveRule = (): Mutation<{ id: string; body: RuleSaveIn }, RuleChangeOut> => useAlertsMutation((v) => saveRule(v.id, v.body));
export const usePauseRule = (): Mutation<string, RuleOut> => useAlertsMutation(pauseRule);
export const useResumeRule = (): Mutation<string, RuleOut> => useAlertsMutation(resumeRule);
export const useDeleteRule = (): Mutation<{ id: string; token: string }, RuleChangeOut> => useAlertsMutation((v) => deleteRule(v.id, v.token));
export const useAttachRule = (): Mutation<{ id: string; body: AttachIn }, AttachOut> => useAlertsMutation((v) => attachRule(v.id, v.body));
export const useSyncTarget = (): Mutation<string, SyncOut> => useAlertsMutation(syncTarget);
export const useDeleteContactPoint = (): Mutation<{ id: string; token: string }, ContactPointDeleteOut> => useAlertsMutation((v) => deleteContactPoint(v.id, v.token));
export const useCreateSilence = (): Mutation<SilenceIn, SilenceOut> => useAlertsMutation(createSilence);
export const useExpireSilence = (): Mutation<{ kind: "omnikrux" | "alertmanager"; id: string; sourceId?: string | null }, void> =>
  useAlertsMutation((v) => expireSilence(v.kind, v.id, v.sourceId));

/** After a contact point call made plainly: everything Monitoring shows is read again (not a dry run). */
export function useRefreshAfterContactPoint(): () => Promise<void> {
  const client = useQueryClient();
  return () => refreshAlerts(client);
}
