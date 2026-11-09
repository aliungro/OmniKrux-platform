import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_FILTER } from "../territories/model";
import { defaultWorkspace } from "./workspace";
import { parseWorkspace, serializeWorkspace, useWorkspace } from "./storage";

const kind = {page:"kind",kind:"pods",clusters:["c"],filters:{...NO_FILTER,columns:[{key:"node",op:"oneOf",values:["n"]}]},selected:{clusterId:"c",uid:"u"},open:true};
const raw = (tabs: unknown[]) => JSON.stringify({version:1,app:"kubernetes",kubernetes:{tabs,active:"a",closed:[]},audit:{filters:{cluster:"",action:"",text:""}}});
const tab = (view: unknown) => ({id:"a",view,back:[],forward:[],scrollTop:4});
afterEach(() => { vi.useRealTimers(); });
describe("workspace storage", () => {
  it("round trips all fields and UI-created filters", () => {
    const ws = defaultWorkspace(); ws.kubernetes.tabs[0] = {...ws.kubernetes.tabs[0], view:kind as typeof ws.kubernetes.tabs[0]["view"]};
    expect(parseWorkspace(serializeWorkspace(ws)).workspace).toEqual(ws);
  });
  it("reports corrupt and future storage", () => {
    expect(parseWorkspace("{").problem).toEqual({text:"they aren't valid JSON",reset:true});
    expect(parseWorkspace('{"version":2}').problem).toEqual({text:"they're from another version of Omnikrux",reset:true});
  });
  it("drops invalid tabs, duplicate IDs and history while preserving valid filters", () => {
    const result = parseWorkspace(raw([{...tab(kind),back:[kind,{...kind,kind:"bad key"}],forward:[{...kind,filters:{...kind.filters,text:"x".repeat(501)}}]},tab(kind),tab({...kind,kind:"bad key"})]));
    expect(result.workspace.kubernetes.tabs).toHaveLength(1);
    expect(result.workspace.kubernetes.tabs[0].back).toHaveLength(1);
    expect(result.workspace.kubernetes.tabs[0].forward).toHaveLength(0);
    expect(result.problem).toEqual({text:"2 saved tabs couldn't be read and were left out",reset:false});
  });
  it("drops malformed column filters and sort without dropping the tab", () => {
    const result = parseWorkspace(raw([tab({...kind,filters:{...kind.filters,columns:[kind.filters.columns[0],{key:"x",op:"bad"}],sort:{key:"x",dir:"wrong"}}})]));
    const v = result.workspace.kubernetes.tabs[0].view;
    expect(v.page === "kind" && v.filters.columns).toEqual(kind.filters.columns);
    expect(v.page === "kind" && v.filters.sort).toBeNull();
  });
  it("saves debounced, flushes on pagehide and unmount, and reports quota", () => {
    vi.useFakeTimers(); const storage = {getItem:()=>null,setItem:vi.fn(),removeItem:()=>{},clear:()=>{},key:()=>null,length:0} satisfies Storage;
    const hook = renderHook(()=>useWorkspace(storage));
    act(()=>{hook.result.current.dispatch({type:"newTab"}); hook.result.current.dispatch({type:"newTab"});});
    expect(storage.setItem).not.toHaveBeenCalled();
    act(()=>vi.advanceTimersByTime(300)); expect(storage.setItem).toHaveBeenCalledTimes(1);
    act(()=>hook.result.current.dispatch({type:"newTab"})); act(()=>window.dispatchEvent(new Event("pagehide")));
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    act(()=>hook.result.current.dispatch({type:"newTab"})); hook.unmount(); expect(storage.setItem).toHaveBeenCalledTimes(3);
    const full = {...storage,setItem:()=>{throw new DOMException("full","QuotaExceededError");}};
    const second = renderHook(()=>useWorkspace(full)); act(()=>second.result.current.dispatch({type:"newTab"})); act(()=>vi.advanceTimersByTime(300));
    expect(second.result.current.saveProblem).toBe("storage is full"); second.unmount();
  });
  it("keeps independent state with last save winning", () => {
    vi.useFakeTimers(); const storage = window.localStorage; storage.clear();
    const a = renderHook(()=>useWorkspace(storage)); const b = renderHook(()=>useWorkspace(storage));
    act(()=>a.result.current.dispatch({type:"newTab"})); act(()=>vi.advanceTimersByTime(300));
    act(()=>b.result.current.dispatch({type:"switchApp",app:"audit"})); act(()=>vi.advanceTimersByTime(300));
    expect(a.result.current.ws.kubernetes.tabs).toHaveLength(2);
    expect(parseWorkspace(storage.getItem("omnikrux.workspace")).workspace.app).toBe("audit");
    a.unmount(); b.unmount();
  });
});

describe("storage boundaries", () => {
  it("does not serialize unexpected secret fields", () => {
    const ws = defaultWorkspace();
    ws.kubernetes.tabs[0].view = Object.assign({}, ws.kubernetes.tabs[0].view, {secretValue:"sensitive"});
    expect(serializeWorkspace(ws)).not.toContain("sensitive");
  });
  it("continues in memory when storage access is blocked", () => {
    const blocked = {getItem:()=>{throw new DOMException("denied","SecurityError");},setItem:()=>{},removeItem:()=>{},clear:()=>{},key:()=>null,length:0} satisfies Storage;
    const hook = renderHook(()=>useWorkspace(blocked));
    expect(hook.result.current.loadProblem).toContain("this browser blocks site storage");
    act(()=>hook.result.current.dispatch({type:"newTab"}));
    expect(hook.result.current.ws.kubernetes.tabs).toHaveLength(2);
    act(()=>hook.result.current.dismissLoadProblem());
    expect(hook.result.current.loadProblem).toBeNull();
    hook.unmount();
  });
});
