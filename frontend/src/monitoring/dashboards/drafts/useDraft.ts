// An edit session's draft in browser storage: written 500 ms after each change while it differs
// from the saved document, at once when the page is hidden or goes away, and removed when the
// session ends by Save or Discard. With storage blocked, a reload asks first (F36).
//
// Each session writes under its own `writer` id and removes only a draft it wrote, so one tab or
// window never drops another's. When another window removes or replaces this dashboard's draft
// while this session has changes, the session whose last change is newest writes it again: the
// last dirty writer wins and nothing is lost silently.

import { useCallback, useEffect, useRef, useState } from "react";
import { hasUnsavedWork, type EditingState, type EditorState } from "../editor/editorState";
import { draftKey, draftsWork, readDraft, removeDraft, writeDraft, type StoredDraft } from "./draftStore";

export const DRAFT_DELAY_MS = 500;

export function toStoredDraft(s: EditingState, savedAt = Date.now()): StoredDraft {
  return { v: 1, dashboardId: s.dashboardId, baseVersion: s.baseVersion, savedAt, draft: s.draft, jsonText: s.jsonText, writer: s.writer };
}

// --- reload with storage blocked ------------------------------------------------------------

/** Tabs whose changes only this page holds: a reload would lose them, so the browser asks first. */
const unkept = new Set<string>();
const askBeforeUnload = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = "";
};

export function holdUnload(tabId: string, on: boolean): void {
  const before = unkept.size > 0;
  if (on) unkept.add(tabId);
  else unkept.delete(tabId);
  const after = unkept.size > 0;
  if (before === after) return;
  if (after) window.addEventListener("beforeunload", askBeforeUnload);
  else window.removeEventListener("beforeunload", askBeforeUnload);
}

// --- what storage holds for each tab's session -----------------------------------------------

interface Kept {
  dashboardId: string;
  writer: string;
  draft: EditingState["draft"];
  jsonText: string | null;
  baseVersion: number;
}

/**
 * A session's claim on the stored draft: when its user last changed the draft (the `savedAt` it
 * writes; never the time of a write), and whether a newer draft from another window won over it.
 * A session that lost writes again only after its user changes something, or when the entry is
 * removed (writing into nothing overwrites no one).
 */
export interface DraftClaim {
  writer: string;
  changedAt: number;
  lost: boolean;
}

/** By tab id; they outlive the page, like the session they belong to. */
const keptByTab = new Map<string, Kept>();
const claims = new Map<string, DraftClaim & { dashboardId: string }>();

const keptFor = (tabId: string, s: EditingState): Kept | null => {
  const k = keptByTab.get(tabId);
  return k && k.dashboardId === s.dashboardId && k.writer === s.writer ? k : null;
};
const claimFor = (tabId: string, s: EditingState) => {
  const c = claims.get(tabId);
  return c && c.dashboardId === s.dashboardId && c.writer === s.writer ? c : null;
};
const sameKept = (k: Kept | null, s: EditingState) =>
  k !== null && k.draft === s.draft && k.jsonText === s.jsonText && k.baseVersion === s.baseVersion;

/** The user changed the draft at `at` (or a restored draft last changed then). */
function claim(tabId: string, s: EditingState, at: number): DraftClaim {
  const c = { dashboardId: s.dashboardId, writer: s.writer, changedAt: at, lost: false };
  claims.set(tabId, c);
  return c;
}

/** Writes the session's draft as last changed at its claim's time; false when storage refused it. */
function keep(tabId: string, s: EditingState, c: DraftClaim): boolean {
  if (!writeDraft(toStoredDraft(s, c.changedAt))) return false;
  keptByTab.set(tabId, { dashboardId: s.dashboardId, writer: s.writer, draft: s.draft, jsonText: s.jsonText, baseVersion: s.baseVersion });
  c.lost = false;
  return true;
}

/** Writes the session's draft now (Keep draft and leave); false when storage refused it. */
export function keepNow(tabId: string, s: EditingState): boolean {
  return keep(tabId, s, claimFor(tabId, s) ?? claim(tabId, s, Date.now()));
}

/** The tab's session ended or the tab is gone: nothing of it is tracked any more. */
export function forgetSession(tabId: string): void {
  keptByTab.delete(tabId);
  claims.delete(tabId);
  holdUnload(tabId, false);
}

/**
 * What a dirty session does about the stored draft another window just changed: `write` its own
 * again (the entry was removed, or holds an older draft), `yield` to a newer one (or an equally
 * new one: on a tie the stored draft stays), or `keep` things as they are (its own draft is
 * stored, or it already lost and its user hasn't changed anything since).
 */
export function settle(c: DraftClaim, theirs: Pick<StoredDraft, "writer" | "savedAt"> | null): "write" | "yield" | "keep" {
  if (theirs === null) return "write";
  if (theirs.writer === c.writer || c.lost) return "keep";
  return c.changedAt > theirs.savedAt ? "write" : "yield";
}

// --- the session's draft --------------------------------------------------------------------

export interface DraftKeeper {
  /** Whether this browser keeps drafts (a probe on open, then every write). */
  works: boolean;
  /** The session now shows a stored draft (restored): it becomes this session's, keeping its time. */
  adopt(s: EditingState, savedAt: number): void;
}

/**
 * Keeps `state`'s draft stored. `session()` is the tab's live session (null once it ended): a
 * write that comes due after the session was ended (left, discarded) writes nothing.
 */
export function useDraft(tabId: string, dashboardId: string, state: EditorState, session: () => EditingState | null): DraftKeeper {
  const [works, setWorks] = useState(draftsWork);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const write = useCallback((s: EditingState, c: DraftClaim) => {
    setWorks(keep(tabId, s, c));
  }, [tabId]);
  const flush = useCallback(() => {
    cancel();
    const s = sessionRef.current();
    if (!s || !hasUnsavedWork(s)) return;
    const c = claimFor(tabId, s);
    if (c && !c.lost) write(s, c);
  }, [tabId, write]);

  /** Another window changed this dashboard's draft (or this page opened again): settle with it. */
  const reconcile = useCallback(() => {
    const s = sessionRef.current();
    if (!s || !hasUnsavedWork(s)) return;
    const c = claimFor(tabId, s);
    if (!c) return;
    const how = settle(c, readDraft(dashboardId));
    if (how === "write") {
      cancel();
      write(s, c);
    } else if (how === "yield") {
      // A newer draft from elsewhere stays; ours writes again with its user's next change.
      cancel();
      c.lost = true;
      keptByTab.delete(tabId);
    }
  }, [tabId, dashboardId, write]);

  const previous = useRef(state);
  useEffect(() => {
    const was = previous.current;
    previous.current = state;
    if (state.mode === "view") {
      cancel();
      // Saved or discarded: this session's draft is done with; another's stays.
      if (was.mode === "edit") removeDraft(dashboardId, was.writer);
      keptByTab.delete(tabId);
      claims.delete(tabId);
      return;
    }
    if (!hasUnsavedWork(state)) {
      // Back to the saved document (and no JSON text waiting to apply): a draft this session
      // stored has nothing left to offer.
      cancel();
      if (keptFor(tabId, state)) removeDraft(dashboardId, state.writer);
      keptByTab.delete(tabId);
      claims.delete(tabId);
      return;
    }
    if (sameKept(keptFor(tabId, state), state)) return;
    // The user changed the draft: that is when it last changed. A new base alone (a save that
    // went through while editing went on) keeps the time of the last change.
    const edited = was !== state && (was.mode !== "edit" || was.draft !== state.draft || was.jsonText !== state.jsonText);
    const known = claimFor(tabId, state);
    const c: DraftClaim = edited || !known ? claim(tabId, state, Date.now()) : known;
    // Lost to a newer draft and nothing changed here since: that draft stays.
    if (c.lost) return;
    cancel();
    timer.current = setTimeout(flush, DRAFT_DELAY_MS);
  }, [state, tabId, dashboardId, flush]);

  // Storage blocked and changes unsaved: a reload or closing the window asks first.
  const unsafe = hasUnsavedWork(state) && !works;
  useEffect(() => { holdUnload(tabId, unsafe); }, [tabId, unsafe]);

  useEffect(() => {
    // A live session coming back: another window may have removed or replaced its draft meanwhile.
    reconcile();
    const onStorage = (e: StorageEvent) => { if (e.key === draftKey(dashboardId) || e.key === null) reconcile(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [dashboardId, reconcile]);

  useEffect(() => {
    const onHide = () => { if (timer.current !== null) flush(); };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      // The page goes away (another app, another tab): a pending write lands now. A session that
      // ended (left or discarded) writes nothing and needs no reload prompt.
      if (timer.current !== null) flush();
      if (sessionRef.current() === null) forgetSession(tabId);
    };
  }, [tabId, flush]);

  const adopt = useCallback((s: EditingState, savedAt: number) => { write(s, claim(tabId, s, savedAt)); }, [tabId, write]);
  return { works, adopt };
}

// --- the offer on open ----------------------------------------------------------------------

export interface DraftOffer {
  draft: StoredDraft | null;
  /** Hides the offer, the draft stays stored (restored, or replaced by new edits). */
  dismiss(): void;
  /** Removes the stored draft, whoever wrote it (the user chose to). */
  discard(): void;
}

/** The draft stored for a dashboard, read once when the page opens without a live session. */
export function useDraftOffer(dashboardId: string, enabled: boolean): DraftOffer {
  const [draft, setDraft] = useState<StoredDraft | null>(() => (enabled ? readDraft(dashboardId) : null));
  const dismiss = useCallback(() => setDraft(null), []);
  const discard = useCallback(() => {
    removeDraft(dashboardId);
    setDraft(null);
  }, [dashboardId]);
  return { draft, dismiss, discard };
}
