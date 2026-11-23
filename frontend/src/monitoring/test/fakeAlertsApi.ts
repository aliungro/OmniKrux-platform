// The alerts routes of the fake Monitoring API (`/api/monitoring/alerts/*`): rules, contact points,
// silences, the overview, panel states, capabilities, channels, the dry run and syncs. Answers what
// is seeded; applies the backend's copy for the cases the UI tests use (name rule, gone, a rule
// changed elsewhere, a review that went stale). Not a model of the backend.
import type {
  AlertChangeOut, CapabilityOut, ChannelsOut, ContactPointOut, DryRunOut, HistoryOut, OverviewOut, PanelAlertStateOut,
  RuleIn, RuleOut, SilenceOut, SyncOut,
} from "../alerts/api";

/** A seeded refusal. */
export interface FakeRefusal {
  error: { code?: string; message: string };
  status: number;
}

export interface FakeAlertsState {
  rules: RuleOut[];
  /** A rule's history by rule id, newest first. */
  history: Record<string, HistoryOut[]>;
  contactPoints: ContactPointOut[];
  silences: SilenceOut[];
  overview: OverviewOut;
  /** By dashboard id, then panel id. */
  panelStates: Record<string, Record<string, PanelAlertStateOut>>;
  /** The dry run's answer, or its refusal (also a 502 or 504 with `detail.message`). */
  dryRun: DryRunOut | FakeRefusal;
  capabilities: CapabilityOut[];
  /** By project id; none seeded answers no Alertmanager. */
  channels: Record<string, ChannelsOut>;
  /** By target id: what `POST /targets/{id}/sync` answers; none seeded answers "gone". */
  syncAnswers: Record<string, SyncOut | FakeRefusal>;
  /** What a dashboard save answers as `alert_changes`. */
  alertChangesOnSave: AlertChangeOut[];
  /** What a rule create or save answers as `changes`. */
  ruleChanges: AlertChangeOut[];
  /** By project or group id: the rules its delete review names (an empty list is left out, as the server does). */
  ownerRules: Record<string, { alert_rules?: { id: string; name: string }[]; cluster_rules?: { id: string; name: string }[] }>;
}

const NOW = "2026-01-01T00:00:00Z";
const TOKEN = "review-token";

const RULE_GONE = "That alert rule no longer exists.";
const POINT_GONE = "That contact point doesn't exist anymore. It may have been removed.";
const SILENCE_GONE = "That silence no longer exists.";
const NAME_COPY = "Use 1 to 120 characters, without line breaks.";
const REVIEW_CHANGED = "Something changed since the review. Review it again.";
const TOOL_RULE = "This rule runs in the tool, which keeps checking it. Silence it instead.";
const SENT = "Sent. Check that the test message arrived.";
const NEEDS_ALERTMANAGER = "Say which Alertmanager holds the silence.";
const changedElsewhere = (current: number) =>
  `This rule was changed somewhere else since you opened it (version ${current}). Open it again.`;

export function emptyAlertsState(): FakeAlertsState {
  return {
    rules: [],
    history: {},
    contactPoints: [],
    silences: [],
    overview: {
      counts: { rules: 0, firing: 0, pending: 0, cant_check: 0, not_applied: 0 },
      firing: [],
      by_project: {},
      by_group: {},
      engine: { enabled: true, running: true, last_tick_at: NOW, rules: 0, behind: 0, note: "" },
    },
    panelStates: {},
    dryRun: { start: 0, end: 21600, step: 60, fired: 0, firing_now: false, periods: [], projects: [], candidates: [], took_ms: 1 },
    capabilities: [],
    channels: {},
    syncAnswers: {},
    alertChangesOnSave: [],
    ruleChanges: [],
    ownerRules: {},
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (detail: unknown, status: number) => json({ detail }, status);
const coded = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  refuse({ code, message, ...extra }, status);
const isRefusal = (x: unknown): x is FakeRefusal => typeof x === "object" && x !== null && "error" in x && "status" in x;
const refusal = (r: FakeRefusal) => coded(r.status, r.error.code ?? "bad_request", r.error.message);

type Obj = Record<string, unknown>;

function cleanName(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length >= 1 && name.length <= max && !/[\r\n]/.test(name) ? name : null;
}

export interface AlertsContext {
  state: FakeAlertsState;
  nextId(prefix: string): string;
  project(id: string): { id: string; name: string } | undefined;
  group(id: string): { id: string; name: string } | undefined;
}

/**
 * The response for `seg` (the path after `alerts/`), or null when it isn't an alerts route.
 * `rules` is read and written in place.
 */
export function alertsRoute(
  ctx: AlertsContext,
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: Obj,
  dashboard: (id: string) => { version: number; out: unknown } | undefined,
): Response {
  const { state } = ctx;
  const [a, b, c] = seg;
  const is = (m: string, ...pattern: (string | null)[]) =>
    method === m && seg.length === pattern.length && pattern.every((p, i) => p === null || p === seg[i]);
  const rule = (id: string) => state.rules.find((r) => r.id === id);
  const scopeName = (kind: string, id: string) => (kind === "project" ? ctx.project(id) : ctx.group(id))?.name;

  // --- rules
  if (is("GET", "rules")) {
    const kind = query.get("scope_kind");
    const id = query.get("scope_id");
    return json(state.rules.filter((r) => (kind === null || r.scope.kind === kind) && (id === null || r.scope.id === id)));
  }
  if (is("POST", "rules")) {
    const input = body as unknown as RuleIn;
    if (cleanName(input.name, 120) === null) return coded(422, "invalid_rule", NAME_COPY, { field: "name" });
    const name = scopeName(input.scope?.kind, input.scope?.id);
    if (name === undefined) return coded(404, "unknown_scope", "That project or group no longer exists.");
    const made = ruleOut(ctx.nextId("r"), 1, input, name, "page");
    state.rules.push(made);
    return json({ rule: made, changes: state.ruleChanges }, 201);
  }
  if (a === "rules" && b) {
    const found = rule(b);
    if (!found) return coded(404, "not_found", RULE_GONE);
    if (is("GET", "rules", b)) return json(found);
    if (is("GET", "rules", b, "history")) return json(state.history[b] ?? []);
    if (is("PUT", "rules", b)) {
      const input = body as unknown as RuleIn & { base_version?: number };
      if (found.version !== input.base_version) {
        return coded(409, "rule_changed", changedElsewhere(found.version), { current_version: found.version });
      }
      if (cleanName(input.name, 120) === null) return coded(422, "invalid_rule", NAME_COPY, { field: "name" });
      const made = ruleOut(found.id, found.version + 1, input, found.scope.name, found.origin, found);
      state.rules[state.rules.indexOf(found)] = made;
      return json({ rule: made, changes: state.ruleChanges });
    }
    if (is("POST", "rules", b, "pause") || is("POST", "rules", b, "resume")) {
      if (c === "pause" && found.targets.some((t) => t.engine === "tool" && !t.leaving)) return coded(409, "tool_rule", TOOL_RULE);
      found.paused = c === "pause";
      return json(found);
    }
    if (is("GET", "rules", b, "delete-review")) {
      return json({ id: found.id, name: found.name, panel: found.panel, cluster_removals: [], loki_removals: [], token: TOKEN });
    }
    if (is("DELETE", "rules", b)) {
      if (query.get("token") !== TOKEN) return coded(409, "rule_changed", REVIEW_CHANGED);
      state.rules = state.rules.filter((r) => r !== found);
      return json({ rule: null, changes: [] });
    }
    if (is("POST", "rules", b, "attach")) {
      const d = dashboard(String(body.dashboard_id));
      if (!d) return coded(404, "not_found", "That dashboard no longer exists.");
      if (body.base_version !== d.version) return coded(409, "version_conflict", `This dashboard was saved somewhere else since you started (version ${d.version}). Review the differences before saving.`, { current_version: d.version });
      const out = d.out as { title: string; spec: { panels: { id: string; title: string }[] } };
      const panel = out.spec.panels.find((p) => p.id === body.panel_id);
      if (!panel) return coded(422, "invalid_rule", "That panel no longer exists.", { field: "panel" });
      found.origin = "panel";
      found.panel = { dashboard_id: String(body.dashboard_id), dashboard_title: out.title, panel_id: panel.id, panel_title: panel.title };
      return json({ dashboard: { ...out, alert_changes: [] }, rule: found });
    }
  }
  if (is("POST", "targets", null, "sync")) {
    const answer = state.syncAnswers[b];
    if (answer === undefined) return coded(404, "not_found", RULE_GONE);
    return isRefusal(answer) ? refusal(answer) : json(answer);
  }

  // --- reading
  if (is("GET", "overview")) return json(state.overview);
  if (is("GET", "panel-states")) return json(state.panelStates[query.get("dashboard_id") ?? ""] ?? {});
  if (is("GET", "capabilities")) return json(state.capabilities);
  if (is("GET", "channels")) {
    const id = query.get("project_id") ?? "";
    return json(state.channels[id] ?? { alertmanager: null, channels: [], message: null });
  }
  if (is("POST", "dry-run")) return isRefusal(state.dryRun) ? refusal(state.dryRun) : json(state.dryRun);

  // --- contact points
  if (a === "contact-points") {
    const points = state.contactPoints;
    const point = (id: string) => points.find((p) => p.id === id);
    const secretsOf = (secrets: unknown): string[] =>
      Object.entries((secrets ?? {}) as Obj).filter(([, v]) => typeof v === "string" && v !== "").map(([k]) => k);
    const taken = (name: string, besides?: string) =>
      points.some((p) => p.id !== besides && p.name.toLowerCase() === name.toLowerCase());
    if (is("GET", "contact-points")) return json(points);
    if (is("POST", "contact-points")) {
      const name = cleanName(body.name, 80);
      if (name === null) return refuse("Names are 1 to 80 characters, without line breaks.", 422);
      if (taken(name)) return refuse(`A contact point named "${name}" already exists. Pick another name.`, 409);
      const made: ContactPointOut = {
        id: ctx.nextId("c"), name, type: body.type as ContactPointOut["type"], settings: (body.settings ?? {}) as Obj,
        secrets_set: secretsOf(body.secrets), summary: String(body.type), used_by: [], last_delivery: null, created_at: NOW, updated_at: NOW,
      };
      points.push(made);
      return json(made, 201);
    }
    if (is("POST", "contact-points", "test")) return json({ ok: true, message: SENT });
    if (b !== undefined && b !== "test") {
      const found = point(b);
      if (!found) return refuse(POINT_GONE, 404);
      if (is("PATCH", "contact-points", b)) {
        if (body.name != null) {
          const name = cleanName(body.name, 80);
          if (name === null) return refuse("Names are 1 to 80 characters, without line breaks.", 422);
          if (taken(name, b)) return refuse(`A contact point named "${name}" already exists. Pick another name.`, 409);
          found.name = name;
        }
        if (body.settings && typeof body.settings === "object") found.settings = { ...found.settings, ...(body.settings as Obj) };
        for (const [key, value] of Object.entries((body.secrets ?? {}) as Obj)) {
          if (value === "") found.secrets_set = found.secrets_set.filter((k) => k !== key);
          else if (typeof value === "string" && !found.secrets_set.includes(key)) found.secrets_set.push(key);
        }
        return json(found);
      }
      if (is("POST", "contact-points", b, "test")) return json({ ok: true, message: SENT });
      if (is("GET", "contact-points", b, "delete-review")) return json({ id: found.id, name: found.name, used_by: found.used_by, token: TOKEN });
      if (is("DELETE", "contact-points", b)) {
        if (query.get("token") !== TOKEN) return refuse(REVIEW_CHANGED, 409);
        state.contactPoints = points.filter((p) => p !== found);
        return new Response(null, { status: 204 });
      }
    }
  }

  // --- silences
  if (a === "silences") {
    if (is("GET", "silences")) return json({ silences: state.silences, problems: [] });
    const where = body.where as { kind?: string; source_id?: string } | undefined;
    const needsSource = where?.kind === "alertmanager" && !where.source_id;
    if (is("POST", "silences", "preview")) {
      return needsSource ? coded(422, "invalid_silence", NEEDS_ALERTMANAGER, { field: "where" }) : json({ affects: 0, rules: [] });
    }
    if (is("POST", "silences")) {
      if (needsSource) return coded(422, "invalid_silence", NEEDS_ALERTMANAGER, { field: "where" });
      const made: SilenceOut = {
        id: ctx.nextId("sil"), where: { kind: (where?.kind ?? "omnikrux") as "omnikrux", source_id: where?.source_id ?? null, source_name: null },
        matchers: String(body.matchers ?? ""), starts_at: String(body.starts_at ?? NOW), ends_at: String(body.ends_at ?? NOW),
        comment: String(body.comment ?? ""), created_by: "fake", state: "active", affects: 0,
      };
      state.silences.push(made);
      return json(made, 201);
    }
    if (method === "DELETE" && seg.length === 3) {
      const found = state.silences.find((s) => s.id === c && s.where.kind === b);
      if (!found) return coded(404, "not_found", SILENCE_GONE);
      found.state = "expired";
      return new Response(null, { status: 204 });
    }
  }
  return refuse("Not found", 404);
}

/** A stored rule from the body of a create or save; targets come from the seed, never invented. */
function ruleOut(id: string, version: number, input: RuleIn, scopeName: string, origin: RuleOut["origin"], was?: RuleOut): RuleOut {
  return {
    id, name: input.name.trim(), scope: { kind: input.scope.kind, id: input.scope.id, name: scopeName },
    source_type: input.source.type, source_id: input.source.id, expr: input.expr, condition: { ...input.condition },
    severity: input.severity, message: input.message,
    contact_points: input.contact_point_ids.map((cid) => was?.contact_points.find((p) => p.id === cid) ?? { id: cid, name: cid, type: "webhook" }),
    engine: input.engine, channel: input.channel, paused: was?.paused ?? false, origin, panel: was?.panel ?? null,
    state: was?.state ?? "waiting", firing_since: was?.firing_since ?? null, targets: was?.targets ?? [], removing: false,
    version, created_at: was?.created_at ?? NOW, updated_at: NOW,
  };
}
