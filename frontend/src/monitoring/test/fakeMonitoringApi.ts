// An in-memory stand-in for `/api/monitoring/*`, for UI tests. It stubs `fetch`, records every
// request, and passes any other URL to a fallback. It applies the backend's validation copy for the
// cases the UI tests use (name rule, name taken, gone), and for dashboards the backend's codes and
// copy (`{code, message, problems?, current_version?}`). Not a model of the backend.
import { vi } from "vitest";
import type {
  AuthOut, DashboardRefOut, DiscoveryOut, FieldCatalogOut, GroupOut, HealthOut, LinkOut, ProjectKind, ProjectOut,
  FilterCheckOut, QueryErrorCode, QueryRequest, QueryResponse, SetupIn, SourceIn, SourceOut, SuggestOut, TreeColor, TreeDashboard, TreeOut,
} from "../api/types";
import type { CatalogOut } from "../catalog/api";
import type { BatchItemOut, DashboardOut, ReadyMadeOut, VersionOut, WhyEmptyOut } from "../dashboards/api";
import { emptyTransferState, transferRoute, type FakeTransferState } from "./fakeTransferApi";
import { alertsRoute, emptyAlertsState, type FakeAlertsState, type FakeRefusal } from "./fakeAlertsApi";
import type { Plan } from "../../api/types";
import type { ContactsSyncOut, GeneratedOut, InstallPlanOut, InstallStatusOut, ProbeResultOut, ToolsOut } from "../install/api";
import { validateDashboard, type DashboardSpec, type OwnerKind, type Problem, type VariableSpec } from "../dashboards/schema";
import { autoTypeName } from "../sources/sourceLabels";

/** A seeded answer to a query: a success (whatever is left out is filled in) or a refusal. */
export type FakeQueryAnswer = Partial<QueryResponse> | { error: { code: QueryErrorCode; message: string }; status: number };

/** A dashboard the fake holds. A ready-made view (`out.ready_made`, id `ready:<project>:<key>`) is
 * served read-only and has no versions. `versions` is oldest first. */
export interface FakeDashboard {
  out: Omit<DashboardOut, "alert_changes">;
  versions: { out: VersionOut; spec: DashboardSpec }[];
}

/** The install routes' answers (`/install/*`). */
export interface FakeInstallState {
  /** `GET /install/tools`, and `tools` in each status answer. Unavailable by default (M1's setup copy stays). */
  tools: ToolsOut;
  /** `GET /install/clusters/{id}` by cluster id; none seeded answers 404 (the cluster is gone). */
  status: Record<string, Omit<InstallStatusOut, "tools">>;
  /** `POST /install/plan` answers, used in order (the last one repeats); none answers a refusal. */
  plans: (InstallPlanOut | FakeRefusal)[];
  /** `POST /install/clusters/{id}/uninstall/plan` answers, used in order (the last one repeats). */
  uninstallPlans: (Plan | FakeRefusal)[];
  /** `POST /install/clusters/{id}/contacts/sync` by cluster id; none seeded answers 404. */
  contacts: Record<string, ContactsSyncOut | FakeRefusal>;
  /** `POST /install/generate`; null answers a small file for the kind asked for. */
  generated: GeneratedOut | FakeRefusal | null;
  /** `POST /install/probe` results by URL; an unseeded URL answers that nothing replied. */
  probe: Record<string, Partial<ProbeResultOut>>;
}

/** Installing isn't possible here: the backend's words when Helm isn't found (no path configured). */
export const FAKE_TOOLS_MISSING =
  "Installing needs Helm, which ships in the OmniKrux image. It wasn't found. Run OmniKrux from its image, or run scripts/dev-monitoring-tools.sh.";

export function emptyInstallState(): FakeInstallState {
  return {
    tools: { available: false, message: FAKE_TOOLS_MISSING, helm_version: null, charts: [] },
    status: {}, plans: [], uninstallPlans: [], contacts: {}, generated: null, probe: {},
  };
}

export interface FakeMonitoringState extends FakeAlertsState {
  install: FakeInstallState;
  /** Export, Grafana connections, import and update from source (`fakeTransferApi.ts`). */
  transfer: FakeTransferState;
  sources: SourceOut[];
  projects: ProjectOut[];
  groups: GroupOut[];
  health: Record<string, HealthOut>;
  /** By cluster id. */
  discovery: Record<string, DiscoveryOut>;
  /** `POST /sources/{id}/filter-check` answers by source id, then by filter text (first wins); whatever is left out matches. */
  filterChecks: Record<string, FilterCheckOut>;
  /** Field catalogs by source id. */
  fields: Record<string, FieldCatalogOut>;
  /** Answers to `/query`, by query text; whatever is left out is filled in. */
  queries: Record<string, Partial<QueryResponse>>;
  suggestion: SuggestOut;
  /** Answers to `/query` and `/query/batch` items, by `"<project id>|<query text>"` or by query
   * text (the first wins), read before `queries`. */
  queryAnswers: Record<string, FakeQueryAnswer>;
  /** By id. */
  dashboards: Record<string, FakeDashboard>;
  /** Ready-made views by project id (also listed in the tree); `source_name` left out answers null. */
  readyMade: Record<string, FakeReadyMade[]>;
  /** Label values by `"<project id>|<label>"`. */
  labelValues: Record<string, string[]>;
  /** Project catalogs by project id (`GET /projects/{id}/catalog`; absent answers 404). */
  catalogs: Record<string, CatalogOut>;
  /** `POST /query/why-empty`'s answer to every check (after the body, project and link checks);
   * `unknown` by default, so an empty panel keeps the generic words. */
  whyEmpty: WhyEmptyOut | { error: { code: QueryErrorCode; message: string }; status: number };
}

/** A ready-made view as a test seeds it: `source_name` may be left out. */
export type FakeReadyMade = Omit<ReadyMadeOut, "source_name"> & { source_name?: string | null };

/** A seed: any part of the state; `install` may be seeded in part (the rest keeps its defaults). */
export type FakeMonitoringSeed = Partial<Omit<FakeMonitoringState, "install" | "transfer">> & {
  install?: Partial<FakeInstallState>;
  transfer?: Partial<FakeTransferState>;
};

export interface FakeMonitoringApi {
  state: FakeMonitoringState;
  requests: { method: string; url: string; body: unknown }[];
}

type Fallback = (url: string, init?: RequestInit) => Promise<Response>;

const NAME_RULE = "Names are 1 to 80 characters, without line breaks.";
const SOURCE_GONE = "That source doesn't exist anymore. It may have been removed.";
const PROJECT_GONE = "That project doesn't exist anymore. It may have been removed.";
const GROUP_GONE = "That group doesn't exist anymore. It may have been removed.";
const NOT_LINKED = "This source isn't linked to that project.";
const REVIEW_CHANGED = "That changed since you looked. Review it again.";
const CLUSTER_GONE = "That cluster isn't connected to OmniKrux any more.";
const NOT_INSTALLED = "OmniKrux hasn't installed anything in this cluster.";
const TOKEN = "review-token";
const DASHBOARD_GONE = "That dashboard no longer exists.";
const VERSION_GONE = "That version of the dashboard no longer exists.";
const OWNER_GONE = "That project or group no longer exists.";
const READ_ONLY = "Ready-made views can't be changed. Copy one to edit it.";
const VERSION_NUMBER = "Send the version you started from as a whole number.";
const BATCH_SIZE = "Send 1 to 64 queries in one batch.";
const BATCH_PROJECT = "Pick the project this query belongs to.";
const PROJECT_NEEDED = "Choose the project whose label values to read.";
const NO_ANSWER = "This fake has no answer for that query.";
const OWNER_KIND_CHOICE = 'Choose "project" or "group" as the owner kind.';
const QUERY_PROJECT_GONE = "That project no longer exists.";
const QUERY_NOT_LINKED = "This source isn't linked to that project.";
const WHY_PROJECT = "Choose the project the query ran for.";
const WINDOW_ORDER = "Send the time range the query ran over: a start, and an end after it.";
const RANGE_NEEDS = "A range query needs a start, an end after it, and a step.";
const TOO_MANY_POINTS = "This range has too many points for the step. Use a larger step.";
const MAX_TITLE = 120;
const conflict = (current: number) =>
  `This dashboard was saved somewhere else since you started (version ${current}). Review the differences before saving.`;
const UNKNOWN_HEALTH: HealthOut = { state: "unknown", message: null, version: null, checked_at: null };
const NOW = "2026-01-01T00:00:00Z";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = () => new Response(null, { status: 204 });
const refuse = (detail: unknown, status: number) => json({ detail }, status);
const queryError = (status: number, code: string, message: string) => refuse({ code, message }, status);

type Obj = Record<string, unknown>;

function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= 80 && !/[\r\n]/.test(name) ? name : null;
}

const taken = (kind: string, name: string) => refuse(`A ${kind} named "${name}" already exists. Pick another name.`, 409);
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function authOut(input: SourceIn["auth"]): AuthOut {
  return {
    type: input?.type ?? "none",
    username: input?.username ?? null,
    header_name: input?.header_name ?? null,
    has_password: !!input?.password,
    has_token: !!input?.token,
    has_api_key: !!input?.api_key,
    has_client_key: !!input?.client_key_pem,
    has_client_cert: !!input?.client_cert_pem,
  };
}

function color(kind: ProjectKind, provider: string | null): TreeColor {
  if (kind === "kubernetes" && provider) return provider as TreeColor;
  return kind === "docker" || kind === "servers" ? "onprem" : "custom";
}

export function installFakeMonitoringApi(seed: FakeMonitoringSeed = {}, fallback?: Fallback): FakeMonitoringApi {
  const state: FakeMonitoringState = {
    sources: [], projects: [], groups: [], health: {}, discovery: {}, filterChecks: {}, fields: {}, queries: {},
    suggestion: { filter: "", origin: "none", reason: null },
    queryAnswers: {}, dashboards: {}, readyMade: {}, labelValues: {}, catalogs: {},
    whyEmpty: { reason: "unknown", message: null },
    ...emptyAlertsState(),
    ...seed,
    install: { ...emptyInstallState(), ...seed.install },
    transfer: { ...emptyTransferState(), ...seed.transfer },
  };
  const requests: FakeMonitoringApi["requests"] = [];
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}${++counter}`;

  const project = (id: string) => state.projects.find((p) => p.id === id);
  const names = () => new Map(state.projects.map((p) => [p.id, p.name]));
  const byName = (ids: string[]) => {
    const n = names();
    return [...ids].sort((a, b) => (n.get(a) ?? "").toLowerCase().localeCompare((n.get(b) ?? "").toLowerCase()) || a.localeCompare(b));
  };
  /** The rule lists of an owner's delete review: an empty list is left out of the answer. */
  const ownerRuleLists = (id: string) => {
    const lists = state.ownerRules[id] ?? {};
    return {
      ...(lists.alert_rules?.length ? { alert_rules: lists.alert_rules } : {}),
      ...(lists.cluster_rules?.length ? { cluster_rules: lists.cluster_rules } : {}),
    };
  };
  const usedBy = (sourceId: string) => state.projects.filter((p) => p.links.some((l) => l.source_id === sourceId)).map((p) => ({ id: p.id, name: p.name }));
  const refreshUsedBy = () => state.sources.forEach((s) => { s.used_by = usedBy(s.id); });
  const groupOut = (g: GroupOut): GroupOut => ({ ...g, project_ids: byName(g.project_ids) });
  const syncGroupIds = () => state.projects.forEach((p) => { p.group_ids = state.groups.filter((g) => g.project_ids.includes(p.id)).map((g) => g.id); });

  function addSource(body: SourceIn, createdBy: string | null): SourceOut | Response {
    const name = body.name == null ? (autoTypeName(body.type)) : cleanName(body.name);
    if (name === null) return refuse(NAME_RULE, 422);
    if (state.sources.some((s) => sameName(s.name, name))) return taken("source", name);
    const source: SourceOut = {
      id: nextId("s"), name, type: body.type, reach: body.reach, url: body.url ?? null,
      cluster_id: body.cluster_id ?? null, cluster_name: null, namespace: body.namespace ?? null,
      service: body.service ?? null, port: body.port ?? null, scheme: body.scheme ?? "http",
      path_prefix: body.path_prefix ?? "", auth: authOut(body.auth),
      headers: (body.headers ?? []).map((h) => ({ name: h.name, has_value: !!h.value })),
      has_ca: !!body.ca_pem, created_by_project_id: createdBy, used_by: [], health: UNKNOWN_HEALTH,
      created_at: NOW, updated_at: NOW,
    };
    state.sources.push(source);
    return source;
  }

  // --- dashboards

  type Owner = { kind: OwnerKind; id: string; name: string; linked: Set<string> };
  const dashboardError = (status: number, code: string, message: string, extra: Obj = {}) => refuse({ code, message, ...extra }, status);
  const titleOrder = (a: { title: string }, b: { title: string }) =>
    a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.title.localeCompare(b.title);
  const saved = () => Object.values(state.dashboards).filter((d) => !d.out.ready_made);
  const ownedBy = (kind: OwnerKind, id: string) =>
    saved().filter((d) => d.out.owner_kind === kind && d.out.owner_id === id).sort((a, b) => titleOrder(a.out, b.out));
  const refsOf = (kind: OwnerKind, id: string): DashboardRefOut[] =>
    ownedBy(kind, id).map((d) => ({ id: d.out.id, title: d.out.title, versions: d.versions.length }));
  const dropOwned = (kind: OwnerKind, id: string) => ownedBy(kind, id).forEach((d) => { delete state.dashboards[d.out.id]; });
  const treeRows = (kind: OwnerKind, id: string): TreeDashboard[] =>
    ownedBy(kind, id).map((d) => ({ id: d.out.id, title: d.out.title, ready_made: false }));
  function ownerOf(kind: unknown, id: unknown): Owner | null {
    if (kind === "project") {
      const p = project(String(id));
      return p ? { kind, id: p.id, name: p.name, linked: new Set(p.links.map((l) => l.source_id)) } : null;
    }
    if (kind === "group") {
      const g = state.groups.find((x) => x.id === id);
      return g ? { kind, id: g.id, name: g.name, linked: new Set() } : null;
    }
    return null;
  }
  const dashboardOut = (d: FakeDashboard, alertChanges: DashboardOut["alert_changes"] = []): DashboardOut => ({
    ...d.out,
    ...(d.out.ready_made ? {} : { owner_name: ownerOf(d.out.owner_kind, d.out.owner_id)?.name ?? "" }),
    alert_changes: alertChanges,
  });

  /** The validated document for the owner, or the backend's 422. */
  function checked(spec: unknown, owner: Owner): DashboardSpec | Response {
    const v = validateDashboard(spec, owner.kind);
    const invalid = (problems: Problem[]) =>
      dashboardError(422, "invalid_dashboard", `${problems[0].path}: ${problems[0].message}`, { problems });
    if (!v.ok) return invalid(v.problems);
    if (owner.kind === "project") {
      const message = `This source isn't linked to ${owner.name}.`;
      const problems: Problem[] = [];
      v.spec.variables.forEach((x, i) => {
        if (x.source.id !== null && !owner.linked.has(x.source.id)) problems.push({ path: `variables[${i}].source.id`, message });
      });
      v.spec.panels.forEach((p, i) => p.queries.forEach((q, j) => {
        if (q.source.id !== null && !owner.linked.has(q.source.id)) problems.push({ path: `panels[${i}].queries[${j}].source.id`, message });
      }));
      if (problems.length) return invalid(problems.slice(0, 50));
    }
    return v.spec;
  }

  /** Titles are unique per owner, case-sensitively (like the backend). */
  const titleTaken = (kind: OwnerKind, id: string, title: string, besides?: string) =>
    saved().some((d) => d.out.owner_kind === kind && d.out.owner_id === id && d.out.title === title && d.out.id !== besides);
  const takenTitle = (title: string) => dashboardError(409, "name_taken", `A dashboard named "${title}" already exists. Pick another name.`);
  const versionConflict = (d: FakeDashboard) =>
    dashboardError(409, "version_conflict", conflict(d.out.version), { current_version: d.out.version });

  function uniqueTitle(kind: OwnerKind, id: string, base: string): string {
    const start = base.trim().slice(0, MAX_TITLE);
    let title = start;
    for (let n = 2; titleTaken(kind, id, title); n++) {
      const suffix = ` (${n})`;
      title = start.slice(0, MAX_TITLE - suffix.length).trimEnd() + suffix;
    }
    return title;
  }

  function addVersion(d: FakeDashboard, spec: DashboardSpec, origin: VersionOut["origin"], extra: Partial<VersionOut> = {}) {
    const version = d.out.version + 1;
    d.out = { ...d.out, version, title: spec.title, spec, updated_at: NOW };
    d.versions.push({
      out: { version, saved_at: NOW, title: spec.title, panel_count: spec.panels.length, origin, restored_from: null, copied_from: null, ...extra },
      spec,
    });
  }

  /** An update from source answered by the seed: the held dashboard takes its document as the next version. */
  function applyUpdate(id: string, out: DashboardOut, from: string | null) {
    const d = state.dashboards[id];
    if (!d || out.version <= d.out.version) return;
    d.out = { ...d.out, version: out.version - 1 };
    addVersion(d, out.spec, "updated", { copied_from: from });
  }

  function addDashboard(owner: Owner, spec: DashboardSpec, origin: "created" | "copied", copiedFrom: string | null): Response {
    if (titleTaken(owner.kind, owner.id, spec.title)) return takenTitle(spec.title);
    const id = nextId("d");
    const d: FakeDashboard = {
      out: {
        id, owner_kind: owner.kind, owner_id: owner.id, owner_name: owner.name, title: spec.title, version: 0, spec,
        ready_made: false, created_at: NOW, updated_at: NOW,
      },
      versions: [],
    };
    addVersion(d, spec, origin, { copied_from: copiedFrom });
    state.dashboards[id] = d;
    return json(dashboardOut(d), 201);
  }

  /** Every source id the owner can't use set to null, like the backend's `adapt_sources`. */
  function adapted(spec: DashboardSpec, owner: Owner): DashboardSpec {
    const copy = structuredClone(spec);
    const fix = (s: { id: string | null }) => { if (owner.kind === "group" || (s.id !== null && !owner.linked.has(s.id))) s.id = null; };
    copy.variables.forEach((v) => fix(v.source));
    copy.panels.forEach((p) => p.queries.forEach((q) => fix(q.source)));
    return copy;
  }

  /** A ready-made view exists only while its project does; a saved dashboard always passes. */
  const readyProjectExists = (d: FakeDashboard) => !d.out.ready_made || !!project(d.out.owner_id);

  function dashboardRoute(method: string, seg: string[], query: URLSearchParams, body: Obj): Response {
    const [, id, sub, v, action] = seg;
    if (method === "GET" && seg.length === 1) {
      const kind = query.get("owner_kind");
      const ownerId = query.get("owner_id");
      if (kind !== null && kind !== "project" && kind !== "group") {
        return dashboardError(422, "bad_request", 'Choose "project" or "group" as the owner kind.');
      }
      return json(saved()
        .filter((d) => (kind === null || d.out.owner_kind === kind) && (ownerId === null || d.out.owner_id === ownerId))
        .sort((a, b) => titleOrder(a.out, b.out))
        .map((d) => ({
          id: d.out.id, owner_kind: d.out.owner_kind, owner_id: d.out.owner_id, title: d.out.title, version: d.out.version,
          panel_count: d.out.spec.panels.length, updated_at: d.out.updated_at, ready_made: false,
        })));
    }
    const badKind = () => dashboardError(422, "bad_request", OWNER_KIND_CHOICE);
    const kindOk = body.owner_kind === "project" || body.owner_kind === "group";
    if (method === "POST" && seg.length === 1) {
      if (!kindOk) return badKind();
      const owner = ownerOf(body.owner_kind, body.owner_id);
      if (!owner) return dashboardError(404, "unknown_owner", OWNER_GONE);
      const spec = checked(body.spec, owner);
      return spec instanceof Response ? spec : addDashboard(owner, spec, "created", null);
    }
    if (method === "POST" && seg.length === 2 && id === "copy") {
      if (!kindOk) return badKind();
      const from = state.dashboards[String(body.from_id)];
      if (!from || !readyProjectExists(from)) return dashboardError(404, "not_found", DASHBOARD_GONE);
      const owner = ownerOf(body.owner_kind, body.owner_id);
      if (!owner) return dashboardError(404, "unknown_owner", OWNER_GONE);
      // A ready-made view isn't "a copy": it keeps its own title.
      const base = from.out.ready_made ? from.out.title : `${from.out.title} (copy)`;
      const title = typeof body.title === "string" ? body.title : uniqueTitle(owner.kind, owner.id, base);
      const copied = adapted(from.out.spec, owner);
      // The copy's variables start at the given values, each only when the variable can take it.
      const given = (body.defaults ?? {}) as Record<string, "all" | string[]>;
      for (const v of copied.variables) {
        const value = given[v.name];
        if (value === "all" ? v.includeAll : Array.isArray(value) && value.length <= (v.multi ? 100 : 1)) v.default = value as VariableSpec["default"];
      }
      const spec = checked({ ...copied, title }, owner);
      return spec instanceof Response ? spec : addDashboard(owner, spec, "copied", from.out.title);
    }
    const d = state.dashboards[id];
    const readOnly = d?.out.ready_made === true || id.startsWith("ready:");
    const gone = () => dashboardError(404, "not_found", DASHBOARD_GONE);
    const base = typeof body.base_version === "number" && Number.isInteger(body.base_version) ? body.base_version : null;
    if (readOnly && method !== "GET") return dashboardError(409, "read_only", READ_ONLY);
    if (seg.length === 2) {
      if (method === "GET") return d && readyProjectExists(d) ? json(dashboardOut(d)) : gone();
      if (method === "PUT") {
        if (base === null) return dashboardError(422, "bad_request", VERSION_NUMBER);
        if (!d) return gone();
        const owner = ownerOf(d.out.owner_kind, d.out.owner_id);
        if (!owner) return dashboardError(404, "unknown_owner", OWNER_GONE);
        const spec = checked(body.spec, owner);
        if (spec instanceof Response) return spec;
        if (base !== d.out.version) return versionConflict(d);
        if (titleTaken(owner.kind, owner.id, spec.title, d.out.id)) return takenTitle(spec.title);
        addVersion(d, spec, "saved");
        return json(dashboardOut(d, state.alertChangesOnSave));
      }
      if (method === "DELETE") {
        const raw = query.get("version") ?? "";
        if (!/^[0-9]{1,9}$/.test(raw)) return dashboardError(422, "bad_request", VERSION_NUMBER);
        if (!d) return gone();
        if (Number(raw) !== d.out.version) return versionConflict(d);
        delete state.dashboards[id];
        return empty();
      }
    }
    if (sub === "versions") {
      // Ready-made views have no versions: the store doesn't know them.
      if (!d || readOnly) return gone();
      if (method === "GET" && seg.length === 3) return json([...d.versions].reverse().map((x) => x.out));
      const found = /^[0-9]{1,9}$/.test(v ?? "") ? d.versions.find((x) => x.out.version === Number(v)) : undefined;
      if (method === "GET" && seg.length === 4) {
        return found
          ? json({ version: found.out.version, saved_at: found.out.saved_at, spec: found.spec })
          : dashboardError(404, "not_found", VERSION_GONE);
      }
      if (method === "POST" && seg.length === 5 && action === "restore") {
        if (base === null) return dashboardError(422, "bad_request", VERSION_NUMBER);
        if (!found) return dashboardError(404, "not_found", VERSION_GONE);
        if (base !== d.out.version) return versionConflict(d);
        if (titleTaken(d.out.owner_kind, d.out.owner_id, found.spec.title, d.out.id)) return takenTitle(found.spec.title);
        addVersion(d, found.spec, "restored", { restored_from: found.out.version });
        return json(dashboardOut(d));
      }
    }
    return refuse("Not found", 404);
  }

  /** A seeded answer to one query (by project and text, then text, then M1's `queries`), or the fake's refusal. */
  function answer(req: QueryRequest): { response: QueryResponse } | { error: { code: QueryErrorCode; message: string }; status: number } {
    const seeded = (req.project_id ? state.queryAnswers[`${req.project_id}|${req.query}`] : undefined)
      ?? state.queryAnswers[req.query] ?? state.queries[req.query];
    if (!seeded) return { error: { code: "bad_query", message: NO_ANSWER }, status: 400 };
    if ("error" in seeded && "status" in seeded) return { error: seeded.error, status: seeded.status };
    const source = state.sources.find((s) => s.id === req.source_id);
    return {
      response: {
        result_type: "vector", series: [], streams: [], warnings: [], truncated: false,
        source_id: req.source_id, source_name: source?.name ?? req.source_id, source_type: source?.type ?? "prometheus",
        project_id: req.project_id ?? null, applied_filter: "", query: req.query, took_ms: 1,
        ...(seeded as Partial<QueryResponse>),
      },
    };
  }

  /** The backend's project and link checks for a filtered read (`run.py`'s `_link_matchers`). */
  function linkRefusal(projectId: string, sourceId: string): { error: { code: QueryErrorCode; message: string }; status: number } | null {
    const p = project(projectId);
    if (!p) return { error: { code: "not_found", message: QUERY_PROJECT_GONE }, status: 404 };
    if (!p.links.some((l) => l.source_id === sourceId)) return { error: { code: "not_linked", message: QUERY_NOT_LINKED }, status: 404 };
    return null;
  }

  /** A batch item checked as the server checks it (range, then project and link), then answered. */
  function batchAnswer(req: QueryRequest): ReturnType<typeof answer> {
    if (req.kind === "range") {
      const { start, end, step } = req;
      if (start == null || end == null || step == null || !(end > start)) {
        return { error: { code: "bad_request", message: RANGE_NEEDS }, status: 400 };
      }
      if ((end - start) / step > 11000) return { error: { code: "bad_request", message: TOO_MANY_POINTS }, status: 400 };
    }
    return linkRefusal(req.project_id as string, req.source_id) ?? answer(req);
  }

  function route(method: string, path: string, query: URLSearchParams, body: Obj): Response {
    const seg = path.split("/").map(decodeURIComponent);
    const [a, b, , d] = seg;
    const is = (m: string, ...pattern: (string | null)[]) =>
      method === m && seg.length === pattern.length && pattern.every((p, i) => p === null || p === seg[i]);

    // --- export, Grafana connections, import, origins and update from source
    const transferred = transferRoute({ state, nextId, updated: applyUpdate }, method, seg, body);
    if (transferred) return transferred;

    // --- dashboards, ready-made views, batches and label values
    if (a === "dashboards") return dashboardRoute(method, seg, query, body);
    if (a === "install") return installRoute(method, seg.slice(1), body);
    if (a === "alerts") {
      const found = (id: string) => (state.dashboards[id] ? { version: state.dashboards[id].out.version, out: dashboardOut(state.dashboards[id]) } : undefined);
      return alertsRoute({ state, nextId, project, group: (id) => state.groups.find((g) => g.id === id) }, method, seg.slice(1), query, body, found);
    }
    if (is("GET", "projects", null, "ready-made")) {
      return project(b)
        ? json((state.readyMade[b] ?? []).map((r): ReadyMadeOut => ({ source_name: null, ...r })))
        : dashboardError(404, "not_found", DASHBOARD_GONE);
    }
    if (is("GET", "projects", null, "catalog")) {
      const found = state.catalogs[b];
      return found && project(b) ? json(found) : queryError(404, "not_found", QUERY_PROJECT_GONE);
    }
    if (is("POST", "query", "batch")) {
      const items = (body as Obj).queries;
      if (!Array.isArray(items)) return queryError(422, "bad_request", 'Put the queries in a "queries" list.');
      if (items.length < 1 || items.length > 64) return queryError(422, "bad_request", BATCH_SIZE);
      const results: BatchItemOut[] = (items as QueryRequest[]).map((req) => {
        if (!req.project_id) return { ok: false, response: null, error: { code: "bad_request", message: BATCH_PROJECT, status: 422 } };
        const got = batchAnswer(req);
        return "response" in got
          ? { ok: true, response: got.response, error: null }
          : { ok: false, response: null, error: { ...got.error, status: got.status } };
      });
      return json({ results });
    }
    if (is("POST", "query", "why-empty")) {
      const { source_id: sourceId, project_id: projectId, query: text, start, end } = body as Obj;
      if (typeof sourceId !== "string" || !sourceId) return queryError(422, "bad_request", "Choose a source to query.");
      if (typeof projectId !== "string" || !projectId) return queryError(422, "bad_request", WHY_PROJECT);
      if (typeof text !== "string" || !text) return queryError(422, "bad_request", "Write a query.");
      if (typeof start !== "number" || typeof end !== "number" || !(end > start)) return queryError(422, "bad_request", WINDOW_ORDER);
      const refused = linkRefusal(projectId, sourceId);
      if (refused) return queryError(refused.status, refused.error.code, refused.error.message);
      const out = state.whyEmpty;
      return "error" in out ? queryError(out.status, out.error.code, out.error.message) : json(out);
    }
    if (is("GET", "label-values")) {
      if (!query.get("source_id")) return queryError(400, "bad_request", "Choose a source to query.");
      if (!query.get("project_id")) return queryError(400, "bad_request", PROJECT_NEEDED);
      const refused = linkRefusal(query.get("project_id") as string, query.get("source_id") as string);
      if (refused) return queryError(refused.status, refused.error.code, refused.error.message);
      return json({ values: state.labelValues[`${query.get("project_id")}|${query.get("label")}`] ?? [], truncated: false });
    }

    // --- sources
    if (is("GET", "sources")) return json(state.sources);
    if (is("POST", "sources")) {
      const made = addSource(body as unknown as SourceIn, null);
      return made instanceof Response ? made : json(made, 201);
    }
    if (is("POST", "sources", "test")) return json({ ok: true, version: "fake", message: null });
    if (is("GET", "sources", "health")) return json(Object.fromEntries(state.sources.map((s) => [s.id, state.health[s.id] ?? s.health])));
    if (a === "sources" && b && b !== "test" && b !== "health") {
      const source = state.sources.find((s) => s.id === b);
      if (!source) return refuse(SOURCE_GONE, 404);
      if (is("PATCH", "sources", b)) {
        const patch = body as Obj;
        if (patch.name != null) {
          const name = cleanName(patch.name);
          if (name === null) return refuse(NAME_RULE, 422);
          if (state.sources.some((s) => s.id !== b && sameName(s.name, name))) return taken("source", name);
          source.name = name;
        }
        if (typeof patch.url === "string" && source.reach === "url") source.url = patch.url;
        source.updated_at = NOW;
        return json(source);
      }
      if (is("POST", "sources", b, "test")) return json({ ok: true, version: "fake", message: null });
      if (is("GET", "sources", b, "fields")) {
        if (!project(query.get("project") ?? "")) return refuse(NOT_LINKED, 404);
        return json(state.fields[b] ?? { metrics: [], labels: [], truncated: false });
      }
      if (is("POST", "sources", b, "filter-check")) {
        const text = String((body as Obj).filter ?? "").trim();
        return json(state.filterChecks[`${b}|${text}`] ?? state.filterChecks[b] ?? { matches: true, message: null });
      }
      if (is("GET", "sources", b, "alerting")) return json({ omnikrux_engine: true, tool_engine: null, reason: null });
      if (is("GET", "sources", b, "delete-review")) return json({ source_id: b, name: source.name, projects: usedBy(b), token: TOKEN });
      if (is("DELETE", "sources", b)) {
        if (query.get("token") !== TOKEN) return refuse(REVIEW_CHANGED, 409);
        state.sources = state.sources.filter((s) => s.id !== b);
        state.projects.forEach((p) => { p.links = p.links.filter((l) => l.source_id !== b); });
        return empty();
      }
    }

    // --- discovery and suggestions
    if (is("GET", "discovery", null)) {
      const found = state.discovery[b];
      return found ? json(found) : refuse("That cluster isn't connected to OmniKrux any more.", 404);
    }
    if (is("POST", "suggest-filter")) return json(state.suggestion);

    // --- tree, projects, setup
    if (is("GET", "tree")) {
      const out: TreeOut = {
        projects: state.projects.map((p) => ({
          id: p.id, name: p.name, kind: p.kind, cluster_id: p.cluster_id, color: color(p.kind, p.cluster_provider),
          dashboards: [...treeRows("project", p.id), ...(state.readyMade[p.id] ?? []).map((r) => ({ id: r.id, title: r.title, ready_made: true }))],
        })),
        groups: state.groups.map((g) => ({ id: g.id, name: g.name, project_ids: byName(g.project_ids), dashboards: treeRows("group", g.id) })),
        source_count: state.sources.length,
      };
      return json(out);
    }
    if (is("GET", "projects")) return json(state.projects);
    if (a === "projects" && b) {
      const p = project(b);
      if (!p) return refuse(PROJECT_GONE, 404);
      if (is("GET", "projects", b)) return json(p);
      if (is("PATCH", "projects", b)) {
        const name = cleanName((body as Obj).name);
        if (name === null) return refuse(NAME_RULE, 422);
        if (state.projects.some((x) => x.id !== b && sameName(x.name, name))) return taken("project", name);
        p.name = name;
        refreshUsedBy();
        return json(p);
      }
      if (is("PUT", "projects", b, "sources", null)) {
        const source = state.sources.find((s) => s.id === d);
        if (!source) return refuse(SOURCE_GONE, 404);
        const link: LinkOut = {
          source_id: source.id, source_name: source.name, source_type: source.type,
          filter: String((body as Obj).filter ?? ""), filter_origin: ((body as Obj).origin as LinkOut["filter_origin"]) ?? "user",
          created_by_project: source.created_by_project_id === p.id,
          source_cluster_id: source.reach === "cluster" ? source.cluster_id : null,
        };
        p.links = [...p.links.filter((l) => l.source_id !== source.id), link];
        refreshUsedBy();
        return json(link);
      }
      if (is("DELETE", "projects", b, "sources", null)) {
        if (!p.links.some((l) => l.source_id === d)) return refuse(NOT_LINKED, 404);
        p.links = p.links.filter((l) => l.source_id !== d);
        refreshUsedBy();
        return empty();
      }
      // What deleting `p` does to its sources: the ones it made that nobody else uses go; the ones it made that others use stay.
      const split = () => {
        const linked = state.sources.filter((s) => p.links.some((l) => l.source_id === s.id));
        const others = (s: SourceOut) => usedBy(s.id).filter((u) => u.id !== p.id);
        const mine = linked.filter((s) => s.created_by_project_id === p.id);
        return {
          removed: mine.filter((s) => others(s).length === 0),
          kept: mine.filter((s) => others(s).length > 0).map((s) => ({ id: s.id, name: s.name, used_by: others(s).map((u) => u.name) })),
          unlinked: linked.filter((s) => s.created_by_project_id !== p.id),
        };
      };
      if (is("GET", "projects", b, "delete-review")) {
        const { removed, kept, unlinked } = split();
        return json({
          project_id: p.id, name: p.name,
          sources_removed: removed.map((s) => ({ id: s.id, name: s.name })),
          sources_kept: kept,
          sources_unlinked: unlinked.map((s) => ({ id: s.id, name: s.name })),
          groups_left: state.groups.filter((g) => g.project_ids.includes(p.id)).map((g) => ({ id: g.id, name: g.name })),
          dashboards: refsOf("project", p.id),
          token: TOKEN,
          ...ownerRuleLists(p.id),
          // The tools OmniKrux installed in the project's cluster stay (from the seeded status).
          ...(() => {
            const st = p.cluster_id ? state.install.status[p.cluster_id] : undefined;
            return st?.install ? { tools_stay: { cluster_id: st.cluster_id, cluster_name: st.cluster_name, namespace: st.install.namespace } } : {};
          })(),
        });
      }
      if (is("DELETE", "projects", b)) {
        if (query.get("token") !== TOKEN) return refuse(REVIEW_CHANGED, 409);
        const { removed } = split();
        state.sources = state.sources.filter((s) => !removed.includes(s));
        state.projects = state.projects.filter((x) => x.id !== b);
        dropOwned("project", b);
        state.groups.forEach((g) => { g.project_ids = g.project_ids.filter((id) => id !== b); });
        refreshUsedBy();
        return empty();
      }
    }
    if (is("POST", "setup")) {
      const input = body as unknown as SetupIn;
      const name = cleanName(input.name);
      if (name === null) return refuse(NAME_RULE, 422);
      if (state.projects.some((x) => sameName(x.name, name))) return taken("project", name);
      if (input.kind === "kubernetes" && !input.cluster_id) return refuse("Pick a cluster for a Kubernetes project.", 422);
      const id = nextId("p");
      const links: LinkOut[] = [];
      const added: SourceOut[] = [];
      for (const entry of input.sources ?? []) {
        let source: SourceOut | undefined;
        if (entry.source_id) {
          source = state.sources.find((s) => s.id === entry.source_id);
          if (!source) return refuse("One of the chosen sources no longer exists. Reload and pick again.", 422);
        } else if (entry.source) {
          const made = addSource(entry.source, id);
          if (made instanceof Response) { state.sources = state.sources.filter((s) => !added.includes(s)); return made; }
          added.push(made);
          source = made;
        } else continue;
        links.push({
          source_id: source.id, source_name: source.name, source_type: source.type, filter: entry.filter ?? "",
          filter_origin: entry.origin ?? "user", created_by_project: source.created_by_project_id === id,
          source_cluster_id: source.reach === "cluster" ? source.cluster_id : null,
        });
      }
      const cluster = input.cluster_id ? { id: input.cluster_id, name: input.cluster_id } : null;
      const made: ProjectOut = {
        id, name, kind: input.kind, cluster_id: cluster?.id ?? null, cluster_name: cluster?.name ?? null,
        cluster_provider: null, links, group_ids: [], created_at: NOW, updated_at: NOW,
      };
      state.projects.push(made);
      refreshUsedBy();
      return json(made, 201);
    }

    // --- groups
    if (is("GET", "groups")) return json(state.groups.map(groupOut));
    if (is("POST", "groups")) {
      const name = cleanName((body as Obj).name);
      if (name === null) return refuse(NAME_RULE, 422);
      if (state.groups.some((g) => sameName(g.name, name))) return taken("group", name);
      const ids = [...new Set(((body as Obj).project_ids as string[] | undefined) ?? [])];
      if (ids.some((i) => !project(i))) return refuse("One of the chosen projects no longer exists. Reload and pick again.", 422);
      const group: GroupOut = { id: nextId("g"), name, project_ids: ids, created_at: NOW, updated_at: NOW };
      state.groups.push(group);
      syncGroupIds();
      return json(groupOut(group), 201);
    }
    if (a === "groups" && b) {
      const g = state.groups.find((x) => x.id === b);
      if (!g) return refuse(GROUP_GONE, 404);
      if (is("PATCH", "groups", b)) {
        const patch = body as Obj;
        if (patch.name != null) {
          const name = cleanName(patch.name);
          if (name === null) return refuse(NAME_RULE, 422);
          if (state.groups.some((x) => x.id !== b && sameName(x.name, name))) return taken("group", name);
          g.name = name;
        }
        if (Array.isArray(patch.project_ids)) {
          if ((patch.project_ids as string[]).some((i) => !project(i))) return refuse("One of the chosen projects no longer exists. Reload and pick again.", 422);
          g.project_ids = [...new Set(patch.project_ids as string[])];
          syncGroupIds();
        }
        return json(groupOut(g));
      }
      if (is("GET", "groups", b, "delete-review")) return json({ group_id: g.id, name: g.name, dashboards: refsOf("group", g.id), token: TOKEN, ...ownerRuleLists(g.id) });
      if (is("DELETE", "groups", b)) {
        // A group with dashboards needs its review's token; one without deletes as is.
        const token = query.get("token");
        if (!(token === TOKEN || (token === null && refsOf("group", g.id).length === 0))) return refuse(REVIEW_CHANGED, 409);
        dropOwned("group", g.id);
        state.groups = state.groups.filter((x) => x.id !== b);
        syncGroupIds();
        return empty();
      }
    }

    // --- query
    if (is("POST", "query")) {
      const got = answer(body as unknown as QueryRequest);
      return "response" in got ? json(got.response) : queryError(got.status, got.error.code, got.error.message);
    }
    return refuse("Not found", 404);
  }

  // --- install

  const isRefusal = (x: object): x is FakeRefusal => "error" in x && "status" in x;
  const seeded = (x: object) => (isRefusal(x) ? refuse(x.error.message, x.status) : json(x));
  /** The next answer of a queue: used in order, the last one repeats. */
  const next = <T,>(queue: T[]): T | undefined => (queue.length > 1 ? queue.shift() : queue[0]);

  function installRoute(method: string, seg: string[], body: Obj): Response {
    const inst = state.install;
    const [x, id, y, z] = seg;
    if (method === "GET" && seg.length === 1 && x === "tools") return json(inst.tools);
    if (method === "POST" && seg.length === 1 && x === "plan") {
      const out = next(inst.plans);
      return out ? seeded(out) : refuse("This fake has no install plan seeded.", 500);
    }
    if (method === "POST" && seg.length === 1 && x === "generate") {
      if (inst.generated) return seeded(inst.generated);
      const docker = body.kind !== "servers";
      const out: GeneratedOut = {
        kind: docker ? "docker" : "servers",
        files: [docker
          ? { name: "docker-compose.yml", content: "services: {}\n", executable: false }
          : { name: "install-monitoring.sh", content: "#!/usr/bin/env bash\n", executable: true }],
        urls: { prometheus: `http://${String(body.address)}:9090`, alertmanager: `http://${String(body.address)}:9093`, loki: `http://${String(body.address)}:3100` },
        ports: [9090, 9093, 3100],
      };
      return json(out);
    }
    if (method === "POST" && seg.length === 1 && x === "probe") {
      const tools = Array.isArray(body.tools) ? (body.tools as { type: ProbeResultOut["type"]; url: string }[]) : [];
      return json({
        results: tools.map((t) => ({ type: t.type, url: t.url, ok: false, version: null, message: "Nothing answered at that address.", ...inst.probe[t.url] })),
      });
    }
    if (x !== "clusters" || !id) return refuse("Not found", 404);
    if (method === "GET" && seg.length === 2) {
      const found = inst.status[id];
      return found ? json({ ...found, tools: inst.tools }) : refuse(CLUSTER_GONE, 404);
    }
    if (method === "POST" && seg.length === 4 && y === "uninstall" && z === "plan") {
      const out = next(inst.uninstallPlans);
      return out ? seeded(out) : refuse(NOT_INSTALLED, 404);
    }
    if (method === "POST" && seg.length === 4 && y === "contacts" && z === "sync") {
      const out = inst.contacts[id];
      return out ? seeded(out) : refuse(NOT_INSTALLED, 404);
    }
    return refuse("Not found", 404);
  }

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const prefix = "/api/monitoring/";
    if (!raw.startsWith(prefix)) {
      if (fallback) return fallback(raw, init);
      if (raw === "/api/clusters") return json([]);
      return refuse("Not found", 404);
    }
    let body: unknown;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    requests.push({ method, url: raw, body });
    const [path, search = ""] = raw.slice(prefix.length).split("?");
    return route(method, path, new URLSearchParams(search), (body as Obj | undefined) ?? {});
  };

  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  return { state, requests };
}
