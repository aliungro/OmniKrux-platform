// The transfer routes of the fake Monitoring API: export, Grafana connections, import preview and
// commit, a dashboard's origin and "Update from source". Answers what is seeded, by the keys named
// on `FakeTransferState`; never keeps a secret (a connection comes back with `has_*` flags only).
// Not a model of the backend.
import type { DashboardOut } from "../dashboards/api";
import type {
  ExportOut, GrafanaDashboardsOut, GrafanaIn, GrafanaOut, GrafanaPatch, ImportInput, ImportPreviewOut, ImportResultOut,
  OriginOut, UpdatePreviewOut,
} from "../transfer/api";

/** A seeded refusal: the HTTP status and the body's `detail` (`{code, message, key, problems}`). */
export interface Failure {
  status: number;
  detail: object;
}

export interface FakeTransferState {
  /** `POST /export` by `"<kind>:<id>"`; none seeded answers 404 `not_found`. */
  exports: Record<string, ExportOut>;
  grafana: GrafanaOut[];
  /** `GET /grafana/{id}/dashboards` by connection id; `POST /grafana/dashboards` reads `"new"`. */
  grafanaDashboards: Record<string, GrafanaDashboardsOut | Failure>;
  /** `POST /import/preview` by the text of a text input, or `grafana:<connection id or "new">:<uids joined by ",">`. */
  previews: Record<string, ImportPreviewOut | Failure>;
  /** `POST /import/commit`: used in order (the last one repeats), or one refusal. */
  commits: ImportResultOut[] | Failure;
  /** `GET /dashboards/{id}/origin` by dashboard id; none seeded answers null. */
  origins: Record<string, OriginOut | null>;
  /** `POST /dashboards/{id}/update-from-source/preview` by dashboard id. */
  updatePreviews: Record<string, UpdatePreviewOut | Failure>;
  /** `POST /dashboards/{id}/update-from-source` by dashboard id. */
  updates: Record<string, DashboardOut | Failure>;
}

export function emptyTransferState(): FakeTransferState {
  return { exports: {}, grafana: [], grafanaDashboards: {}, previews: {}, commits: [], origins: {}, updatePreviews: {}, updates: {} };
}

const NOW = "2026-01-01T00:00:00Z";
const GRAFANA_GONE = "That Grafana connection no longer exists.";
const NOTHING_SEEDED = "This fake has no answer for that.";

type Obj = Record<string, unknown>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, code: string, message: string, key: string | null = null) =>
  json({ detail: { code, message, key, problems: [] } }, status);
const isFailure = (x: object): x is Failure => "status" in x && "detail" in x;
const seeded = (x: object | undefined, status = 200) =>
  x === undefined ? refuse(500, "invalid_input", NOTHING_SEEDED) : isFailure(x) ? json({ detail: x.detail }, x.status) : json(x, status);

/** The preview key of an input (also what a commit's input is matched by). */
export function previewKey(input: ImportInput): string {
  if (input.kind === "text") return input.text;
  return `grafana:${input.grafana_id ?? "new"}:${input.uids.join(",")}`;
}

function grafanaOut(id: string, body: GrafanaIn | GrafanaPatch, old?: GrafanaOut): GrafanaOut {
  const auth = body.auth;
  const type = auth?.type ?? old?.auth.type ?? "none";
  return {
    id,
    name: body.name ?? old?.name ?? "Grafana",
    reach: body.reach ?? old?.reach ?? "url",
    url: body.url ?? old?.url ?? null,
    cluster_id: body.cluster_id ?? old?.cluster_id ?? null,
    cluster_name: old?.cluster_name ?? null,
    namespace: body.namespace ?? old?.namespace ?? null,
    service: body.service ?? old?.service ?? null,
    port: body.port ?? old?.port ?? null,
    scheme: body.scheme ?? old?.scheme ?? "http",
    path_prefix: body.path_prefix ?? old?.path_prefix ?? "",
    auth: {
      type,
      username: type === "basic" ? (auth?.username ?? old?.auth.username ?? null) : null,
      has_password: type === "basic" && !!(auth?.password ?? old?.auth.has_password),
      has_token: type === "bearer" && !!(auth?.token ?? old?.auth.has_token),
    },
    dashboards_imported: old?.dashboards_imported ?? 0,
    created_at: old?.created_at ?? NOW,
    updated_at: NOW,
  };
}

export interface TransferRouteDeps {
  state: { transfer: FakeTransferState };
  nextId(prefix: string): string;
}

/** `seg` is the path after `/api/monitoring/`, split. Null when the route isn't a transfer one. */
export function transferRoute(deps: TransferRouteDeps, method: string, seg: string[], body: Obj): Response | null {
  const t = deps.state.transfer;
  const [a, b, c, d] = seg;
  if (method === "POST" && seg.length === 1 && a === "export") {
    const found = t.exports[`${String(body.kind)}:${String(body.id)}`];
    return found ? json(found) : refuse(404, "not_found", "That dashboard, project or group no longer exists.");
  }
  if (a === "grafana") {
    if (method === "GET" && seg.length === 1) return json(t.grafana);
    if (method === "POST" && seg.length === 1) {
      const out = grafanaOut(deps.nextId("gf"), body as unknown as GrafanaIn);
      t.grafana.push(out);
      return json(out, 201);
    }
    if (method === "POST" && seg.length === 2 && b === "test") return json({ ok: true, version: "11.0.0", message: null, dashboards: 0 });
    if (method === "POST" && seg.length === 2 && b === "dashboards") return seeded(t.grafanaDashboards.new);
    const old = b ? t.grafana.find((g) => g.id === b) : undefined;
    if (b && !old) return refuse(404, "not_found", GRAFANA_GONE);
    if (old) {
      if (method === "PATCH" && seg.length === 2) {
        const out = grafanaOut(old.id, body as unknown as GrafanaPatch, old);
        t.grafana = t.grafana.map((g) => (g.id === old.id ? out : g));
        return json(out);
      }
      if (method === "DELETE" && seg.length === 2) {
        t.grafana = t.grafana.filter((g) => g.id !== old.id);
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && seg.length === 3 && c === "test") return json({ ok: true, version: "11.0.0", message: null, dashboards: 0 });
      if (method === "GET" && seg.length === 3 && c === "dashboards") return seeded(t.grafanaDashboards[old.id]);
    }
    return null;
  }
  if (a === "import" && method === "POST" && seg.length === 2) {
    if (b === "preview") return seeded(t.previews[previewKey(body.input as ImportInput)]);
    if (b === "commit") {
      if (!Array.isArray(t.commits)) return seeded(t.commits);
      const out = t.commits.length > 1 ? t.commits.shift() : t.commits[0];
      return seeded(out, 201);
    }
  }
  if (a === "dashboards" && b) {
    if (method === "GET" && seg.length === 3 && c === "origin") return json(t.origins[b] ?? null);
    if (method === "POST" && seg.length === 4 && c === "update-from-source" && d === "preview") return seeded(t.updatePreviews[b]);
    if (method === "POST" && seg.length === 3 && c === "update-from-source") return seeded(t.updates[b]);
  }
  return null;
}
