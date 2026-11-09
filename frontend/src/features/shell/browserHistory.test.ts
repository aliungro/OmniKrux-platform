import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useWorkspace } from "./storage";
import { useTabNav } from "./browserHistory";
import { kindView } from "./workspace";

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
