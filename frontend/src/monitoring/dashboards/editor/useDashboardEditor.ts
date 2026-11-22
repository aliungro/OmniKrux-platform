// A dashboard's edit session in one workspace tab. Sessions live in `editSessions` (this module is
// in the lazy Monitoring chunk), keyed by tab id, so switching app and back resumes edit mode; the
// leave check and drafts (Task 16) read the same map. The draft is kept in browser storage while
// it has changes (`useDraft`), so a reload or Browser Back offers it back.

import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { dashboardKey, DashboardRequestError, saveDashboard, useDashboardMutation, type DashboardOut } from "../api";
import { removeDraft, type StoredDraft } from "../drafts/draftStore";
import { useDraft } from "../drafts/useDraft";
import type { DashboardSpec, OwnerKind } from "../schema";
import { editorReducer, hasUnsavedWork, isDirty, newWriter, VIEW, type EditingState, type EditorAction, type EditorState } from "./editorState";

export { isDirty };

/** Every live edit session, by workspace tab id. A tab not editing has no entry. */
export const editSessions = new Map<string /* tab id */, EditorState>();

/** Save refused because the JSON tab holds text that doesn't apply (no PUT is sent). */
export const JSON_SAVE_REFUSED = "The JSON has a problem. Fix it or discard it before saving.";

export interface DashboardEditor {
  state: EditorState;
  /** Applies the action now; returns the state it made (the JSON tab reads its own result). */
  dispatch(action: EditorAction): EditorState;
  /** Saves the draft over the version it started from; a refusal is kept in `saveError`. */
  save(): Promise<void>;
  /** Moves the base to the newer saved version (after reviewing it), then saves over it. */
  saveOver(version: number, base: DashboardSpec): Promise<void>;
  /** Edit mode from a stored draft: it becomes this session's, based on the version it started from. */
  restore(draft: StoredDraft, current: DashboardSpec, ownerKind: OwnerKind): void;
  /** Leaves edit mode and drops the draft (the caller asks first when it has changes). */
  discard(): void;
  saving: boolean;
  saveError: DashboardRequestError | null;
  /** The current version a save was refused for (409), until a save goes through or editing ends. */
  conflict: number | null;
  /** Whether this browser keeps drafts; false: a reload loses unsaved changes. */
  draftsWork: boolean;
  /** The last save's answer (set with the save's own state change, before the dashboard query updates). */
  lastSaved: DashboardOut | null;
}

const sessionFor = (tabId: string, dashboardId: string): EditorState => {
  const s = editSessions.get(tabId);
  return s?.mode === "edit" && s.dashboardId === dashboardId ? s : VIEW;
};

export function useDashboardEditor(dashboardId: string, tabId: string): DashboardEditor {
  const client = useQueryClient();
  // The latest state, read synchronously: save() right after a dispatch sends what it made.
  const current = useRef<EditorState>(sessionFor(tabId, dashboardId));
  const [state, setState] = useState<EditorState>(current.current);
  const [saveError, setSaveError] = useState<DashboardRequestError | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  /** Save was pressed while the JSON text didn't apply; the notice lasts while it still doesn't. */
  const [jsonRefused, setJsonRefused] = useState(false);
  const [lastSaved, setLastSaved] = useState<DashboardOut | null>(null);
  const mutation = useDashboardMutation((v: { id: string; baseVersion: number; spec: DashboardSpec }) => saveDashboard(v.id, v.baseVersion, v.spec));
  const busy = useRef(false);
  const live = useCallback((): EditingState | null => {
    const s = sessionFor(tabId, dashboardId);
    return s.mode === "edit" ? s : null;
  }, [tabId, dashboardId]);
  const keeper = useDraft(tabId, dashboardId, state, live);
  const adopt = keeper.adopt;

  const dispatch = useCallback((action: EditorAction) => {
    // The tab's live session is the latest (a save answered after this page went away and came back).
    const live = sessionFor(tabId, dashboardId);
    const from = live.mode === "edit" ? live : current.current;
    const next = editorReducer(from, action);
    if (next === from) return from;
    current.current = next;
    if (next.mode === "edit") editSessions.set(tabId, next);
    else if (sessionFor(tabId, dashboardId).mode === "edit") editSessions.delete(tabId);
    if (next.mode === "view") {
      setSaveError(null);
      setConflict(null);
    }
    if (next.mode === "view" || next.jsonText === null) setJsonRefused(false);
    setState(next);
    return next;
  }, [tabId, dashboardId]);

  /**
   * Every save goes through here (Save dashboard, Ctrl+S, Review changes, the conflict review's
   * Save over it). `rebase`: the newer saved version to save over, taken only if the save is sent.
   */
  const send = useCallback(async (baseVersion: number, rebase?: { version: number; base: DashboardSpec }) => {
    let s = current.current;
    if (s.mode !== "edit" || busy.current) return;
    // The JSON tab's text doesn't apply: saving the last valid draft would drop it silently. No
    // PUT; the edit bar says so with Show in JSON. A conflict under review stays unresolved (no
    // rebase), so the next save is refused and reviewed again.
    if (s.jsonText !== null) {
      setSaveError(null);
      setConflict(null);
      setJsonRefused(true);
      return;
    }
    if (rebase) {
      dispatch({ type: "rebase", version: rebase.version, base: rebase.base });
      s = current.current;
      if (s.mode !== "edit") return;
    }
    busy.current = true;
    setSaveError(null);
    setJsonRefused(false);
    try {
      const out: DashboardOut = await mutation.mutateAsync({ id: s.dashboardId, baseVersion, spec: s.draft });
      client.setQueryData(dashboardKey(out.id), out);
      setLastSaved(out);
      // Changed while saving: editing goes on over the saved version, and the stored draft is
      // updated with the next write. Otherwise the draft is done with (also when the page went away).
      dispatch({ type: "saved", version: out.version, spec: out.spec, sent: s.draft });
      setConflict(null);
      if (current.current.mode === "view") removeDraft(out.id, s.writer);
    } catch (err) {
      const e = err as DashboardRequestError;
      setSaveError(e);
      // The newer saved version is what the review compares the draft with.
      if (e.code === "version_conflict") {
        setConflict(e.currentVersion ?? baseVersion + 1);
        void client.invalidateQueries({ queryKey: dashboardKey(s.dashboardId), exact: true });
      } else if (e.code === "invalid_dashboard") {
        // The draft itself has problems (Save over it included): the edit bar lists them.
        setConflict(null);
      }
    } finally {
      busy.current = false;
    }
  }, [client, dispatch, mutation]);

  const save = useCallback(async () => {
    const s = current.current;
    if (s.mode !== "edit") return;
    // Nothing changed (and no JSON text waiting to apply): no new version and no Audit record, just the end of editing.
    if (!hasUnsavedWork(s)) dispatch({ type: "discard" });
    else await send(s.baseVersion);
  }, [dispatch, send]);

  const saveOver = useCallback(async (version: number, base: DashboardSpec) => {
    await send(version, { version, base });
  }, [send]);

  const discard = useCallback(() => dispatch({ type: "discard" }), [dispatch]);

  const restore = useCallback((d: StoredDraft, spec: DashboardSpec, ownerKind: OwnerKind) => {
    dispatch({
      type: "resume", dashboardId, baseVersion: d.baseVersion, base: spec, draft: d.draft, jsonText: d.jsonText, ownerKind,
      writer: newWriter(),
    });
    const s = current.current;
    // Written again under this session, keeping when it last changed.
    if (s.mode === "edit") adopt(s, d.savedAt);
  }, [dispatch, adopt, dashboardId]);

  // Shown like any other save problem, with the JSON problems and Show in JSON.
  const jsonError = useMemo(
    () => (jsonRefused && state.mode === "edit" && state.jsonText !== null
      ? new DashboardRequestError(0, "invalid_dashboard", JSON_SAVE_REFUSED, state.jsonProblems)
      : null),
    [jsonRefused, state],
  );

  return {
    state, dispatch, save, saveOver, discard, restore, saving: mutation.isPending, saveError: jsonError ?? saveError, conflict,
    draftsWork: keeper.works, lastSaved,
  };
}
