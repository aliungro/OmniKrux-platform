// The Monitoring app's workspace tabs. Loaded with the shell (the only Monitoring module in the
// initial bundle), so it imports nothing at run time: types only from the shell's workspace.
import type { AppTabs, Tab } from "../../features/shell/workspace";

export type MonitoringView =
  | { page: "home" }
  | { page: "explore" }
  | { page: "alerts" }
  | { page: "sources" }
  | { page: "source"; id: string }
  | { page: "setup"; clusterId?: string }
  | { page: "project"; id: string }
  | { page: "group"; id: string }
  | { page: "newGroup" };

export const MONITORING_HOME: MonitoringView = { page: "home" };

export type MonitoringTabAction =
  | { type: "newTab"; view?: MonitoringView }
  | { type: "closeTab"; id: string }
  | { type: "activateTab" | "back" | "forward"; id: string }
  | { type: "nextTab" | "previousTab" }
  | { type: "navigate"; id: string; view: MonitoringView; mode: "push" | "replace" }
  | { type: "scroll"; id: string; top: number };

/** Reducer actions carry generated data (ids, `closedAt`), made at the dispatch boundary. */
export type PreparedMonitoringTabAction =
  | Exclude<MonitoringTabAction, { type: "newTab" } | { type: "closeTab" }>
  | (Extract<MonitoringTabAction, { type: "newTab" }> & { id: string })
  | { type: "closeTab"; id: string; replacementId: string; closedAt: number };

// The same limits as the Kubernetes tabs; kept here so nothing is imported at run time.
const MAX_BACK = 50;
const MAX_CLOSED = 10;
const MAX_ID = 200;

let counter = 0;
function newId(): string {
  return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `m${Date.now()}-${++counter}`;
}

const newTab = (id: string, view: MonitoringView = MONITORING_HOME): Tab<MonitoringView> => ({ id, view, back: [], forward: [], scrollTop: 0 });

export function defaultMonitoringTabs(): AppTabs<MonitoringView> {
  const tab = newTab(newId());
  return { tabs: [tab], active: tab.id, closed: [] };
}

export function sameMonitoringView(a: MonitoringView, b: MonitoringView): boolean {
  if (a.page !== b.page) return false;
  if ("id" in a && "id" in b) return a.id === b.id;
  if (a.page === "setup" && b.page === "setup") return a.clusterId === b.clusterId;
  return true;
}

export function monitoringTabsReducer(tabs: AppTabs<MonitoringView>, action: PreparedMonitoringTabAction): AppTabs<MonitoringView> {
  const activeIndex = tabs.tabs.findIndex((t) => t.id === tabs.active);
  if (action.type === "newTab") {
    const tab = newTab(action.id, action.view);
    const list = [...tabs.tabs];
    list.splice(activeIndex + 1, 0, tab);
    return { ...tabs, tabs: list, active: tab.id };
  }
  if (action.type === "nextTab" || action.type === "previousTab") {
    const n = tabs.tabs.length;
    const id = tabs.tabs[(activeIndex + (action.type === "nextTab" ? 1 : -1) + n) % n].id;
    return id === tabs.active ? tabs : { ...tabs, active: id };
  }
  if (!("id" in action)) return tabs;
  const index = tabs.tabs.findIndex((t) => t.id === action.id);
  if (index < 0) return tabs;
  const tab = tabs.tabs[index];
  if (action.type === "activateTab") return tabs.active === tab.id ? tabs : { ...tabs, active: tab.id };
  if (action.type === "closeTab") {
    const list = tabs.tabs.filter((_, i) => i !== index);
    if (!list.length) list.push(newTab(action.replacementId));
    const active = tabs.active === tab.id ? list[Math.min(index, list.length - 1)].id : tabs.active;
    const closed = tab.view.page === "home" ? tabs.closed : [{ tab, closedAt: action.closedAt }, ...tabs.closed].slice(0, MAX_CLOSED);
    return { tabs: list, active, closed };
  }
  let next: Tab<MonitoringView>;
  if (action.type === "scroll") {
    if (tab.scrollTop === action.top) return tabs;
    next = { ...tab, scrollTop: action.top };
  } else if (action.type === "navigate") {
    if (sameMonitoringView(tab.view, action.view)) return tabs;
    next = action.mode === "replace"
      ? { ...tab, view: action.view }
      : { ...tab, view: action.view, back: [...tab.back, tab.view].slice(-MAX_BACK), forward: [] };
  } else if (action.type === "back") {
    if (!tab.back.length) return tabs;
    next = { ...tab, view: tab.back[tab.back.length - 1], back: tab.back.slice(0, -1), forward: [...tab.forward, tab.view].slice(-MAX_BACK) };
  } else {
    if (!tab.forward.length) return tabs;
    next = { ...tab, view: tab.forward[tab.forward.length - 1], forward: tab.forward.slice(0, -1), back: [...tab.back, tab.view].slice(-MAX_BACK) };
  }
  const list = [...tabs.tabs];
  list[index] = next;
  return { ...tabs, tabs: list };
}

const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const validId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= MAX_ID;

/** A saved view, rebuilt from its known fields only; an unknown page (a later version's) is null. */
function parseView(x: unknown): MonitoringView | null {
  if (!record(x)) return null;
  switch (x.page) {
    case "home": case "explore": case "alerts": case "sources": case "newGroup":
      return { page: x.page };
    case "source": case "project": case "group":
      return validId(x.id) ? { page: x.page, id: x.id } : null;
    case "setup":
      if (x.clusterId === undefined) return { page: "setup" };
      return validId(x.clusterId) ? { page: "setup", clusterId: x.clusterId } : null;
    default:
      return null;
  }
}

function parseTab(x: unknown): Tab<MonitoringView> | null {
  if (!record(x) || !validId(x.id)) return null;
  const view = parseView(x.view);
  if (!view) return null;
  const history = (h: unknown): MonitoringView[] => Array.isArray(h) ? h.map(parseView).filter((v): v is MonitoringView => v !== null).slice(-MAX_BACK) : [];
  const scrollTop = typeof x.scrollTop === "number" && Number.isFinite(x.scrollTop) && x.scrollTop >= 0 ? x.scrollTop : 0;
  return { id: x.id, view, back: history(x.back), forward: history(x.forward), scrollTop };
}

/** Saved Monitoring tabs; nothing saved (a workspace from before Monitoring) is a fresh Home tab. */
export function parseMonitoringTabs(x: unknown): { tabs: AppTabs<MonitoringView>; dropped: number } {
  if (!record(x) || !Array.isArray(x.tabs)) return { tabs: defaultMonitoringTabs(), dropped: 0 };
  const seen = new Set<string>();
  const tabs: Tab<MonitoringView>[] = [];
  let dropped = 0;
  for (const item of x.tabs) {
    const tab = parseTab(item);
    if (!tab || seen.has(tab.id)) { dropped++; continue; }
    seen.add(tab.id);
    tabs.push(tab);
  }
  if (!tabs.length) tabs.push(newTab(newId()));
  const closed: AppTabs<MonitoringView>["closed"] = [];
  if (Array.isArray(x.closed)) {
    for (const item of x.closed) {
      if (closed.length === MAX_CLOSED) break;
      if (!record(item) || typeof item.closedAt !== "number" || !Number.isFinite(item.closedAt)) continue;
      const tab = parseTab(item.tab);
      if (!tab || seen.has(tab.id)) continue;
      seen.add(tab.id);
      closed.push({ tab, closedAt: item.closedAt });
    }
  }
  const active = typeof x.active === "string" && tabs.some((t) => t.id === x.active) ? x.active : tabs[0].id;
  return { tabs: { tabs, active, closed }, dropped };
}

export interface MonitoringNames {
  project?(id: string): string | undefined;
  group?(id: string): string | undefined;
  source?(id: string): string | undefined;
}

export function monitoringTabLabel(view: MonitoringView, names: MonitoringNames): string {
  switch (view.page) {
    case "home": return "Home";
    case "explore": return "Explore";
    case "alerts": return "Alerts";
    case "sources": return "Sources";
    case "project": return names.project?.(view.id) ?? "Project";
    case "group": return names.group?.(view.id) ?? "Group";
    case "source": return names.source?.(view.id) ?? "Source";
    case "setup": return "New project";
    case "newGroup": return "New group";
  }
}
