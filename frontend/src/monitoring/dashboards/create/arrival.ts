// Opening what was just made: a created or copied dashboard (in edit mode, or as it is), and the
// owner's page after a delete. The page that opens reads its arrival once, so a later visit (a
// tab switch, Back) opens as usual.
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import type { TabNav } from "../../../features/shell/browserHistory";
import type { MonitoringView } from "../../shell/tabState";
import { copyDashboard, dashboardKey, useDashboardMutation, type DashboardOut } from "../api";
import { isDirty } from "../editor/editorState";
import { editSessions } from "../editor/useDashboardEditor";
import type { OwnerKind } from "../schema";

/** How a dashboard opens the first time after it was made here. */
export interface Arrival {
  /** In edit mode, with the keyboard on + Add panel; otherwise as it is, with the keyboard on its title. */
  edit: boolean;
  /** Said once it opens (a copy of a ready-made view). */
  status?: string;
}

const arrivals = new Map<string, Arrival>();

export const peekArrival = (dashboardId: string): Arrival | null => arrivals.get(dashboardId) ?? null;
export const forgetArrival = (dashboardId: string) => { arrivals.delete(dashboardId); };

/** Where a page opens from: its tab's navigation, and a way to open a new tab. */
export interface Opener {
  tabId: string;
  nav: Pick<TabNav<MonitoringView>, "navigate">;
  openInNewTab(view: MonitoringView): void;
}

/**
 * Opens a dashboard just made: in the active tab, or in a new one when that tab holds unsaved
 * edits, so no leave question follows a create that already happened (F33).
 */
export function openMade(out: DashboardOut, arrival: Arrival, how: Opener): void {
  arrivals.set(out.id, arrival);
  const view: MonitoringView = { page: "dashboard", id: out.id };
  const session = editSessions.get(how.tabId);
  if (session?.mode === "edit" && isDirty(session)) how.openInNewTab(view);
  else how.nav.navigate(view, "push");
}

export const copiedWords = (title: string) => `Copied "${title}". Changes go to your copy.`;

/**
 * Copy to edit: a ready-made view copied into its project as it is (the server picks a title its
 * project doesn't use yet), then opened in edit mode.
 */
export function useCopyToEdit(how: Opener) {
  const client = useQueryClient();
  const mutation = useDashboardMutation((x: { from: string; projectId: string }) =>
    copyDashboard({ from_id: x.from, owner_kind: "project", owner_id: x.projectId }));
  const [error, setError] = useState<{ from: string; text: string } | null>(null);
  const { tabId, nav, openInNewTab } = how;
  const copy = useCallback((from: string, projectId: string) => {
    if (mutation.isPending) return;
    setError(null);
    mutation.mutate({ from, projectId }, {
      onSuccess: (out) => {
        client.setQueryData(dashboardKey(out.id), out);
        openMade(out, { edit: true, status: copiedWords(out.title) }, { tabId, nav, openInNewTab });
      },
      onError: (err) => setError({ from, text: failure(err, "try again") }),
    });
  }, [client, mutation, tabId, nav, openInNewTab]);
  return { copy, busy: mutation.isPending ? (mutation.variables?.from ?? null) : null, error };
}

let heading: string | null = null;

/** The owner page opened next shows with the keyboard on its heading (after a delete). */
export function focusHeadingOnArrival(kind: OwnerKind, id: string): void {
  heading = `${kind}:${id}`;
}

/** Whether this owner page should take the keyboard to its heading; asked once. */
export function takeHeadingFocus(kind: OwnerKind, id: string): boolean {
  if (heading !== `${kind}:${id}`) return false;
  heading = null;
  return true;
}
