import { useCallback, useEffect, useRef } from "react";
import { hashFor, parseHash } from "../../route";
import { kindView, sameView, workspaceReducer, type KubeView, type Workspace, type WorkspaceAction } from "./workspace";
export interface TabNav<V> { view: V; navigate(view: V | ((v: V) => V), mode: "push" | "replace"): void; back(): void; forward(): void; canBack: boolean; canForward: boolean; setScroll(top:number):void; scrollTop:number }
export function useTabNav(ws: Workspace, dispatch: (action:WorkspaceAction)=>void): TabNav<KubeView> {
 const current=useRef(ws); current.current=ws;
 const seq=useRef(Number.isFinite(history.state?.omnikrux) ? history.state.omnikrux as number : 0);
 const tab=ws.kubernetes.tabs.find(t=>t.id===ws.kubernetes.active)!;
 const replace=useCallback(()=>history.replaceState({omnikrux:seq.current},"",hashFor(current.current.app,current.current.kubernetes.active)),[]);
 const applyLink=useCallback(()=>{ const target=parseHash(location.hash); const state=current.current; if (!target) return; if ("legacyKind" in target) { dispatch({type:"switchApp",app:"kubernetes"}); const t=state.kubernetes.tabs.find(x=>x.id===state.kubernetes.active)!; if(t.view.page==="kind") dispatch({type:"navigate",id:t.id,view:kindView(t.view,target.legacyKind),mode:"push"}); else dispatch({type:"newTab",view:kindView(t.view,target.legacyKind)}); } else { dispatch({type:"switchApp",app:target.app}); if(target.app==="kubernetes" && target.tab && state.kubernetes.tabs.some(t=>t.id===target.tab)) dispatch({type:"activateTab",id:target.tab}); } },[dispatch]);
 useEffect(()=>{ applyLink(); replace(); const pop=(e:PopStateEvent)=>{ const n=e.state?.omnikrux; if(typeof n !== "number" || !Number.isFinite(n)) { applyLink(); seq.current++; } else { const id=current.current.kubernetes.active; if(n<seq.current) dispatch({type:"back",id}); else if(n>seq.current) dispatch({type:"forward",id}); seq.current=n; } replace(); }; window.addEventListener("popstate",pop); return ()=>window.removeEventListener("popstate",pop); },[applyLink,dispatch,replace]);
 useEffect(()=>{replace();},[ws.app,ws.kubernetes.active,replace]);
 const navigate=useCallback((view:KubeView|((v:KubeView)=>KubeView),mode:"push"|"replace")=>{
   const active=current.current.kubernetes.tabs.find(t=>t.id===tab.id);
   if (!active) return;
   const next=typeof view === "function" ? view(active.view) : view;
   if (sameView(active.view,next)) return;
   const action={type:"navigate" as const,id:tab.id,view:next,mode};
   current.current=workspaceReducer(current.current,action);
   dispatch(action);
   if(mode==="push") history.pushState({omnikrux:++seq.current},"",hashFor("kubernetes",tab.id)); else replace();
 },[dispatch,tab.id,replace]);
 const back=useCallback(()=>{const action={type:"back" as const,id:tab.id};current.current=workspaceReducer(current.current,action);dispatch(action);replace();},[dispatch,tab.id,replace]);
 const forward=useCallback(()=>{const action={type:"forward" as const,id:tab.id};current.current=workspaceReducer(current.current,action);dispatch(action);replace();},[dispatch,tab.id,replace]);
 const timer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
 const pendingScroll=useRef<{id:string;top:number} | null>(null);
 const flushScroll=useCallback(()=>{clearTimeout(timer.current);const pending=pendingScroll.current;pendingScroll.current=null;if(pending) dispatch({type:"scroll",...pending});},[dispatch]);
 const setScroll=useCallback((top:number)=>{if(pendingScroll.current && pendingScroll.current.id!==tab.id) flushScroll();clearTimeout(timer.current);pendingScroll.current={id:tab.id,top};timer.current=setTimeout(flushScroll,200);},[tab.id,flushScroll]);
 useEffect(()=>()=>flushScroll(),[tab.id,flushScroll]);
 return {view:tab.view,navigate,back,forward,canBack:tab.back.length>0,canForward:tab.forward.length>0,setScroll,scrollTop:tab.scrollTop};
}
