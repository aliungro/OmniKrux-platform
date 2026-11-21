// Renders the Monitoring app the way the shell does: inside a focusable <main>, with its tabs kept
// by the real reducer and a tab navigation that pushes onto the active tab's history. Like the
// shell, a way out of a page asks the app's leave check first, and a held one changes nothing.
import { useReducer } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TabNav } from "../../features/shell/browserHistory";
import type { AppTabs } from "../../features/shell/workspace";
import MonitoringApp from "../MonitoringApp";
import type { ProjectKind, ProjectOut } from "../api/types";
import {
  monitoringLeaveHeld, monitoringTabsReducer, sameMonitoringView, type MonitoringTabAction, type MonitoringView, type PreparedMonitoringTabAction,
} from "../shell/tabState";

let counter = 0;
function prepare(action: MonitoringTabAction): PreparedMonitoringTabAction {
  if (action.type === "newTab") return { ...action, id: `t${++counter}` };
  if (action.type === "closeTab") return { ...action, replacementId: `t${++counter}`, closedAt: 1 };
  return action;
}

export function tabsWith(...views: MonitoringView[]): AppTabs<MonitoringView> {
  const tabs = views.map((view, i) => ({ id: `start${i}`, view, back: [], forward: [], scrollTop: 0 }));
  return { tabs, active: tabs[0].id, closed: [] };
}

function Harness({ initial, onOpenSettings, seen }: { initial: AppTabs<MonitoringView>; onOpenSettings(): void; seen: { tabs: AppTabs<MonitoringView> } }) {
  const [tabs, dispatch] = useReducer(
    (state: AppTabs<MonitoringView>, action: MonitoringTabAction) => monitoringTabsReducer(state, prepare(action)), initial,
  );
  seen.tabs = tabs;
  const tab = tabs.tabs.find((t) => t.id === tabs.active)!;
  const dispatchTabs = (action: MonitoringTabAction): boolean => {
    if (monitoringLeaveHeld(action)) return true;
    dispatch(action);
    return false;
  };
  const navigate: TabNav<MonitoringView>["navigate"] = (move, mode) => {
    const view = typeof move === "function" ? move(tab.view) : move;
    const action = { type: "navigate", id: tab.id, view, mode } as const;
    if (!sameMonitoringView(tab.view, view) && monitoringLeaveHeld(action)) return;
    dispatch(action);
  };
  const nav: TabNav<MonitoringView> = {
    view: tab.view,
    navigate,
    back: () => { if (tab.back.length) dispatchTabs({ type: "back", id: tab.id }); },
    forward: () => { if (tab.forward.length) dispatchTabs({ type: "forward", id: tab.id }); },
    canBack: tab.back.length > 0,
    canForward: tab.forward.length > 0,
    setScroll: (top) => dispatch({ type: "scroll", id: tab.id, top }),
    scrollTop: tab.scrollTop,
  };
  return (
    <main tabIndex={-1}>
      <MonitoringApp tabs={tabs} nav={nav} dispatchTabs={dispatchTabs} onOpenSettings={onOpenSettings} onOpenKubernetes={() => {}} />
    </main>
  );
}

export function renderMonitoringApp(opts: { tabs?: AppTabs<MonitoringView>; onOpenSettings?(): void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const initial = opts.tabs ?? tabsWith({ page: "home" });
  const seen = { tabs: initial };
  const result = render(
    <QueryClientProvider client={client}>
      <Harness initial={initial} onOpenSettings={opts.onOpenSettings ?? (() => {})} seen={seen} />
    </QueryClientProvider>,
  );
  /** The tabs as last rendered: each tab's view and its Back history. */
  const current = () => seen.tabs;
  return { ...result, client, current };
}

/** A saved project as the API returns it. */
export function seedProject(id: string, name: string, kind: ProjectKind = "custom", cluster?: { id: string; provider: string }): ProjectOut {
  return {
    id, name, kind, cluster_id: cluster?.id ?? null, cluster_name: null, cluster_provider: cluster?.provider ?? null,
    links: [], group_ids: [], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}
