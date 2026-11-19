import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { isKindKey } from "../../route";
import { NO_AUDIT_FILTER, type AuditFilters } from "../audit/useAudit";
import { validColumnFilter, validSort } from "../territories/columnFilters";
import { FILTER_STATUSES, type FilterStatus } from "../territories/model";
import { defaultWorkspace, HOME, MAX_BACK, MAX_CLOSED, newTabId, prepareWorkspaceAction, workspaceReducer, type AppId, type KubeView, type Tab, type Workspace, type WorkspaceAction } from "./workspace";

export const STORAGE_KEY = "omnikrux.workspace";
export const SAVE_DEBOUNCE_MS = 300;
type Problem = {text:string;reset:boolean};
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.length <= 500;
function view(x: unknown): KubeView | null {
  if (!record(x)) return null;
  if (x.page === "home") return x.section === "discovered" ? { page: "home", section: "discovered" } : HOME;
  if (x.page !== "kind" || typeof x.kind !== "string" || !isKindKey(x.kind) || !(x.clusters === null || Array.isArray(x.clusters) && x.clusters.every(c=>typeof c === "string")) || !record(x.filters)) return null;
  const f=x.filters;
  if (!FILTER_STATUSES.includes(f.status as FilterStatus) || !text(f.text) || !(f.namespace===null || typeof f.namespace === "string") || !Array.isArray(f.columns) || !(x.selected===null || record(x.selected) && typeof x.selected.clusterId === "string" && typeof x.selected.uid === "string") || typeof x.open !== "boolean") return null;
  return {page:"kind",kind:x.kind,clusters:x.clusters as string[] | null,filters:{status:f.status as FilterStatus,text:f.text,namespace:f.namespace as string | null,columns:f.columns.map(validColumnFilter).filter((c): c is NonNullable<typeof c> => c!==null),sort:validSort(f.sort)},selected:x.selected===null?null:{clusterId:(x.selected as Record<string,string>).clusterId,uid:(x.selected as Record<string,string>).uid},open:x.open,...(x.kind === "pods" && record(x.fromAttention) && record(x.selected) && x.fromAttention.clusterId === x.selected.clusterId && x.fromAttention.uid === x.selected.uid && x.fromAttention.namespace === f.namespace ? {fromAttention: {clusterId:x.selected.clusterId as string,uid:x.selected.uid as string,namespace:f.namespace as string | null}} : {})};
}
function tab(x: unknown): Tab<KubeView> | null {
  if (!record(x) || typeof x.id !== "string" || !x.id) return null;
  const v=view(x.view); if (!v) return null;
  const history=(v:unknown): KubeView[] => Array.isArray(v) ? v.map(view).filter((item): item is KubeView => item!==null).slice(-MAX_BACK) : [];
  return {id:x.id,view:v,back:history(x.back),forward:history(x.forward),scrollTop:typeof x.scrollTop === "number" && Number.isFinite(x.scrollTop) && x.scrollTop>=0 ? x.scrollTop : 0};
}
function audit(x: unknown): AuditFilters {
  if (!record(x) || !text(x.cluster) || !text(x.action) || !text(x.text)) return { ...NO_AUDIT_FILTER };
  return { cluster: x.cluster, action: x.action, text: x.text, outcome: x.outcome === "failed" ? "failed" : "" };
}
export function parseWorkspace(raw: string | null): {workspace:Workspace;problem:Problem|null} {
  if (raw===null) return {workspace:defaultWorkspace(),problem:null};
  let value: unknown; try { value=JSON.parse(raw); } catch { return {workspace:defaultWorkspace(),problem:{text:"they aren't valid JSON",reset:true}}; }
  if (!record(value) || value.version!==1) return {workspace:defaultWorkspace(),problem:{text:"they're from another version of OmniKrux",reset:true}};
  const malformedTabs=!record(value.kubernetes) || !Array.isArray(value.kubernetes.tabs);
  const k=record(value.kubernetes)?value.kubernetes:{}; const seen=new Set<string>(); let dropped=0;
  const tabs: Tab<KubeView>[]=[];
  if (Array.isArray(k.tabs)) for (const item of k.tabs) { const t=tab(item); if (!t || seen.has(t.id)) { dropped++; continue; } seen.add(t.id); tabs.push(t); }
  const reset=tabs.length===0;
  if (reset) tabs.push({id:newTabId(),view:HOME,back:[],forward:[],scrollTop:0});
  const closed: Workspace["kubernetes"]["closed"]=[];
  if (Array.isArray(k.closed)) for (const item of k.closed) { if (!record(item) || typeof item.closedAt!=="number" || !Number.isFinite(item.closedAt)) continue; const t=tab(item.tab); if (!t || seen.has(t.id)) continue; seen.add(t.id); closed.push({tab:t,closedAt:item.closedAt}); if (closed.length===MAX_CLOSED) break; }
  const app: AppId = value.app === "audit" || value.app === "settings" ? value.app : "kubernetes";
  const workspace: Workspace={version:1,app,kubernetes:{tabs,active:typeof k.active==="string" && tabs.some(t=>t.id===k.active) ? k.active : tabs[0].id,closed},audit:{filters:audit(record(value.audit)?value.audit.filters:null)}};
  const message=dropped===1 ? "1 saved tab couldn't be read and was left out" : `${dropped} saved tabs couldn't be read and were left out`;
  return {workspace,problem:malformedTabs?{text:"the saved tab list is missing or invalid",reset:true}:dropped?{text:message,reset}:null};
}
export function serializeWorkspace(ws: Workspace): string { return JSON.stringify(parseWorkspace(JSON.stringify(ws)).workspace); }
export function storageProblem(err: unknown): string { if (record(err) || err instanceof Error || err instanceof DOMException) { if (err.name==="QuotaExceededError") return "storage is full"; if (err.name==="SecurityError") return "this browser blocks site storage"; if (typeof err.message==="string") return err.message; } return String(err); }
export function useWorkspace(storage?: Storage | null): {ws:Workspace;dispatch:(a:WorkspaceAction)=>void;loadProblem:string|null;saveProblem:string|null;dismissLoadProblem:()=>void} {
  const [initial] = useState(() => {
    const failed = (message: string) => ({workspace:defaultWorkspace(),problem:{text:message,reset:true},store:null,accessProblem:message});
    let store: Storage | null;
    try { store=storage===undefined ? window.localStorage : storage; } catch { return failed("this browser blocks site storage"); }
    try { return {...parseWorkspace(store?.getItem(STORAGE_KEY) ?? null),store,accessProblem:null}; } catch (error) { return failed(storageProblem(error)); }
  });
  const [ws,reduceDispatch] = useReducer(workspaceReducer,initial.workspace);
  const dispatch = useCallback((action: WorkspaceAction) => reduceDispatch(prepareWorkspaceAction(action)), []);
  const [loadProblem,setLoadProblem]=useState<string|null>(()=>initial.problem ? initial.problem.reset ? `Your saved tabs couldn't be read (${initial.problem.text}), so OmniKrux started with a fresh Home tab.` : `${initial.problem.text}; the rest are back.` : null);
  const [saveProblem,setSaveProblem]=useState<string|null>(null);
  const latest=useRef(ws); const pending=useRef(false); const timer=useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush=useCallback(() => { if (!pending.current) return; pending.current=false; if (timer.current!==null) {clearTimeout(timer.current); timer.current=null;} try { if (initial.accessProblem !== null) { setSaveProblem(initial.accessProblem); return; } initial.store?.setItem(STORAGE_KEY,serializeWorkspace(latest.current)); setSaveProblem(null); } catch (error) { setSaveProblem(storageProblem(error)); } },[initial.store,initial.accessProblem]);
  useEffect(()=>{ if (latest.current===ws) return; latest.current=ws; pending.current=true; if (timer.current!==null) clearTimeout(timer.current); timer.current=setTimeout(flush,SAVE_DEBOUNCE_MS); },[ws,flush]);
  useEffect(()=>{ window.addEventListener("pagehide",flush); return ()=>{window.removeEventListener("pagehide",flush); flush();}; },[flush]);
  return {ws,dispatch,loadProblem,saveProblem,dismissLoadProblem:()=>setLoadProblem(null)};
}
