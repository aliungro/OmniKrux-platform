// Which ways out of a tab leave a dashboard with unsaved changes. The shell asks this (through
// MonitoringApp's leave check) before closing a tab, navigating it, or going Back or Forward in it.

import type { AppTabs } from "../../../features/shell/workspace";
import { sameMonitoringView, type MonitoringTabAction, type MonitoringView } from "../../shell/tabState";
import { hasUnsavedWork, type EditorState } from "../editor/editorState";

export interface HeldLeave {
  tabId: string;
  dashboardId: string;
}

const sameDashboard = (view: MonitoringView | undefined, dashboardId: string) => view?.page === "dashboard" && view.id === dashboardId;

/**
 * The tab and dashboard an action would leave with unsaved changes, else null: closing a tab whose
 * session has changes; navigating such a tab somewhere other than the same dashboard (a move that
 * doesn't change the tab's page is no way out); Back or Forward in it to another place.
 */
export function heldLeave(
  action: MonitoringTabAction,
  tabs: AppTabs<MonitoringView>,
  sessions: ReadonlyMap<string, EditorState>,
): HeldLeave | null {
  if (action.type !== "closeTab" && action.type !== "navigate" && action.type !== "back" && action.type !== "forward") return null;
  const session = sessions.get(action.id);
  if (!session || session.mode !== "edit" || !hasUnsavedWork(session)) return null;
  const held = { tabId: action.id, dashboardId: session.dashboardId };
  if (action.type === "closeTab") return held;
  const tab = tabs.tabs.find((t) => t.id === action.id);
  if (!tab) return null;
  if (action.type === "navigate") {
    if (sameMonitoringView(tab.view, action.view) || sameDashboard(action.view, session.dashboardId)) return null;
    return held;
  }
  const history = action.type === "back" ? tab.back : tab.forward;
  if (history.length === 0) return null;
  return sameDashboard(history[history.length - 1], session.dashboardId) ? null : held;
}
