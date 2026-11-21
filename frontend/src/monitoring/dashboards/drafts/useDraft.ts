// An edit session's draft in browser storage: written 500 ms after each change while it differs
// from the saved document, at once when the page is hidden or goes away, and removed when the
// session ends by Save or Discard. With storage blocked, a reload asks first (F36).

import { useCallback, useEffect, useRef, useState } from "react";
import { isDirty, type EditingState, type EditorState } from "../editor/editorState";
import { draftsWork, readDraft, removeDraft, writeDraft, type StoredDraft } from "./draftStore";

export const DRAFT_DELAY_MS = 500;

export function toStoredDraft(s: EditingState): StoredDraft {
  return { v: 1, dashboardId: s.dashboardId, baseVersion: s.baseVersion, savedAt: Date.now(), draft: s.draft, jsonText: s.jsonText };
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

// --- the session's draft --------------------------------------------------------------------

type Kept = Pick<EditingState, "draft" | "jsonText" | "baseVersion">;
const sameKept = (a: Kept | null, b: EditingState) =>
  a !== null && a.draft === b.draft && a.jsonText === b.jsonText && a.baseVersion === b.baseVersion;

export interface DraftKeeper {
  /** Whether this browser keeps drafts (a probe on open, then every write). */
  works: boolean;
  /** The session now shows a draft that is already stored (a restored one): nothing to write. */
  adopt(s: EditingState): void;
}

/**
 * Keeps `state`'s draft stored. `session()` is the tab's live session (null once it ended): a
 * write that comes due after the session was ended (left, discarded) writes nothing.
 */
export function useDraft(tabId: string, dashboardId: string, state: EditorState, session: () => EditingState | null): DraftKeeper {
  const [works, setWorks] = useState(draftsWork);
  // What storage holds for this session. A live session resumed with changes was written when its
  // page went away; one without changes has written nothing (an offered older draft stays).
  const kept = useRef<Kept | null>(state.mode === "edit" && isDirty(state) ? state : null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const flush = useCallback(() => {
    cancel();
    const s = sessionRef.current();
    if (!s || !isDirty(s)) return;
    const ok = writeDraft(toStoredDraft(s));
    if (ok) kept.current = s;
    setWorks(ok);
  }, []);

  const previous = useRef(state);
  useEffect(() => {
    const was = previous.current;
    previous.current = state;
    if (state.mode === "view") {
      cancel();
      // Saved or discarded: the draft is done with. A session that changed nothing and stored
      // nothing leaves an older stored draft alone (it was offered, and is offered again).
      if (kept.current !== null || isDirty(was)) removeDraft(dashboardId);
      kept.current = null;
      return;
    }
    if (!isDirty(state)) {
      // Back to the saved document: a draft this session stored has nothing left to offer.
      cancel();
      if (kept.current !== null) removeDraft(dashboardId);
      kept.current = null;
      return;
    }
    if (sameKept(kept.current, state)) return;
    cancel();
    timer.current = setTimeout(flush, DRAFT_DELAY_MS);
  }, [state, dashboardId, flush]);

  // Storage blocked and changes unsaved: a reload or closing the window asks first.
  const unsafe = state.mode === "edit" && isDirty(state) && !works;
  useEffect(() => { holdUnload(tabId, unsafe); }, [tabId, unsafe]);

  useEffect(() => {
    const onHide = () => { if (timer.current !== null) flush(); };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      // The page goes away (another app, another tab): a pending write lands now. A session that
      // ended (left or discarded) writes nothing and needs no reload prompt.
      if (timer.current !== null) flush();
      if (sessionRef.current() === null) holdUnload(tabId, false);
    };
  }, [tabId, flush]);

  const adopt = useCallback((s: EditingState) => { kept.current = s; }, []);
  return { works, adopt };
}

// --- the offer on open ----------------------------------------------------------------------

export interface DraftOffer {
  draft: StoredDraft | null;
  /** Hides the offer, the draft stays stored (restored, or replaced by new edits). */
  dismiss(): void;
  /** Removes the stored draft. */
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
