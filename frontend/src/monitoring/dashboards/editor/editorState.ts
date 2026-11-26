// Edit mode as data: the saved document it started from (`base`), the draft, the selected panel
// and how often each panel changed (`changes`, the `changeId` its chart uses). Every action that
// changes the draft keeps unchanged panel objects identical, so only the panels it touched render
// again. Loading a document never compacts; a user's move, resize, add or remove does (F34).
// Undo: each draft edit keeps the draft before it in `past` (consecutive edits with one key, such
// as typing in one panel's settings, the title or the JSON, are one step).

import { appendPanel, compact, freeSpot, grow, nudge, placePanel, type Dir, type NewPanel } from "../layout";
import {
  DEFAULT_SIZES, newPanel, nextPanelId, parseDashboardJson,
  type DashboardSpec, type Layout, type OwnerKind, type PanelSpec, type PanelType, type Problem,
} from "../schema";
import { sameJson } from "../sameJson";

// Moved to `../sameJson` so code outside the editor can use it; still exported here.
export { sameJson };

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
  /** The suggestions rail (D2): open for a draft with no panels. Opening or closing it isn't a draft edit. */
  suggestions: "open" | "closed";
  /**
   * By panel id: an alert threshold as typed that isn't a number (the draft keeps the last number
   * that was). Like JSON text that doesn't apply, it is unsaved work, and Save is refused while any.
   */
  alertText?: Record<string, string>;
  /** Drafts before each undoable step, newest last (at most `UNDO_LIMIT`). */
  past: DashboardSpec[];
  /** The key of the newest step (`updatePanel:<id>`, `title`, `json`): another edit with it joins that step. */
  pastKey: string | null;
}

export type EditorState = { mode: "view" } | EditingState;

export type EditorAction =
  | { type: "start"; dashboardId: string; version: number; spec: DashboardSpec; writer?: string }
  /** A stored draft or a live session back in edit mode; `ownerKind` re-checks kept JSON text for its problems. */
  | { type: "resume"; dashboardId: string; baseVersion: number; base: DashboardSpec; draft: DashboardSpec; jsonText: string | null; ownerKind?: OwnerKind; writer?: string }
  | { type: "updatePanel"; id: string; update: (p: PanelSpec) => PanelSpec }
  | { type: "addPanel"; panelType: PanelType; at?: { x: number; y: number } }
  /** A ready-made panel (Add panel's search, the suggestions) at its layout, or the first free spot. */
  | { type: "insertPanel"; panel: NewPanel; select: boolean }
  | { type: "removePanel"; id: string }
  /** A copy below the panel: a new id, "(copy)" after its title, no alert. */
  | { type: "duplicatePanel"; id: string }
  /** Back to the draft before the last step (refused while the JSON text doesn't apply). */
  | { type: "undo" }
  | { type: "place"; id: string; to: Layout }
  | { type: "nudge" | "grow"; id: string; dir: Dir }
  | { type: "select"; id: string | null }
  | { type: "suggestions"; open: boolean }
  | { type: "sideTab"; tab: SideTab }
  /** A panel alert's threshold as typed: `text` when it isn't a number, null once it is. Not a draft edit. */
  | { type: "alertText"; id: string; text: string | null }
  | { type: "setJson"; text: string; ownerKind: OwnerKind }
  /** `key`: consecutive edits with the same key are one undo step (the title field's typing). */
  | { type: "setDashboard"; update: (d: DashboardSpec) => DashboardSpec; key?: string }
  /** `sent`: the draft the save sent. A draft that differs from it now stays in edit mode on the new base. */
  | { type: "saved"; version: number; spec: DashboardSpec; sent?: DashboardSpec }
  | { type: "rebase"; version: number; base: DashboardSpec }
  | { type: "discard" };

export const VIEW: EditorState = { mode: "view" };

/** What the grid and the settings say when an edit is refused because the JSON text doesn't apply. */
export const JSON_FIRST = "Fix the JSON first, or discard it.";

const DRAFT_EDITS: ReadonlySet<EditorAction["type"]> = new Set(["updatePanel", "addPanel", "insertPanel", "removePanel", "duplicatePanel", "place", "nudge", "grow", "setDashboard", "undo"]);

/** How many steps undo keeps. */
export const UNDO_LIMIT = 50;
/**
 * Edits made outside the JSON tab. While the JSON tab holds text that doesn't apply, they are
 * refused: applying one would replace that text with the draft and drop it silently.
 */
export const isDraftEdit = (action: EditorAction): boolean => DRAFT_EDITS.has(action.type);

/** Whether undo would change the draft (a kept step that differs from it). */
export function canUndo(state: EditorState): boolean {
  if (state.mode !== "edit") return false;
  for (let i = state.past.length - 1; i >= 0; i -= 1) if (!sameJson(state.past[i], state.draft)) return true;
  return false;
}

/** Whether the draft differs from the version it started from. */
export function isDirty(state: EditorState): boolean {
  return state.mode === "edit" && !sameJson(state.draft, state.base);
}

/**
 * Whether ending the session now would lose something: a draft that differs from its base, or JSON
 * text that doesn't apply (the draft keeps its last valid version, which may equal the base). The
 * leave check, drafts in storage, the reload prompt, opening something just made and a save's
 * answer all ask this one question.
 */
export function hasUnsavedWork(state: EditorState): boolean {
  return state.mode === "edit" && (state.jsonText !== null || badAlertText(state).length > 0 || !sameJson(state.draft, state.base));
}

/** The panels (in draft order) whose alert threshold, as typed, isn't a number. */
export function badAlertText(state: EditorState): string[] {
  if (state.mode !== "edit" || !state.alertText) return [];
  const text = state.alertText;
  return state.draft.panels.filter((p) => p.alert !== null && Object.hasOwn(text, p.id)).map((p) => p.id);
}

/** `text` without `id`'s entry (the same object when it has none). */
function withoutText(text: Record<string, string> | undefined, ids: readonly string[]): Record<string, string> | undefined {
  if (!text || !ids.some((id) => Object.hasOwn(text, id))) return text;
  const out = { ...text };
  for (const id of ids) delete out[id];
  return out;
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
 * that only moved out of the way don't flash (F34). The JSON follows the new draft (edits from
 * outside the JSON tab are refused while its text doesn't apply, so no text is dropped here).
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
  return { mode: "edit", dashboardId, baseVersion, base, draft, selected: null, sideTab: "query", jsonText, jsonProblems: [], changes: {}, writer, suggestions: draft.panels.length === 0 ? "open" : "closed", past: [], pastKey: null };
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

/** The undo key of an edit: edits in a row with the same key are one step. */
function stepKey(action: EditorAction): string | null {
  if (action.type === "updatePanel") return `updatePanel:${action.id}`;
  if (action.type === "setJson") return "json";
  return action.type === "setDashboard" ? action.key ?? null : null;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const next = reduce(state, action);
  // Every edit that changed the draft keeps the draft before it, unless it continues the last step.
  if (state.mode !== "edit" || next.mode !== "edit" || next.draft === state.draft
    || action.type === "undo" || action.type === "start" || action.type === "resume") return next;
  const key = stepKey(action);
  if (key !== null && key === state.pastKey) return next;
  return { ...next, past: [...state.past, state.draft].slice(-UNDO_LIMIT), pastKey: key };
}

function reduce(state: EditorState, action: EditorAction): EditorState {
  if (action.type === "start") return fresh(action.dashboardId, action.version, action.spec, action.spec, null, action.writer);
  if (action.type === "resume") return resumed(action);
  if (state.mode !== "edit") return state;
  if (state.jsonText !== null && isDraftEdit(action)) return state;
  const panels = state.draft.panels;

  switch (action.type) {
    case "updatePanel": {
      const at = panels.findIndex((p) => p.id === action.id);
      if (at === -1) return state;
      const next = action.update(panels[at]);
      if (next === panels[at] || sameJson(next, panels[at])) return state;
      const list = panels.slice();
      list[at] = next;
      // The alert went, or its threshold was set from elsewhere (Apply): the text typed is replaced.
      const replaced = next.alert === null || (panels[at].alert !== null && next.alert.threshold !== panels[at].alert!.threshold);
      const alertText = replaced ? withoutText(state.alertText, [action.id]) : state.alertText;
      return withDraft(state, { ...state.draft, panels: list }, [action.id], { alertText });
    }
    case "addPanel": {
      const size = DEFAULT_SIZES[action.panelType];
      const spot = action.at ?? freeSpot(panels, size.w, size.h);
      const id = nextPanelId(state.draft);
      const added = newPanel(action.panelType, id, { ...spot, ...size });
      const placed = placePanel([...panels, added], id, added.layout);
      return withPanels(state, placed, [id], { selected: id, sideTab: "query" });
    }
    case "insertPanel": {
      if (panels.some((p) => p.id === action.panel.id)) return state;
      const select = action.select ? { selected: action.panel.id, sideTab: "query" as const } : {};
      return withDraft(state, appendPanel(state.draft, action.panel), [action.panel.id], select);
    }
    case "removePanel": {
      if (!panels.some((p) => p.id === action.id)) return state;
      const rest = compact(panels.filter((p) => p.id !== action.id));
      const changes = { ...state.changes };
      delete changes[action.id];
      const out = withPanels({ ...state, changes, alertText: withoutText(state.alertText, [action.id]) }, rest, []);
      return { ...out, selected: state.selected === action.id ? null : state.selected };
    }
    case "duplicatePanel": {
      const from = panels.find((p) => p.id === action.id);
      if (!from) return state;
      const id = nextPanelId(state.draft);
      const title = [...`${from.title.trim() || "Untitled panel"} (copy)`].slice(0, 120).join("");
      const copy = { ...(JSON.parse(JSON.stringify(from)) as PanelSpec), id, title, alert: null };
      const at = { ...from.layout, y: from.layout.y + from.layout.h };
      return withPanels(state, placePanel([...panels, copy], id, at), [id]);
    }
    case "undo": {
      // Steps equal to the draft (typed back to where they began) undo nothing: they are dropped.
      let past = state.past;
      while (past.length > 0 && sameJson(past[past.length - 1], state.draft)) past = past.slice(0, -1);
      if (past.length === 0) return past === state.past ? state : { ...state, past, pastKey: null };
      return { ...applyDocument(state, past[past.length - 1]), past: past.slice(0, -1), pastKey: null };
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
    case "suggestions": {
      const next = action.open ? "open" : "closed";
      return next === state.suggestions ? state : { ...state, suggestions: next };
    }
    case "sideTab":
      return action.tab === state.sideTab ? state : { ...state, sideTab: action.tab };
    case "alertText": {
      const had = state.alertText?.[action.id];
      if (action.text === null) return had === undefined ? state : { ...state, alertText: withoutText(state.alertText, [action.id]) };
      if (had === action.text || !panels.some((p) => p.id === action.id && p.alert !== null)) return state;
      return { ...state, alertText: { ...state.alertText, [action.id]: action.text } };
    }
    case "setJson": {
      const result = parseDashboardJson(action.text, action.ownerKind);
      if (!result.ok) return { ...state, jsonText: action.text, jsonProblems: result.problems };
      return applyDocument(state, result.spec);
    }
    case "setDashboard":
      return applyDocument(state, action.update(state.draft));
    case "saved":
      // Changed while the save was on its way (JSON text typed that doesn't apply included): keep
      // editing over the version just saved, so nothing typed meanwhile is dropped.
      if (action.sent !== undefined && (state.jsonText !== null || badAlertText(state).length > 0 || !sameJson(action.sent, state.draft))) {
        return { ...state, baseVersion: action.version, base: action.spec };
      }
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
  // A document that changes a panel's alert (or drops the panel) replaces the threshold typed there.
  const before = new Map(state.draft.panels.map((p) => [p.id, p.alert]));
  const stale = Object.keys(state.alertText ?? {}).filter((id) => {
    const now = panels.find((p) => p.id === id);
    return now === undefined || now.alert === null || !sameJson(now.alert, before.get(id));
  });
  return withDraft(state, doc, touched, { selected, alertText: withoutText(state.alertText, stale) });
}
