// An edit session's draft in browser storage: written 500 ms after each change while it differs
// from the saved document, at once when the page is hidden or goes away, and removed when the
// session ends by Save or Discard. With storage blocked, a reload asks first (F36).
//
// Each session writes under its own `writer` id and removes only a draft it wrote, so one tab or
// window never drops another's. When another window removes or replaces this dashboard's draft
// while this session has changes, the session whose last change is newest writes it again: the
// last dirty writer wins and nothing is lost silently.

import { useCallback, useEffect, useRef, useState } from "react";
import { isDirty, type EditingState, type EditorState } from "../editor/editorState";
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
  /** When the stored draft last changed (its `savedAt`). */
  savedAt: number;
}

/** By tab id; it outlives the page, like the session it belongs to. */
const keptByTab = new Map<string, Kept>();

const keptFor = (tabId: string, s: EditingState): Kept | null => {
  const k = keptByTab.get(tabId);
  return k && k.dashboardId === s.dashboardId && k.writer === s.writer ? k : null;
};
const sameKept = (k: Kept | null, s: EditingState) =>
  k !== null && k.draft === s.draft && k.jsonText === s.jsonText && k.baseVersion === s.baseVersion;

/** Writes the session's draft as last changed at `savedAt`; false when storage refused it. */
function keep(tabId: string, s: EditingState, savedAt: number): boolean {
  if (!writeDraft(toStoredDraft(s, savedAt))) return false;
  keptByTab.set(tabId, { dashboardId: s.dashboardId, writer: s.writer, draft: s.draft, jsonText: s.jsonText, baseVersion: s.baseVersion, savedAt });
  return true;
}

/** Writes the session's draft now (Keep draft and leave); false when storage refused it. */
export function keepNow(tabId: string, s: EditingState): boolean {
  const k = keptFor(tabId, s);
  return keep(tabId, s, sameKept(k, s) ? k!.savedAt : Date.now());
}

/** The tab's session ended or the tab is gone: nothing of it is tracked any more. */
export function forgetSession(tabId: string): void {
  keptByTab.delete(tabId);
  holdUnload(tabId, false);
}

/**
 * Whether this session should write its draft again over what another window left: nothing
 * (removed), or an older draft by another writer. A tie goes to the larger writer id, so two
 * windows never take turns.
 */
function oursWins(theirs: StoredDraft | null, s: EditingState, ourAt: number): boolean {
  if (theirs === null) return true;
  if (theirs.writer === s.writer) return false;
  return ourAt > theirs.savedAt || (ourAt === theirs.savedAt && s.writer > theirs.writer);
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
  /** When the session's draft last changed, while that change waits to be written. */
  const changedAt = useRef<number | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const write = useCallback((s: EditingState, savedAt: number) => {
    const ok = keep(tabId, s, savedAt);
    setWorks(ok);
    if (ok) changedAt.current = null;
  }, [tabId]);
  const flush = useCallback(() => {
    cancel();
    const s = sessionRef.current();
    if (!s || !isDirty(s)) return;
    write(s, changedAt.current ?? Date.now());
  }, [write]);

  /** Another window changed this dashboard's draft (or this page opened again): write ours back if it wins. */
  const reconcile = useCallback(() => {
    const s = sessionRef.current();
    if (!s || !isDirty(s)) return;
    const theirs = readDraft(dashboardId);
    const ourAt = changedAt.current ?? keptFor(tabId, s)?.savedAt ?? Date.now();
    if (oursWins(theirs, s, ourAt)) {
      cancel();
      write(s, ourAt);
    } else if (theirs?.writer !== s.writer) {
      // A newer draft from elsewhere: ours writes again with its next change.
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
      return;
    }
    if (!isDirty(state)) {
      // Back to the saved document: a draft this session stored has nothing left to offer.
      cancel();
      if (keptFor(tabId, state)) removeDraft(dashboardId, state.writer);
      keptByTab.delete(tabId);
      return;
    }
    if (sameKept(keptFor(tabId, state), state)) return;
    changedAt.current = Date.now();
    cancel();
    timer.current = setTimeout(flush, DRAFT_DELAY_MS);
  }, [state, tabId, dashboardId, flush]);

  // Storage blocked and changes unsaved: a reload or closing the window asks first.
  const unsafe = state.mode === "edit" && isDirty(state) && !works;
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

  const adopt = useCallback((s: EditingState, savedAt: number) => { write(s, savedAt); }, [write]);
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
