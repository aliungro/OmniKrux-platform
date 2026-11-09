import { useCallback, useEffect, useRef } from "react";
import { hashFor, parseHash } from "../../route";
import { kindView, type KubeView, type Workspace, type WorkspaceAction } from "./workspace";
export interface TabNav<V> { view: V; navigate(view: V | ((v: V) => V), mode: "push" | "replace"): void; back(): void; forward(): void; canBack: boolean; canForward: boolean; setScroll(top:number):void; scrollTop:number }
export function useTabNav(ws: Workspace, dispatch: (action:WorkspaceAction)=>void): TabNav<KubeView> {
 const current=useRef(ws); current.current=ws;
 const seq=useRef(Number.isFinite(history.state?.omnikrux) ? history.state.omnikrux as number : 0);
 const tab=ws.kubernetes.tabs.find(t=>t.id===ws.kubernetes.active)!;
 const replace=useCallback(()=>history.replaceState({omnikrux:seq.current},"",hashFor(current.current.app,current.current.kubernetes.active)),[]);
 const applyLink=useCallback(()=>{ const target=parseHash(location.hash); const state=current.current; if (!target) return; if ("legacyKind" in target) { dispatch({type:"switchApp",app:"kubernetes"}); const t=state.kubernetes.tabs.find(x=>x.id===state.kubernetes.active)!; if(t.view.page==="kind") dispatch({type:"navigate",id:t.id,view:kindView(t.view,target.legacyKind),mode:"push"}); else dispatch({type:"newTab",view:kindView(t.view,target.legacyKind)}); } else { dispatch({type:"switchApp",app:target.app}); if(target.app==="kubernetes" && target.tab && state.kubernetes.tabs.some(t=>t.id===target.tab)) dispatch({type:"activateTab",id:target.tab}); } },[dispatch]);
 useEffect(()=>{ applyLink(); replace(); const pop=(e:PopStateEvent)=>{ const n=e.state?.omnikrux; if(typeof n !== "number" || !Number.isFinite(n)) { applyLink(); seq.current++; } else { const id=current.current.kubernetes.active; if(n<seq.current) dispatch({type:"back",id}); else if(n>seq.current) dispatch({type:"forward",id}); seq.current=n; } replace(); }; window.addEventListener("popstate",pop); return ()=>window.removeEventListener("popstate",pop); },[applyLink,dispatch,replace]);
 useEffect(()=>{replace();},[ws.app,ws.kubernetes.active,replace]);
 const navigate=useCallback((view:KubeView|((v:KubeView)=>KubeView),mode:"push"|"replace")=>{ dispatch({type:"navigate",id:tab.id,view,mode}); if(mode==="push") history.pushState({omnikrux:++seq.current},"",hashFor("kubernetes",tab.id)); else replace(); },[dispatch,tab.id,replace]);
 const back=useCallback(()=>{dispatch({type:"back",id:tab.id});replace();},[dispatch,tab.id,replace]);
 const forward=useCallback(()=>{dispatch({type:"forward",id:tab.id});replace();},[dispatch,tab.id,replace]);
 const timer=useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
 const setScroll=useCallback((top:number)=>{clearTimeout(timer.current);timer.current=setTimeout(()=>dispatch({type:"scroll",id:tab.id,top}),200);},[dispatch,tab.id]);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 return {view:tab.view,navigate,back,forward,canBack:tab.back.length>0,canForward:tab.forward.length>0,setScroll,scrollTop:tab.scrollTop};
}
