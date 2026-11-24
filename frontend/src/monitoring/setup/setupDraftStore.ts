// The setup draft kept in this browser, one per Monitoring workspace tab, so a setup left mid-way
// comes back when setup opens again in that tab. Storage can be blocked, full or tampered with:
// every access is caught, and an entry that can't be read is ignored.
//
// Secrets never reach storage. A new source is copied field by field (never spread), without its
// password, token, API key, client key or header values; an address with a sign-in, a query or a
// fragment is cut back to its host and path. A pick that lost something is marked `secretsDropped`
// and comes back unticked. The "add by hand" form being typed is not in the draft at all.

import type { AuthIn, AuthType, FilterOrigin, ProjectKind, Reach, Scheme, SourceIn, SourceType } from "../api/types";
import type { SetupDraft, SetupInstall, SetupPick, SetupStep } from "./setupModel";

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
function plainUrl(url: string): string {
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

/** A pick as it may be kept. */
function keepablePick(p: SetupPick): SetupPick {
  if (!("new" in p.source)) return { ...p, source: { existingId: p.source.existingId } };
  const { source, dropped } = keepableSource(p.source.new);
  const detail = p.detail === p.source.new.url ? (source.url ?? "") : p.detail;
  return { ...p, detail, source: { new: source }, ...(dropped || p.secretsDropped ? { secretsDropped: true } : {}) };
}

/** Keeps the tab's draft. Never throws. */
export function writeSetupDraft(tabId: string, start: string, draft: SetupDraft, named: boolean): void {
  try {
    const s = store();
    if (!s) return;
    const kept: Stored = { v: 1, start, named, draft: { ...draft, picks: draft.picks.map(keepablePick) } };
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

const STEPS: readonly SetupStep[] = [1, 2, 4];
const isKind = oneOf<ProjectKind>(["kubernetes", "docker", "servers", "custom"]);
const isType = oneOf<SourceType>(["prometheus", "loki", "alertmanager"]);
const isReach = oneOf<Reach>(["url", "cluster"]);
const isScheme = oneOf<Scheme>(["http", "https"]);
const isAuthType = oneOf<AuthType>(["none", "basic", "bearer", "api_key", "mtls"]);
const isOrigin = oneOf<FilterOrigin>(["auto", "user", "none"]);

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
  return {
    named: x.named,
    draft: {
      step: d.step as SetupStep, kind: d.kind as ProjectKind | null, clusterId: d.clusterId, picks: picks as SetupPick[], name: d.name,
      ...(install ? { install } : {}),
    },
  };
}
