// A dashboard's edit session in one workspace tab. Sessions live in `editSessions` (this module is
// in the lazy Monitoring chunk), keyed by tab id, so switching app and back resumes edit mode; the
// leave check and drafts (Task 16) read the same map.

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { dashboardKey, saveDashboard, useDashboardMutation, type DashboardOut, type DashboardRequestError } from "../api";
import type { DashboardSpec } from "../schema";
import { editorReducer, isDirty, VIEW, type EditorAction, type EditorState } from "./editorState";

export { isDirty };

/** Every live edit session, by workspace tab id. A tab not editing has no entry. */
export const editSessions = new Map<string /* tab id */, EditorState>();

export interface DashboardEditor {
  state: EditorState;
  dispatch(action: EditorAction): void;
  /** Saves the draft over the version it started from; a refusal is kept in `saveError`. */
  save(): Promise<void>;
  /** Moves the base to the newer saved version (after reviewing it), then saves over it. */
  saveOver(version: number, base: DashboardSpec): Promise<void>;
  /** Leaves edit mode and drops the draft (the caller asks first when it has changes). */
  discard(): void;
  saving: boolean;
  saveError: DashboardRequestError | null;
  /** The current version a save was refused for (409), until a save goes through or editing ends. */
  conflict: number | null;
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

  const dispatch = useCallback((action: EditorAction) => {
    const next = editorReducer(current.current, action);
    if (next === current.current) return;
    current.current = next;
    if (next.mode === "edit") editSessions.set(tabId, next);
    else if (sessionFor(tabId, dashboardId).mode === "edit") editSessions.delete(tabId);
    if (next.mode === "view") {
      setSaveError(null);
      setConflict(null);
    }
    setState(next);
  }, [tabId, dashboardId]);

  const send = useCallback(async (baseVersion: number) => {
    const s = current.current;
    if (s.mode !== "edit" || busy.current) return;
    busy.current = true;
    setSaveError(null);
    try {
      const out: DashboardOut = await mutation.mutateAsync({ id: s.dashboardId, baseVersion, spec: s.draft });
      client.setQueryData(dashboardKey(out.id), out);
      dispatch({ type: "saved", version: out.version, spec: out.spec });
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

  return { state, dispatch, save, saveOver, discard, saving: mutation.isPending, saveError, conflict };
}
