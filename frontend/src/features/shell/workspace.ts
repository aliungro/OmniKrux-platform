import { NO_AUDIT_FILTER, type AuditFilters } from "../audit/useAudit";
import { NO_FILTER, type Filters, type RowRef } from "../territories/model";
import { defaultMonitoringTabs, monitoringTabsReducer, type MonitoringTabAction, type MonitoringView, type PreparedMonitoringTabAction } from "../../monitoring/shell/tabState";

export type AppId = "kubernetes" | "monitoring" | "audit" | "settings";
/** Home return controls are page-session history; storage deliberately omits them. */
export type KubeView = { page: "home"; section?: "discovered"; attention?: { expanded: boolean; target: string; clusterId: string } } | { page: "kind"; kind: string; clusters: string[] | null; filters: Filters; selected: RowRef | null; open: boolean; fromAttention?: { clusterId: string; uid: string; namespace: string | null } };
export function kindView(from: KubeView, kind: string, clusters?: string[] | null): Extract<KubeView, { page: "kind" }> {
  return { page:"kind", kind, clusters: clusters ?? (from.page === "kind" ? from.clusters : null), filters:{...(from.page === "kind" ? from.filters : NO_FILTER),status:"all",columns:[],sort:null},selected:null,open:false };
}
export interface Tab<V> { id: string; view: V; back: V[]; forward: V[]; scrollTop: number }
export interface ClosedTab<V> { tab: Tab<V>; closedAt: number }
export interface AppTabs<V> { tabs: Tab<V>[]; active: string; closed: ClosedTab<V>[] }
export interface Workspace {
  version: 1;
  app: AppId;
  kubernetes: AppTabs<KubeView>;
  monitoring: AppTabs<MonitoringView>;
  audit: { filters: AuditFilters };
  /** Page-session layout. The storage validator deliberately omits it. */
  split?: readonly [string, string];
}
export const MAX_BACK = 50;
export const MAX_CLOSED = 10;
export const HOME: KubeView = { page: "home" };
let counter = 0;
export function newTabId(): string { return typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `t${Date.now()}-${++counter}`; }
const newTab = (id: string, view: KubeView = HOME): Tab<KubeView> => ({ id, view, back: [], forward: [], scrollTop: 0 });
export function defaultWorkspace(): Workspace { const tab = newTab(newTabId()); return {version:1,app:"kubernetes",kubernetes:{tabs:[tab],active:tab.id,closed:[]},monitoring:defaultMonitoringTabs(),audit:{filters:{...NO_AUDIT_FILTER}}}; }
export function sameView(a: KubeView, b: KubeView): boolean {
  if (a.page !== b.page) return false;
  if (a.page === "home" || b.page === "home") return a.page === "home" && b.page === "home" && a.section === b.section && a.attention?.expanded === b.attention?.expanded && a.attention?.target === b.attention?.target && a.attention?.clusterId === b.attention?.clusterId;
  const sameArray = (x: string[] | null, y: string[] | null) => x === y || (x !== null && y !== null && x.length === y.length && x.every((v,i)=>v===y[i]));
  return a.fromAttention===b.fromAttention && a.kind===b.kind && sameArray(a.clusters,b.clusters) && a.open===b.open && (a.selected === b.selected || (a.selected !== null && b.selected !== null && a.selected.clusterId===b.selected.clusterId && a.selected.uid===b.selected.uid)) && a.filters.status===b.filters.status && a.filters.text===b.filters.text && a.filters.namespace===b.filters.namespace && a.filters.columns.length===b.filters.columns.length && a.filters.columns.every((x,i)=>{ const y=b.filters.columns[i]; if (x.key!==y.key || x.op!==y.op) return false; if (x.op==="contains" && y.op==="contains") return x.text===y.text; if (x.op==="oneOf" && y.op==="oneOf") return sameArray(x.values,y.values); if (x.op==="between" && y.op==="between") return x.min===y.min && x.max===y.max; return "seconds" in x && "seconds" in y && x.seconds===y.seconds; }) && a.filters.sort?.key===b.filters.sort?.key && a.filters.sort?.dir===b.filters.sort?.dir;
}
export type WorkspaceAction = {type:"switchApp";app:AppId} | {type:"newTab";view?:KubeView;split?:boolean} | {type:"closeTab";id:string} | {type:"activateTab"|"back"|"forward"|"splitTab";id:string} | {type:"nextTab"|"previousTab"|"closeSplit"} | {type:"navigate";id:string;view:KubeView | ((v: KubeView) => KubeView);mode:"push"|"replace"} | {type:"reopenClosed";index:number} | {type:"scroll";id:string;top:number} | {type:"auditFilters";filters:AuditFilters} | {type:"monitoring";action:MonitoringTabAction};
/** Reducer actions carry generated data so reducing the same state and action is deterministic. */
export type PreparedWorkspaceAction = Exclude<WorkspaceAction, {type:"newTab"} | {type:"closeTab"} | {type:"monitoring"}> | (Extract<WorkspaceAction, {type:"newTab"}> & {id:string}) | {type:"closeTab";id:string;replacementId:string;closedAt:number} | {type:"monitoring";action:PreparedMonitoringTabAction};
/** Call once at the dispatch boundary, never from inside the reducer. */
export function prepareWorkspaceAction(action: WorkspaceAction): PreparedWorkspaceAction {
  if (action.type === "monitoring") {
    const inner = action.action;
    if (inner.type === "newTab") return {type:"monitoring",action:{...inner,id:newTabId()}};
    if (inner.type === "closeTab") return {type:"monitoring",action:{...inner,replacementId:newTabId(),closedAt:Date.now()}};
    return {type:"monitoring",action:inner};
  }
  if (action.type === "newTab") return {...action,id:newTabId()};
  if (action.type === "closeTab") return {...action,replacementId:newTabId(),closedAt:Date.now()};
  return action;
}
export function workspaceReducer(ws: Workspace, action: PreparedWorkspaceAction): Workspace {
  if (action.type === "switchApp") return ws.app===action.app ? ws : {...ws,app:action.app};
  if (action.type === "monitoring") {
    const monitoring = monitoringTabsReducer(ws.monitoring, action.action);
    return monitoring === ws.monitoring ? ws : {...ws,monitoring};
  }
  if (action.type === "auditFilters") {
    const a = ws.audit.filters, b = action.filters;
    return a.cluster === b.cluster && a.action === b.action && a.text === b.text && a.outcome === b.outcome
      ? ws
      : { ...ws, audit: { filters: b } };
  }
  const k=ws.kubernetes, activeIndex=k.tabs.findIndex(t=>t.id===k.active);
  if (action.type === "closeSplit") return ws.split ? {...ws, split: undefined} : ws;
  if (action.type === "splitTab") {
    if (action.id === k.active || !k.tabs.some((tab) => tab.id === action.id)) return ws;
    if (ws.split?.includes(action.id)) return ws;
    return { ...ws, split: [k.active, action.id] };
  }
  const set = (next: AppTabs<KubeView>): Workspace => {
    let split = ws.split;
    if (split && split.some((id) => !next.tabs.some((tab) => tab.id === id))) split = undefined;
    if (split && !split.includes(next.active)) {
      split = split[0] === k.active ? [next.active, split[1]] : [split[0], next.active];
    }
    return { ...ws, kubernetes: next, split };
  };
  if (action.type === "newTab") {
    const tab = newTab(action.id, action.view);
    const tabs = [...k.tabs];
    tabs.splice(activeIndex + 1, 0, tab);
    const next = { ...k, tabs, active: tab.id };
    if (!action.split) return set(next);
    const split: Workspace["split"] = ws.split?.[1] === k.active ? [tab.id, k.active] : [k.active, tab.id];
    return { ...ws, kubernetes: next, split };
  }
  if (action.type === "nextTab" || action.type === "previousTab") { const id=k.tabs[(activeIndex+(action.type==="nextTab"?1:-1)+k.tabs.length)%k.tabs.length].id; return id===k.active?ws:set({...k,active:id}); }
  if (action.type === "reopenClosed") { if (!Number.isInteger(action.index) || action.index<0 || action.index>=k.closed.length) return ws; const entry=k.closed[action.index]; const tabs=[...k.tabs]; tabs.splice(activeIndex+1,0,entry.tab); return set({...k,tabs,active:entry.tab.id,closed:k.closed.filter((_,i)=>i!==action.index)}); }
  if (!("id" in action)) return ws;
  const index=k.tabs.findIndex(t=>t.id===action.id); if (index<0) return ws;
  const tab=k.tabs[index];
  if (action.type === "activateTab") return k.active===tab.id ? ws : set({...k,active:tab.id});
  if (action.type === "closeTab") {
    const tabs = k.tabs.filter((_, i) => i !== index);
    if (!tabs.length) tabs.push(newTab(action.replacementId));
    const peer = ws.split?.find((id) => id !== tab.id);
    const active = k.active === tab.id ? peer ?? tabs[Math.min(index, tabs.length - 1)].id : k.active;
    const closed = tab.view.page === "home" ? k.closed : [{ tab, closedAt: action.closedAt }, ...k.closed].slice(0, MAX_CLOSED);
    return set({ tabs, active, closed });
  }
  let next: Tab<KubeView>;
  if (action.type === "scroll") { if (tab.scrollTop===action.top) return ws; next={...tab,scrollTop:action.top}; }
  else if (action.type === "navigate") { const view=typeof action.view === "function" ? action.view(tab.view) : action.view; if (sameView(tab.view,view)) return ws; next=action.mode==="replace" ? {...tab,view} : {...tab,view,back:[...tab.back,tab.view].slice(-MAX_BACK),forward:[]}; }
  else if (action.type === "back") { if (!tab.back.length) return ws; next={...tab,view:tab.back[tab.back.length-1],back:tab.back.slice(0,-1),forward:[...tab.forward,tab.view].slice(-MAX_BACK)}; }
  else { if (!tab.forward.length) return ws; next={...tab,view:tab.forward[tab.forward.length-1],forward:tab.forward.slice(0,-1),back:[...tab.back,tab.view].slice(-MAX_BACK)}; }
  const tabs=[...k.tabs]; tabs[index]=next; return set({...k,tabs});
}
