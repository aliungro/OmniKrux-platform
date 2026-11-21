// Edit mode as data: the saved document it started from (`base`), the draft, the selected panel
// and how often each panel changed (`changes`, the `changeId` its chart uses). Every action that
// changes the draft keeps unchanged panel objects identical, so only the panels it touched render
// again. Loading a document never compacts; a user's move, resize, add or remove does (F34).

import { compact, freeSpot, grow, nudge, placePanel, type Dir } from "../layout";
import {
  DEFAULT_SIZES, newPanel, nextPanelId, parseDashboardJson,
  type DashboardSpec, type Layout, type OwnerKind, type PanelSpec, type PanelType, type Problem,
} from "../schema";

export type SideTab = "query" | "chart" | "options" | "alert";

export interface EditingState {
  mode: "edit";
  dashboardId: string;
  /** The saved version the draft started from: a save sends it, and the server refuses an older one. */
  baseVersion: number;
  base: DashboardSpec;
  draft: DashboardSpec;
  selected: string | null;
  sideTab: SideTab;
  /** JSON text that doesn't parse or validate (the draft keeps its last valid version); else null. */
  jsonText: string | null;
  jsonProblems: Problem[];
  /** Per panel: how many times it changed in this session. Absent: never. */
  changes: Record<string, number>;
  /** This session's id in browser storage: it removes only a draft it wrote itself. */
  writer: string;
}

export type EditorState = { mode: "view" } | EditingState;

export type EditorAction =
  | { type: "start"; dashboardId: string; version: number; spec: DashboardSpec; writer?: string }
  /** A stored draft or a live session back in edit mode; `ownerKind` re-checks kept JSON text for its problems. */
  | { type: "resume"; dashboardId: string; baseVersion: number; base: DashboardSpec; draft: DashboardSpec; jsonText: string | null; ownerKind?: OwnerKind; writer?: string }
  | { type: "updatePanel"; id: string; update: (p: PanelSpec) => PanelSpec }
  | { type: "addPanel"; panelType: PanelType; at?: { x: number; y: number } }
  | { type: "removePanel"; id: string }
  | { type: "place"; id: string; to: Layout }
  | { type: "nudge" | "grow"; id: string; dir: Dir }
  | { type: "select"; id: string | null }
  | { type: "sideTab"; tab: SideTab }
  | { type: "setJson"; text: string; ownerKind: OwnerKind }
  | { type: "setDashboard"; update: (d: DashboardSpec) => DashboardSpec }
  /** `sent`: the draft the save sent. A draft changed since then stays in edit mode on the new base. */
  | { type: "saved"; version: number; spec: DashboardSpec; sent?: DashboardSpec }
  | { type: "rebase"; version: number; base: DashboardSpec }
  | { type: "discard" };

export const VIEW: EditorState = { mode: "view" };

/** Structural equality for JSON values; key order doesn't matter. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameJson(x, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Whether the draft differs from the version it started from. */
export function isDirty(state: EditorState): boolean {
  return state.mode === "edit" && !sameJson(state.draft, state.base);
}

/** Panels whose JSON differs between the two documents, plus panels only `next` has. */
export function changedPanelIds(prev: DashboardSpec, next: DashboardSpec): string[] {
  const before = new Map(prev.panels.map((p) => [p.id, p]));
  return next.panels.filter((p) => { const was = before.get(p.id); return was === undefined || (was !== p && !sameJson(was, p)); }).map((p) => p.id);
}

/** `next`'s panels, with every panel equal to the one `prev` had under its id kept as that object. */
function reuse(prev: PanelSpec[], next: PanelSpec[]): PanelSpec[] {
  const before = new Map(prev.map((p) => [p.id, p]));
  let same = prev.length === next.length;
  const out = next.map((p, i) => {
    const was = before.get(p.id);
    const kept = was !== undefined && (was === p || sameJson(was, p)) ? was : p;
    if (kept !== prev[i]) same = false;
    return kept;
  });
  return same ? prev : out;
}

/** The layout functions sort; the document keeps its own panel order (stable JSON and diffs). */
function inOrder(prev: PanelSpec[], next: PanelSpec[]): PanelSpec[] {
  if (next === prev) return prev;
  const byId = new Map(next.map((p) => [p.id, p]));
  const kept = prev.flatMap((p) => { const n = byId.get(p.id); return n ? [n] : []; });
  const known = new Set(prev.map((p) => p.id));
  return [...kept, ...next.filter((p) => !known.has(p.id))];
}

const bump = (changes: Record<string, number>, ids: readonly string[]) => {
  if (ids.length === 0) return changes;
  const out = { ...changes };
  for (const id of ids) out[id] = (out[id] ?? 0) + 1;
  return out;
};

/**
 * A new draft. `touched` are the panels the user acted on (their `changes` count goes up); panels
 * that only moved out of the way don't flash (F34). A draft change from outside the JSON tab
 * makes the JSON follow the draft again.
 */
function withDraft(state: EditingState, draft: DashboardSpec, touched: readonly string[], extra: Partial<EditingState> = {}): EditingState {
  return { ...state, ...extra, draft, changes: bump(state.changes, touched), jsonText: null, jsonProblems: [] };
}

function withPanels(state: EditingState, next: PanelSpec[], touched: readonly string[], extra: Partial<EditingState> = {}): EditingState {
  const panels = inOrder(state.draft.panels, next);
  if (panels === state.draft.panels && Object.keys(extra).length === 0) return state;
  return withDraft(state, { ...state.draft, panels }, panels === state.draft.panels ? [] : touched, extra);
}

const moved = (prev: PanelSpec[], next: PanelSpec[], id: string) =>
  next !== prev && prev.find((p) => p.id === id) !== next.find((p) => p.id === id);

let writers = 0;
/** A new edit session's storage id. */
export function newWriter(): string {
  return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `w${Date.now()}-${++writers}`;
}

function fresh(dashboardId: string, baseVersion: number, base: DashboardSpec, draft: DashboardSpec, jsonText: string | null, writer = newWriter()): EditingState {
  return { mode: "edit", dashboardId, baseVersion, base, draft, selected: null, sideTab: "query", jsonText, jsonProblems: [], changes: {}, writer };
}

/**
 * A resumed session. Kept JSON text that doesn't parse or validate shows its problems again; text
 * that is valid after all (the rules changed) becomes the draft.
 */
function resumed(action: Extract<EditorAction, { type: "resume" }>): EditingState {
  const state = fresh(action.dashboardId, action.baseVersion, action.base, action.draft, action.jsonText, action.writer);
  if (action.jsonText === null || action.ownerKind === undefined) return state;
  const result = parseDashboardJson(action.jsonText, action.ownerKind);
  return result.ok ? applyDocument(state, result.spec) : { ...state, jsonProblems: result.problems };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === "start") return fresh(action.dashboardId, action.version, action.spec, action.spec, null, action.writer);
  if (action.type === "resume") return resumed(action);
  if (state.mode !== "edit") return state;
  const panels = state.draft.panels;

  switch (action.type) {
    case "updatePanel": {
      const at = panels.findIndex((p) => p.id === action.id);
      if (at === -1) return state;
      const next = action.update(panels[at]);
      if (next === panels[at] || sameJson(next, panels[at])) return state;
      const list = panels.slice();
      list[at] = next;
      return withDraft(state, { ...state.draft, panels: list }, [action.id]);
    }
    case "addPanel": {
      const size = DEFAULT_SIZES[action.panelType];
      const spot = action.at ?? freeSpot(panels, size.w, size.h);
      const id = nextPanelId(state.draft);
      const added = newPanel(action.panelType, id, { ...spot, ...size });
      const placed = placePanel([...panels, added], id, added.layout);
      return withPanels(state, placed, [id], { selected: id, sideTab: "query" });
    }
    case "removePanel": {
      if (!panels.some((p) => p.id === action.id)) return state;
      const rest = compact(panels.filter((p) => p.id !== action.id));
      const changes = { ...state.changes };
      delete changes[action.id];
      const out = withPanels({ ...state, changes }, rest, []);
      return { ...out, selected: state.selected === action.id ? null : state.selected };
    }
    case "place": {
      const next = placePanel(panels, action.id, action.to);
      if (next === panels) return state;
      return withPanels(state, next, moved(panels, next, action.id) ? [action.id] : []);
    }
    case "nudge":
    case "grow": {
      const next = action.type === "nudge" ? nudge(panels, action.id, action.dir) : grow(panels, action.id, action.dir);
      if (next === panels) return state;
      return withPanels(state, next, moved(panels, next, action.id) ? [action.id] : []);
    }
    case "select":
      if (action.id === state.selected) return state;
      return { ...state, selected: action.id, ...(action.id !== null ? { sideTab: "query" as const } : {}) };
    case "sideTab":
      return action.tab === state.sideTab ? state : { ...state, sideTab: action.tab };
    case "setJson": {
      const result = parseDashboardJson(action.text, action.ownerKind);
      if (!result.ok) return { ...state, jsonText: action.text, jsonProblems: result.problems };
      return applyDocument(state, result.spec);
    }
    case "setDashboard":
      return applyDocument(state, action.update(state.draft));
    case "saved":
      // Changed while the save was on its way: keep editing over the version just saved.
      if (action.sent !== undefined && action.sent !== state.draft) return { ...state, baseVersion: action.version, base: action.spec };
      return VIEW;
    case "rebase":
      return { ...state, baseVersion: action.version, base: action.base };
    case "discard":
      return VIEW;
  }
}

/** A whole new document (JSON or a dashboard-level edit): unchanged panels keep their objects. */
function applyDocument(state: EditingState, next: DashboardSpec): EditingState {
  const panels = reuse(state.draft.panels, next.panels);
  const doc = { ...next, panels };
  if (sameJson(doc, state.draft)) {
    return state.jsonText === null && state.jsonProblems.length === 0 ? state : { ...state, jsonText: null, jsonProblems: [] };
  }
  const touched = changedPanelIds(state.draft, doc);
  const ids = new Set(panels.map((p) => p.id));
  const selected = state.selected !== null && ids.has(state.selected) ? state.selected : null;
  return withDraft(state, doc, touched, { selected });
}
