// Dashboard drafts kept in this browser: one entry per dashboard under `omnikrux.monitoring.draft.`.
// Storage can be blocked, full or tampered with, so every access is caught, and an entry that
// can't be read is removed rather than offered.

import { PANEL_TYPES, type DashboardSpec } from "../schema";

export const DRAFT_PREFIX = "omnikrux.monitoring.draft.";
const PROBE = `${DRAFT_PREFIX}probe`;

export interface StoredDraft {
  v: 1;
  dashboardId: string;
  /** The saved version the draft started from: a save sends it, so an older one is reviewed first. */
  baseVersion: number;
  savedAt: number;
  draft: DashboardSpec;
  /** JSON text that didn't parse or validate when the draft was kept; else null. */
  jsonText: string | null;
}

const MAX_TEXT = 4_000_000;
const key = (dashboardId: string) => `${DRAFT_PREFIX}${dashboardId}`;

function store(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Keeps the draft; false when storage refused it (blocked or full). */
export function writeDraft(d: StoredDraft): boolean {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(key(d.dashboardId), JSON.stringify(d));
    return true;
  } catch {
    return false;
  }
}

export function removeDraft(dashboardId: string): void {
  try {
    store()?.removeItem(key(dashboardId));
  } catch {
    // Nothing to do: a draft that can't be removed can't be read either.
  }
}

/** Whether this browser keeps drafts: a probe written and removed. */
export function draftsWork(): boolean {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(PROBE, "1");
    s.removeItem(PROBE);
    return true;
  } catch {
    return false;
  }
}

const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const count = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

/** Enough of a document for the page to draw it: the editor reports anything else as problems. */
function looksLikeDocument(x: unknown): x is DashboardSpec {
  if (!record(x) || x.schemaVersion !== 1 || typeof x.title !== "string" || typeof x.description !== "string") return false;
  if (!record(x.time) || typeof x.time.from !== "string" || typeof x.time.to !== "string") return false;
  if (!(x.refresh === null || typeof x.refresh === "string") || !Array.isArray(x.variables) || !x.variables.every(record)) return false;
  if (!Array.isArray(x.panels)) return false;
  return x.panels.every((p) => record(p) && typeof p.id === "string" && typeof p.title === "string"
    && (PANEL_TYPES as readonly unknown[]).includes(p.type) && record(p.options) && Array.isArray(p.queries) && p.queries.every(record)
    && record(p.layout) && count(p.layout.x) && count(p.layout.y) && count(p.layout.w) && count(p.layout.h));
}

function parse(raw: string, dashboardId: string): StoredDraft | null {
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record(x) || x.v !== 1 || x.dashboardId !== dashboardId || !count(x.baseVersion) || !Number.isInteger(x.baseVersion) || !count(x.savedAt)) return null;
  if (!(x.jsonText === null || (typeof x.jsonText === "string" && x.jsonText.length <= MAX_TEXT))) return null;
  if (!looksLikeDocument(x.draft)) return null;
  return { v: 1, dashboardId, baseVersion: x.baseVersion, savedAt: x.savedAt, draft: x.draft, jsonText: x.jsonText };
}

/** The draft kept for a dashboard; an entry that can't be read is removed and gives null. */
export function readDraft(dashboardId: string): StoredDraft | null {
  let raw: string | null;
  try {
    raw = store()?.getItem(key(dashboardId)) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  const draft = parse(raw, dashboardId);
  if (!draft) removeDraft(dashboardId);
  return draft;
}
