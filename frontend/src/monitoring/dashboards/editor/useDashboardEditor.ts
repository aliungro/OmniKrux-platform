// A dashboard's edit session in one workspace tab. Sessions live in `editSessions` (this module is
// in the lazy Monitoring chunk), keyed by tab id, so switching app and back resumes edit mode; the
// leave check and drafts (Task 16) read the same map. The draft is kept in browser storage while
// it has changes (`useDraft`), so a reload or Browser Back offers it back.

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { dashboardKey, saveDashboard, useDashboardMutation, type DashboardOut, type DashboardRequestError } from "../api";
import { removeDraft, type StoredDraft } from "../drafts/draftStore";
import { useDraft } from "../drafts/useDraft";
import type { DashboardSpec, OwnerKind } from "../schema";
import { editorReducer, isDirty, newWriter, VIEW, type EditingState, type EditorAction, type EditorState } from "./editorState";

export { isDirty };

/** Every live edit session, by workspace tab id. A tab not editing has no entry. */
export const editSessions = new Map<string /* tab id */, EditorState>();

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
    setState(next);
    return next;
  }, [tabId, dashboardId]);

  const send = useCallback(async (baseVersion: number) => {
    const s = current.current;
    if (s.mode !== "edit" || busy.current) return;
    busy.current = true;
    setSaveError(null);
    try {
      const out: DashboardOut = await mutation.mutateAsync({ id: s.dashboardId, baseVersion, spec: s.draft });
      client.setQueryData(dashboardKey(out.id), out);
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
    // Nothing changed: no new version and no Audit record, just the end of editing.
    if (!isDirty(s)) dispatch({ type: "discard" });
    else await send(s.baseVersion);
  }, [dispatch, send]);

  const saveOver = useCallback(async (version: number, base: DashboardSpec) => {
    dispatch({ type: "rebase", version, base });
    await send(version);
  }, [dispatch, send]);

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

  return { state, dispatch, save, saveOver, discard, restore, saving: mutation.isPending, saveError, conflict, draftsWork: keeper.works };
}
