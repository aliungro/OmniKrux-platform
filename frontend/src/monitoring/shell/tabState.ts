// The Monitoring app's workspace tabs. Loaded with the shell (the only Monitoring module in the
// initial bundle), so it imports nothing at run time: types only from the shell's workspace.
import type { AppTabs, Tab } from "../../features/shell/workspace";

export type MonitoringView =
  | { page: "home" }
  | ExploreView
  | AlertsView
  | { page: "sources" }
  | { page: "source"; id: string }
  | { page: "setup"; clusterId?: string }
  | { page: "project"; id: string }
  | { page: "group"; id: string }
  | { page: "newGroup" }
  | DashboardView;

/**
 * A dashboard and its view state. `vars` holds each variable's selection by name; the key
 * `__projects` holds a group dashboard's Projects selection (project ids).
 */
export interface DashboardView {
  page: "dashboard";
  id: string;
  tab?: "dashboard" | "json" | "versions";
  vars?: Record<string, string[] | "all">;
  time?: { from: string; to: string };
  refresh?: string | null;
  /** The panel to highlight and scroll to on open. */
  panel?: string;
  /** Open edit mode on that panel's Alert tab; the page acts on it and replaces the view without it. */
  editAlert?: true;
}

/** Alerts, its tab and the rule shown beside the list. */
export interface AlertsView {
  page: "alerts";
  tab?: "rules" | "silences" | "contacts";
  rule?: string;
}

/** Explore and its state: the project, the source, the query, the logs query and the time range. */
export interface ExploreView {
  page: "explore";
  project?: string;
  source?: string;
  expr?: string;
  logs?: string;
  time?: { from: string; to: string };
}

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

/**
 * The same place: page and id, a dashboard's tab (no tab is the Dashboard tab) and Explore's project.
 * Variables, time, refresh and Explore's query are view state, not another place. Used for push
 * de-duplication and the leave check.
 */
export function sameMonitoringView(a: MonitoringView, b: MonitoringView): boolean {
  if (a.page !== b.page) return false;
  if (a.page === "dashboard" && b.page === "dashboard") return a.id === b.id && (a.tab ?? "dashboard") === (b.tab ?? "dashboard");
  if ("id" in a && "id" in b) return a.id === b.id;
  if (a.page === "explore" && b.page === "explore") return a.project === b.project;
  if (a.page === "setup" && b.page === "setup") return a.clusterId === b.clusterId;
  // Alerts: the tab and the selected rule are view state, not another place.
  return true;
}

/** Equal by value, key order aside; a key holding `undefined` counts as absent. */
function equalValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
  const kx = keys(x);
  return kx.length === keys(y).length && kx.every((k) => equalValue(x[k], y[k]));
}

/** The same view with the same view state: a `replace` that would change nothing. */
export function equalMonitoringView(a: MonitoringView, b: MonitoringView): boolean {
  return equalValue(a, b);
}

/** Holds a way out of a tab's page: true means the app asks first and will dispatch it itself. */
export type MonitoringLeaveCheck = (action: MonitoringTabAction) => boolean;

let leaveCheck: MonitoringLeaveCheck | null = null;

export function setMonitoringLeaveCheck(check: MonitoringLeaveCheck | null): void {
  leaveCheck = check;
}

/**
 * Whether the app holds this action. Only a way out of a page is asked about (closing a tab,
 * navigating, Back and Forward); opening, switching and scrolling tabs never are.
 */
export function monitoringLeaveHeld(action: MonitoringTabAction): boolean {
  if (!leaveCheck) return false;
  if (action.type !== "closeTab" && action.type !== "navigate" && action.type !== "back" && action.type !== "forward") return false;
  return leaveCheck(action);
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
    // A push to the same place is a no-op; a replace lands whenever the view state differs.
    if (action.mode === "push" ? sameMonitoringView(tab.view, action.view) : equalMonitoringView(tab.view, action.view)) return tabs;
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
const shortText = (x: unknown, max: number): x is string => typeof x === "string" && x.length <= max;

const DASHBOARD_TABS: readonly unknown[] = ["dashboard", "json", "versions"];
const MAX_VARS = 21; // 20 variables and the Projects selection
const MAX_VALUES = 100;

function parseVars(x: unknown): Record<string, string[] | "all"> | undefined {
  if (!record(x)) return undefined;
  const entries = Object.entries(x);
  if (entries.length > MAX_VARS) return undefined;
  const ok = entries.every(([, v]) => v === "all" || (Array.isArray(v) && v.length <= MAX_VALUES && v.every((s) => shortText(s, MAX_ID))));
  return ok ? Object.fromEntries(entries.map(([k, v]) => [k, v === "all" ? "all" : [...(v as string[])]])) : undefined;
}

/** A dashboard view: the id must be good; each bad part of its view state is dropped on its own. */
function parseDashboard(x: Record<string, unknown>): DashboardView | null {
  if (!validId(x.id)) return null;
  const view: DashboardView = { page: "dashboard", id: x.id };
  if (DASHBOARD_TABS.includes(x.tab)) view.tab = x.tab as DashboardView["tab"];
  const vars = parseVars(x.vars);
  if (vars) view.vars = vars;
  if (record(x.time) && shortText(x.time.from, 40) && shortText(x.time.to, 40)) view.time = { from: x.time.from, to: x.time.to };
  if (x.refresh === null || shortText(x.refresh, 10)) view.refresh = x.refresh;
  if (validId(x.panel)) view.panel = x.panel;
  if (x.editAlert === true) view.editAlert = true;
  return view;
}

const ALERTS_TABS: readonly unknown[] = ["rules", "silences", "contacts"];

/** Alerts: an unknown tab or a rule that isn't a short string is dropped, the view kept. */
function parseAlerts(x: Record<string, unknown>): AlertsView {
  const view: AlertsView = { page: "alerts" };
  if (ALERTS_TABS.includes(x.tab)) view.tab = x.tab as AlertsView["tab"];
  if (validId(x.rule)) view.rule = x.rule;
  return view;
}

const MAX_QUERY = 10000;

/** Explore: each bad part of its state is dropped on its own, the view kept. */
function parseExplore(x: Record<string, unknown>): ExploreView {
  const view: ExploreView = { page: "explore" };
  if (validId(x.project)) view.project = x.project;
  if (validId(x.source)) view.source = x.source;
  if (shortText(x.expr, MAX_QUERY)) view.expr = x.expr;
  if (shortText(x.logs, MAX_QUERY)) view.logs = x.logs;
  if (record(x.time) && shortText(x.time.from, 40) && shortText(x.time.to, 40)) view.time = { from: x.time.from, to: x.time.to };
  return view;
}

/** A saved view, rebuilt from its known fields only; an unknown page (a later version's) is null. */
function parseView(x: unknown): MonitoringView | null {
  if (!record(x)) return null;
  switch (x.page) {
    case "explore":
      return parseExplore(x);
    case "alerts":
      return parseAlerts(x);
    case "home": case "sources": case "newGroup":
      return { page: x.page };
    case "source": case "project": case "group":
      return validId(x.id) ? { page: x.page, id: x.id } : null;
    case "setup":
      if (x.clusterId === undefined) return { page: "setup" };
      return validId(x.clusterId) ? { page: "setup", clusterId: x.clusterId } : null;
    case "dashboard":
      return parseDashboard(x);
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
  dashboard?(id: string): string | undefined;
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
    case "dashboard": return names.dashboard?.(view.id) ?? "Dashboard";
  }
}
