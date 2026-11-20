// An in-memory stand-in for `/api/monitoring/*`, for UI tests. It stubs `fetch`, records every
// request, and passes any other URL to a fallback. It applies the backend's validation copy for the
// cases the UI tests use (name rule, name taken, gone). Not a model of the backend.
import { vi } from "vitest";
import type {
  AuthOut, DiscoveryOut, FieldCatalogOut, GroupOut, HealthOut, LinkOut, ProjectKind, ProjectOut, QueryRequest, QueryResponse,
  SetupIn, SourceIn, SourceOut, SuggestOut, TreeColor, TreeOut,
} from "../api/types";

export interface FakeMonitoringState {
  sources: SourceOut[];
  projects: ProjectOut[];
  groups: GroupOut[];
  health: Record<string, HealthOut>;
  /** By cluster id. */
  discovery: Record<string, DiscoveryOut>;
  /** Field catalogs by source id. */
  fields: Record<string, FieldCatalogOut>;
  /** Answers to `/query`, by query text; whatever is left out is filled in. */
  queries: Record<string, Partial<QueryResponse>>;
  suggestion: SuggestOut;
}

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
const TOKEN = "review-token";
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

export function installFakeMonitoringApi(seed: Partial<FakeMonitoringState> = {}, fallback?: Fallback): FakeMonitoringApi {
  const state: FakeMonitoringState = {
    sources: [], projects: [], groups: [], health: {}, discovery: {}, fields: {}, queries: {},
    suggestion: { filter: "", origin: "none", reason: null },
    ...seed,
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
  const usedBy = (sourceId: string) => state.projects.filter((p) => p.links.some((l) => l.source_id === sourceId)).map((p) => ({ id: p.id, name: p.name }));
  const refreshUsedBy = () => state.sources.forEach((s) => { s.used_by = usedBy(s.id); });
  const groupOut = (g: GroupOut): GroupOut => ({ ...g, project_ids: byName(g.project_ids) });
  const syncGroupIds = () => state.projects.forEach((p) => { p.group_ids = state.groups.filter((g) => g.project_ids.includes(p.id)).map((g) => g.id); });

  function addSource(body: SourceIn, createdBy: string | null): SourceOut | Response {
    const name = body.name == null ? (body.type === "loki" ? "Loki" : "Prometheus") : cleanName(body.name);
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

  function route(method: string, path: string, query: URLSearchParams, body: Obj): Response {
    const seg = path.split("/").map(decodeURIComponent);
    const [a, b, , d] = seg;
    const is = (m: string, ...pattern: (string | null)[]) =>
      method === m && seg.length === pattern.length && pattern.every((p, i) => p === null || p === seg[i]);

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
        projects: state.projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind, cluster_id: p.cluster_id, color: color(p.kind, p.cluster_provider), dashboards: [] })),
        groups: state.groups.map((g) => ({ id: g.id, name: g.name, project_ids: byName(g.project_ids), dashboards: [] })),
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
          token: TOKEN,
        });
      }
      if (is("DELETE", "projects", b)) {
        if (query.get("token") !== TOKEN) return refuse(REVIEW_CHANGED, 409);
        const { removed } = split();
        state.sources = state.sources.filter((s) => !removed.includes(s));
        state.projects = state.projects.filter((x) => x.id !== b);
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
      if (is("DELETE", "groups", b)) {
        state.groups = state.groups.filter((x) => x.id !== b);
        syncGroupIds();
        return empty();
      }
    }

    // --- query
    if (is("POST", "query")) {
      const req = body as unknown as QueryRequest;
      const source = state.sources.find((s) => s.id === req.source_id);
      const answer = state.queries[req.query];
      if (!answer) return queryError(400, "bad_query", "This fake has no answer for that query.");
      return json({
        result_type: "vector", series: [], streams: [], warnings: [], truncated: false,
        source_id: req.source_id, source_name: source?.name ?? req.source_id, source_type: source?.type ?? "prometheus",
        project_id: req.project_id ?? null, applied_filter: "", query: req.query, took_ms: 1,
        ...answer,
      } satisfies QueryResponse);
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
