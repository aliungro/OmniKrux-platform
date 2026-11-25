// The setup draft kept in this browser, one per Monitoring workspace tab, so a setup left mid-way
// comes back when setup opens again in that tab. Storage can be blocked, full or tampered with:
// every access is caught, and an entry that can't be read is ignored.
//
// Secrets never reach storage. The draft, each pick and each new source are copied field by field
// (never spread: a field added later is left out until it is named here); a new source goes without its
// password, token, API key, client key or header values; an address with a sign-in, a query or a
// fragment is cut back to its host and path. A pick that lost something is marked `secretsDropped`
// and comes back unticked. The "add by hand" form being typed is not in the draft at all. The
// Grafana import keeps its connection without its password or token (`keepableGrafana`), its label
// and the chosen dashboards; its preview is never kept (it is made again). A connection that lost
// its secret is marked `secretsDropped` and asks for its sign-in again.

import type { AuthIn, AuthType, FilterOrigin, ProjectKind, Reach, Scheme, SourceIn, SourceType } from "../api/types";
import type { GrafanaAuth, GrafanaAuthIn, GrafanaIn } from "../transfer/api";
import type { SetupDraft, SetupImport, SetupInstall, SetupPick, SetupStep } from "./setupModel";

export const SETUP_DRAFT_PREFIX = "omnikrux.monitoring.setupDraft.";
export const SECRET_NOT_KEPT = "Its secret wasn't kept. Enter it again to use this source.";

const key = (tabId: string) => `${SETUP_DRAFT_PREFIX}${tabId}`;

interface Stored {
  v: 1;
  /** The cluster setup was started for ("" for none): a draft comes back only to the same start. */
  start: string;
  /** Whether a name was typed (else it follows what is monitored). */
  named: boolean;
  draft: SetupDraft;
}

export interface RestoredDraft {
  draft: SetupDraft;
  named: boolean;
}

function store(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

const filled = (v: unknown): boolean => typeof v === "string" && v !== "";

/** An address without a sign-in, a query or a fragment (the server refuses those anyway). */
export function plainUrl(url: string): string {
  if (!/[@?#]/.test(url)) return url;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "";
  }
}

/** A new source as it may be kept: only the fields that hold no secret, and whether one was dropped. */
export function keepableSource(src: SourceIn): { source: SourceIn; dropped: boolean } {
  let dropped = false;
  const out: SourceIn = { type: src.type, reach: src.reach };
  if (src.name !== undefined) out.name = src.name;
  if (src.url !== undefined && src.url !== null) {
    const url = plainUrl(src.url);
    if (url !== src.url) dropped = true;
    out.url = url;
  } else if (src.url === null) {
    out.url = null;
  }
  if (src.cluster_id !== undefined) out.cluster_id = src.cluster_id;
  if (src.namespace !== undefined) out.namespace = src.namespace;
  if (src.service !== undefined) out.service = src.service;
  if (src.port !== undefined) out.port = src.port;
  if (src.scheme !== undefined) out.scheme = src.scheme;
  if (src.path_prefix !== undefined) out.path_prefix = src.path_prefix;
  if (src.ca_pem !== undefined) out.ca_pem = src.ca_pem;
  if (src.auth) {
    const a = src.auth;
    if (filled(a.password) || filled(a.token) || filled(a.api_key) || filled(a.client_key_pem)) dropped = true;
    const auth: AuthIn = {};
    if (a.type !== undefined) auth.type = a.type;
    if (a.username !== undefined) auth.username = a.username;
    if (a.header_name !== undefined) auth.header_name = a.header_name;
    if (a.client_cert_pem !== undefined) auth.client_cert_pem = a.client_cert_pem;
    out.auth = auth;
  }
  if (src.headers) {
    if (src.headers.some((h) => filled(h.value))) dropped = true;
    out.headers = src.headers.map((h) => ({ name: h.name }));
  }
  return { source: out, dropped };
}

/** A Grafana connection as it may be kept: named fields only, never its password or token. */
export function keepableGrafana(g: GrafanaIn): { connection: GrafanaIn; dropped: boolean } {
  let dropped = false;
  const out: GrafanaIn = { reach: g.reach };
  if (g.name !== undefined) out.name = g.name;
  if (g.url !== undefined && g.url !== null) {
    const url = plainUrl(g.url);
    if (url !== g.url) dropped = true;
    out.url = url;
  } else if (g.url === null) {
    out.url = null;
  }
  if (g.cluster_id !== undefined) out.cluster_id = g.cluster_id;
  if (g.namespace !== undefined) out.namespace = g.namespace;
  if (g.service !== undefined) out.service = g.service;
  if (g.port !== undefined) out.port = g.port;
  if (g.scheme !== undefined) out.scheme = g.scheme;
  if (g.path_prefix !== undefined) out.path_prefix = g.path_prefix;
  if (g.auth) {
    if (filled(g.auth.password) || filled(g.auth.token)) dropped = true;
    const auth: GrafanaAuthIn = {};
    if (g.auth.type !== undefined) auth.type = g.auth.type;
    if (g.auth.username !== undefined) auth.username = g.auth.username;
    out.auth = auth;
  }
  return { connection: out, dropped };
}

/** At most this many dashboards are chosen for one import (F15). */
const MAX_UIDS = 100;

/**
 * The import as it may be kept, or undefined when it doesn't have the import's shape (then it is
 * left out): never the preview, never a secret.
 */
function keepableImport(x: SetupImport): SetupImport | undefined {
  const c: unknown = x.connection;
  if (!isObj(c) || !isGrafanaReach(c.reach) || !str(x.label) || !Array.isArray(x.uids) || !x.uids.every(str)) return undefined;
  const kept = keepableGrafana(c as unknown as GrafanaIn);
  return {
    connection: kept.connection, label: x.label, uids: x.uids.slice(0, MAX_UIDS), preview: null,
    ...(kept.dropped || x.secretsDropped === true ? { secretsDropped: true } : {}),
    ...(x.chosen === true ? { chosen: true } : {}),
  };
}

/**
 * A pick as it may be kept: named fields only (never spread), so a field added to `SetupPick`
 * later is left out until it is named here, after checking it holds no secret.
 */
function keepablePick(p: SetupPick): SetupPick {
  let source: SetupPick["source"];
  let detail = p.detail;
  let dropped = p.secretsDropped === true;
  if ("new" in p.source) {
    const kept = keepableSource(p.source.new);
    source = { new: kept.source };
    if (p.detail === p.source.new.url) detail = kept.source.url ?? "";
    dropped = dropped || kept.dropped;
  } else {
    source = { existingId: p.source.existingId };
  }
  return {
    key: p.key, label: p.label, detail, use: p.use, source, filter: p.filter, origin: p.origin, reason: p.reason,
    ...(p.suggestedFor !== undefined ? { suggestedFor: p.suggestedFor } : {}),
    ...(dropped ? { secretsDropped: true } : {}),
  };
}

/**
 * The draft as it may be kept: named fields only (never spread). A field added to `SetupDraft`
 * later (M6's Grafana connection, which may hold a token) is left out until it is named here.
 */
function keepableDraft(d: SetupDraft): SetupDraft {
  const importFrom = d.importFrom ? keepableImport(d.importFrom) : undefined;
  return {
    step: d.step, kind: d.kind, clusterId: d.clusterId, name: d.name, picks: d.picks.map(keepablePick),
    ...(d.install ? { install: { metrics: d.install.metrics === true, logs: d.install.logs === true } } : {}),
    ...(importFrom ? { importFrom } : {}),
  };
}

/** Keeps the tab's draft. Never throws. */
export function writeSetupDraft(tabId: string, start: string, draft: SetupDraft, named: boolean): void {
  try {
    const s = store();
    if (!s) return;
    const kept: Stored = { v: 1, start, named: named === true, draft: keepableDraft(draft) };
    s.setItem(key(tabId), JSON.stringify(kept));
  } catch {
    // Blocked or full: the setup still works, it just won't come back.
  }
}

export function removeSetupDraft(tabId: string): void {
  try {
    store()?.removeItem(key(tabId));
  } catch {
    // Nothing to do: a draft that can't be removed can't be read either.
  }
}

/** Removes the drafts of tabs that are gone. */
export function pruneSetupDrafts(tabIds: Iterable<string>): void {
  try {
    const s = store();
    if (!s) return;
    const keep = new Set([...tabIds].map(key));
    const gone: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null && k.startsWith(SETUP_DRAFT_PREFIX) && !keep.has(k)) gone.push(k);
    }
    for (const k of gone) s.removeItem(k);
  } catch {
    // Storage is blocked: nothing was kept either.
  }
}

// --- Reading back: anything that doesn't fit is ignored -------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === "string";
const strOrNull = (x: unknown): x is string | null => x === null || typeof x === "string";
const optional = <T,>(x: unknown, ok: (y: unknown) => y is T): boolean => x === undefined || ok(x);
const oneOf = <T extends string>(values: readonly T[]) => (x: unknown): x is T => typeof x === "string" && (values as readonly string[]).includes(x);

const STEPS: readonly SetupStep[] = [1, 2, 3, 4];
const isKind = oneOf<ProjectKind>(["kubernetes", "docker", "servers", "custom"]);
const isType = oneOf<SourceType>(["prometheus", "loki", "alertmanager"]);
const isReach = oneOf<Reach>(["url", "cluster"]);
const isScheme = oneOf<Scheme>(["http", "https"]);
const isAuthType = oneOf<AuthType>(["none", "basic", "bearer", "api_key", "mtls"]);
const isOrigin = oneOf<FilterOrigin>(["auto", "user", "none"]);
const isGrafanaReach = oneOf<Reach>(["url", "cluster"]);
const isGrafanaAuth = oneOf<GrafanaAuth>(["none", "basic", "bearer"]);

function readSource(x: unknown): SourceIn | null {
  if (!isObj(x) || !isType(x.type) || !isReach(x.reach)) return null;
  for (const f of ["name", "url", "cluster_id", "namespace", "service", "port", "ca_pem"] as const) {
    if (!optional(x[f], strOrNull)) return null;
  }
  if (!optional(x.scheme, isScheme) || !optional(x.path_prefix, str)) return null;
  if (x.auth !== undefined) {
    const a = x.auth;
    if (!isObj(a) || !optional(a.type, isAuthType)) return null;
    for (const f of ["username", "header_name", "client_cert_pem"] as const) if (!optional(a[f], strOrNull)) return null;
  }
  if (x.headers !== undefined && !(Array.isArray(x.headers) && x.headers.every((h) => isObj(h) && str(h.name)))) return null;
  // What comes back is copied again without secrets, whatever the entry held.
  return keepableSource(x as unknown as SourceIn).source;
}

function readPick(x: unknown): SetupPick | null {
  if (!isObj(x) || !str(x.key) || !str(x.label) || !str(x.detail) || typeof x.use !== "boolean") return null;
  if (!str(x.filter) || !isOrigin(x.origin) || !strOrNull(x.reason) || !optional(x.suggestedFor, str)) return null;
  if (!optional(x.secretsDropped, (y): y is boolean => typeof y === "boolean")) return null;
  let source: SetupPick["source"];
  if (isObj(x.source) && str(x.source.existingId)) {
    source = { existingId: x.source.existingId };
  } else if (isObj(x.source) && "new" in x.source) {
    const made = readSource(x.source.new);
    if (made === null) return null;
    source = { new: made };
  } else {
    return null;
  }
  const lost = x.secretsDropped === true;
  return {
    key: x.key, label: x.label, detail: x.detail, use: lost ? false : x.use, source, filter: x.filter, origin: x.origin, reason: x.reason,
    ...(str(x.suggestedFor) ? { suggestedFor: x.suggestedFor } : {}),
    ...(lost ? { secretsDropped: true } : {}),
  };
}

function readImport(x: unknown): SetupImport | undefined | null {
  if (x === undefined || x === null) return undefined;
  if (!isObj(x) || !str(x.label) || !Array.isArray(x.uids) || !x.uids.every(str) || x.uids.length > MAX_UIDS) return null;
  const bool = (y: unknown): y is boolean => typeof y === "boolean";
  if (!optional(x.secretsDropped, bool) || !optional(x.chosen, bool)) return null;
  const c = x.connection;
  if (!isObj(c) || !isGrafanaReach(c.reach)) return null;
  for (const f of ["name", "url", "cluster_id", "namespace", "service", "port"] as const) if (!optional(c[f], strOrNull)) return null;
  if (!optional(c.scheme, isScheme) || !optional(c.path_prefix, str)) return null;
  if (c.auth !== undefined && !(isObj(c.auth) && optional(c.auth.type, isGrafanaAuth) && optional(c.auth.username, strOrNull))) return null;
  // What comes back is copied again without secrets, whatever the entry held.
  const kept = keepableGrafana(c as unknown as GrafanaIn);
  return {
    connection: kept.connection, label: x.label, uids: x.uids as string[], preview: null,
    ...(kept.dropped || x.secretsDropped === true ? { secretsDropped: true } : {}),
    ...(x.chosen === true ? { chosen: true } : {}),
  };
}

function readInstall(x: unknown): SetupInstall | undefined | null {
  if (x === undefined) return undefined;
  return isObj(x) && typeof x.metrics === "boolean" && typeof x.logs === "boolean" ? { metrics: x.metrics, logs: x.logs } : null;
}

/** The tab's draft for this start, or null (none, another start, or one that can't be read). */
export function readSetupDraft(tabId: string, start: string): RestoredDraft | null {
  let raw: string | null;
  try {
    raw = store()?.getItem(key(tabId)) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(x) || x.v !== 1 || x.start !== start || typeof x.named !== "boolean" || !isObj(x.draft)) return null;
  const d = x.draft;
  if (!STEPS.includes(d.step as SetupStep) || !(d.kind === null || isKind(d.kind)) || !strOrNull(d.clusterId) || !str(d.name)) return null;
  if (!Array.isArray(d.picks)) return null;
  const picks = d.picks.map(readPick);
  if (picks.some((p) => p === null)) return null;
  const install = readInstall(d.install);
  if (install === null) return null;
  const importFrom = readImport(d.importFrom);
  if (importFrom === null) return null;
  return {
    named: x.named,
    draft: {
      step: d.step as SetupStep, kind: d.kind as ProjectKind | null, clusterId: d.clusterId, picks: picks as SetupPick[], name: d.name,
      ...(install ? { install } : {}),
      ...(importFrom ? { importFrom } : {}),
    },
  };
}
