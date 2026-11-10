import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkspace } from "./storage";
import { useTabNav } from "./browserHistory";
import { kindView } from "./workspace";
afterEach(cleanup);

it("pushes browser history while tab back stays inside the page", () => {
  const { result } = renderHook(() => { const {ws,dispatch}=useWorkspace(null); return useTabNav(ws,dispatch); });
  const length = history.length;
  act(() => result.current.navigate(v => kindView(v,"pods"), "push"));
  expect(history.length).toBe(length+1);
  expect(result.current.canBack).toBe(true);
  act(() => result.current.back());
  expect(result.current.view.page).toBe("home");
  expect(result.current.canForward).toBe(true);
});

it("keeps a restored entry number and follows browser directions", () => {
 history.replaceState({omnikrux:5}, "", "/");
 const {result} = renderHook(()=>{const {ws,dispatch}=useWorkspace(null);return useTabNav(ws,dispatch);});
 act(()=>result.current.navigate(v=>kindView(v,"pods"),"push"));
 expect(history.state.omnikrux).toBe(6);
 act(()=>window.dispatchEvent(new PopStateEvent("popstate",{state:{omnikrux:5}})));
 expect(result.current.view.page).toBe("home");
 act(()=>window.dispatchEvent(new PopStateEvent("popstate",{state:{omnikrux:6}})));
 expect(result.current.view.page).toBe("kind");
});

it("back changes the tab without calling browser history back", () => {
 const back = vi.spyOn(history,"back");
 const {result} = renderHook(()=>{const {ws,dispatch}=useWorkspace(null);return useTabNav(ws,dispatch);});
 expect(result.current.canBack).toBe(false);
 act(()=>result.current.navigate(v=>kindView(v,"pods"),"push"));
 act(()=>result.current.back());
 expect(back).not.toHaveBeenCalled();
 expect(result.current.view.page).toBe("home");
 back.mockRestore();
});

it("does not push entries for unchanged views, including same-tick functional updates", () => {
 const {result}=renderHook(()=>{const {ws,dispatch}=useWorkspace(null);return useTabNav(ws,dispatch);});
 const start=history.length;
 act(()=>{
   result.current.navigate(v=>kindView(v,"pods"),"push");
   result.current.navigate(v=>kindView(v,"pods"),"push");
 });
 expect(history.length).toBe(start+1);
 act(()=>result.current.navigate(v=>v,"push"));
 expect(history.length).toBe(start+1);
 act(()=>result.current.back());
 expect(result.current.view.page).toBe("home");
});

it("applies an unnumbered browser link and numbers the entry", () => {
 const {result}=renderHook(()=>{const {ws,dispatch}=useWorkspace(null);return {ws,nav:useTabNav(ws,dispatch)};});
 act(()=>{ history.replaceState(null,"","#/settings");window.dispatchEvent(new PopStateEvent("popstate",{state:null})); });
 expect(result.current.ws.app).toBe("settings");
 expect(history.state.omnikrux).toBe(1);
 expect(location.hash).toBe("#/settings");
});

it("uses the entry direction on the active tab even when it belongs to another tab", () => {
 const {result}=renderHook(()=>{const {ws,dispatch}=useWorkspace(null);return {ws,dispatch,nav:useTabNav(ws,dispatch)};});
 act(()=>result.current.nav.navigate(v=>kindView(v,"pods"),"push"));
 act(()=>result.current.dispatch({type:"newTab"}));
 act(()=>result.current.nav.navigate(v=>kindView(v,"nodes"),"push"));
 act(()=>window.dispatchEvent(new PopStateEvent("popstate",{state:{omnikrux:1}})));
 expect(result.current.nav.view.page).toBe("home");
 act(()=>window.dispatchEvent(new PopStateEvent("popstate",{state:{omnikrux:2}})));
 expect(result.current.nav.view.page).toBe("kind");
 if(result.current.nav.view.page === "kind") expect(result.current.nav.view.kind).toBe("nodes");
});

it("browser back after selecting the current view returns one real step", () => {
 const {result}=renderHook(()=>{const {ws,dispatch}=useWorkspace(null);return useTabNav(ws,dispatch);});
 act(()=>result.current.navigate(v=>kindView(v,"pods"),"push"));
 act(()=>result.current.navigate(v=>kindView(v,"nodes"),"push"));
 const length=history.length;
 act(()=>result.current.navigate(v=>kindView(v,"nodes"),"push"));
 expect(history.length).toBe(length);
 act(()=>window.dispatchEvent(new PopStateEvent("popstate",{state:{omnikrux:1}})));
 expect(result.current.view.page).toBe("kind");
 if(result.current.view.page === "kind") expect(result.current.view.kind).toBe("pods");
});

it.each(["audit", "settings"] as const)("numbered history leaves hidden Kubernetes unchanged in %s", (app)=>{
 const {result}=renderHook(()=>{const {ws,dispatch}=useWorkspace(null);return {ws,dispatch,nav:useTabNav(ws,dispatch)};});
 act(()=>result.current.nav.navigate(v=>kindView(v,"pods"),"push"));
 act(()=>result.current.nav.navigate(v=>kindView(v,"nodes"),"push"));
 act(()=>result.current.dispatch({type:"switchApp",app}));
 act(()=>window.dispatchEvent(new PopStateEvent("popstate",{state:{omnikrux:1}})));
 expect(result.current.ws.app).toBe(app);
 expect(result.current.nav.view).toMatchObject({page:"kind",kind:"nodes"});
 expect(history.state.omnikrux).toBe(1); expect(location.hash).toBe(`#/`+app);
 act(()=>window.dispatchEvent(new PopStateEvent("popstate",{state:{omnikrux:2}})));
 act(()=>result.current.dispatch({type:"switchApp",app:"kubernetes"}));
 expect(result.current.nav.view).toMatchObject({page:"kind",kind:"nodes"});
});
