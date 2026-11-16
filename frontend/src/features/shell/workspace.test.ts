import { describe, expect, it } from "vitest";
import { defaultWorkspace, prepareWorkspaceAction, workspaceReducer as reducePrepared, type KubeView, type Workspace, type WorkspaceAction } from "./workspace";
import { NO_FILTER } from "../territories/model";

const workspaceReducer = (ws: Workspace, action: WorkspaceAction) => reducePrepared(ws, prepareWorkspaceAction(action));
const view = (kind: string): KubeView => ({ page: "kind", kind, clusters: null, filters: NO_FILTER, selected: null, open: false });

describe("workspace", () => {
  it("starts with one home tab and inserts new tabs after the active tab", () => {
    let ws = defaultWorkspace();
    expect(ws.app).toBe("kubernetes");
    expect(ws.kubernetes.tabs.map(t => t.view)).toEqual([{page:"home"}]);
    const first = ws.kubernetes.active;
    ws = workspaceReducer(ws, {type:"newTab", view:view("pods")});
    ws = workspaceReducer(ws, {type:"activateTab", id:first});
    ws = workspaceReducer(ws, {type:"newTab"});
    expect(ws.kubernetes.tabs.map(t => t.view.page)).toEqual(["home", "home", "kind"]);
  });
  it("closes to the right then left and replaces the last tab", () => {
    let ws = defaultWorkspace();
    const first = ws.kubernetes.active;
    ws = workspaceReducer(ws, {type:"newTab", view:view("pods")});
    const second = ws.kubernetes.active;
    ws = workspaceReducer(ws, {type:"activateTab", id:first});
    ws = workspaceReducer(ws, {type:"closeTab", id:first});
    expect(ws.kubernetes.active).toBe(second);
    ws = workspaceReducer(ws, {type:"closeTab", id:second});
    expect(ws.kubernetes.tabs).toHaveLength(1);
    expect(ws.kubernetes.tabs[0].view).toEqual({page:"home"});
    expect(ws.kubernetes.tabs[0].id).not.toBe(second);
    expect(ws.kubernetes.closed).toHaveLength(1);
  });
  it("keeps independent bounded histories, restores closed tabs, and wraps", () => {
    let ws = defaultWorkspace();
    const first = ws.kubernetes.active;
    for (let i=0; i<52; i++) ws = workspaceReducer(ws,{type:"navigate",id:first,view:view(`kind${i}`),mode:"push"});
    expect(ws.kubernetes.tabs[0].back).toHaveLength(50);
    ws = workspaceReducer(ws,{type:"back",id:first});
    const before = ws.kubernetes.tabs[0];
    ws = workspaceReducer(ws,{type:"navigate",id:first,view:view("replacement"),mode:"replace"});
    expect(ws.kubernetes.tabs[0].back).toEqual(before.back);
    expect(ws.kubernetes.tabs[0].forward).toEqual(before.forward);
    ws = workspaceReducer(ws,{type:"newTab",view:view("other")});
    const second = ws.kubernetes.active;
    expect(ws.kubernetes.tabs[1].back).toEqual([]);
    ws = workspaceReducer(ws,{type:"nextTab"});
    expect(ws.kubernetes.active).toBe(first);
    ws = workspaceReducer(ws,{type:"previousTab"});
    expect(ws.kubernetes.active).toBe(second);
    ws = workspaceReducer(ws,{type:"closeTab",id:first});
    ws = workspaceReducer(ws,{type:"reopenClosed",index:0});
    expect(ws.kubernetes.active).toBe(first);
    expect(ws.kubernetes.tabs[1].back).toEqual(before.back);
  });
  it("does not change state for equal pushes or unavailable navigation", () => {
    let ws = defaultWorkspace(); const id = ws.kubernetes.active;
    expect(workspaceReducer(ws,{type:"back",id})).toBe(ws);
    expect(workspaceReducer(ws,{type:"navigate",id,view:{page:"home"},mode:"push"})).toBe(ws);
    ws = workspaceReducer(ws,{type:"navigate",id,view:view("pods"),mode:"push"});
    ws = workspaceReducer(ws,{type:"back",id});
    expect(workspaceReducer(ws,{type:"back",id})).toBe(ws);
    ws = workspaceReducer(ws,{type:"forward",id});
    expect(workspaceReducer(ws,{type:"forward",id})).toBe(ws);
  });
  it("remembers only ten non-home closed tabs", () => {
    let ws = defaultWorkspace();
    for (let i=0; i<12; i++) { ws = workspaceReducer(ws,{type:"newTab",view:view(`kind${i}`)}); ws = workspaceReducer(ws,{type:"closeTab",id:ws.kubernetes.active}); }
    expect(ws.kubernetes.closed).toHaveLength(10);
    expect(ws.kubernetes.closed[0].tab.view).toEqual(view("kind11"));
    ws = workspaceReducer(ws,{type:"closeTab",id:ws.kubernetes.active});
    expect(ws.kubernetes.closed).toHaveLength(10);
  });
});

it("treats filters with the same fields in different property order as the same view", () => {
  const ws = defaultWorkspace(), id = ws.kubernetes.active;
  const a: KubeView = {...view("pods") as Extract<KubeView,{page:"kind"}>, filters:{...NO_FILTER,columns:[{key:"node",op:"oneOf",values:["n"]}]}};
  const b: KubeView = {...a,filters:{...a.filters,columns:[{values:["n"],op:"oneOf",key:"node"}]}};
  const next = workspaceReducer(ws,{type:"navigate",id,view:a,mode:"push"});
  expect(workspaceReducer(next,{type:"navigate",id,view:b,mode:"push"})).toBe(next);
});

it("reduces the same prepared new-tab and close actions deterministically", () => {
  const ws = defaultWorkspace();
  const newAction = {type:"newTab", id:"prepared-id"} as const;
  expect(reducePrepared(ws,newAction)).toEqual(reducePrepared(ws,newAction));
  const kindWs = workspaceReducer(ws,{type:"navigate",id:ws.kubernetes.active,view:view("pods"),mode:"push"});
  const closeAction = {type:"closeTab", id:kindWs.kubernetes.active, replacementId:"replacement", closedAt:123} as const;
  expect(reducePrepared(kindWs,closeAction)).toEqual(reducePrepared(kindWs,closeAction));
});

it("selects the left neighbor and clears forward history on a divergent push", () => {
  let ws=defaultWorkspace(); const first=ws.kubernetes.active;
  ws=workspaceReducer(ws,{type:"navigate",id:first,view:view("pods"),mode:"push"});
  ws=workspaceReducer(ws,{type:"back",id:first});
  ws=workspaceReducer(ws,{type:"navigate",id:first,view:view("jobs"),mode:"push"});
  expect(ws.kubernetes.tabs[0].forward).toEqual([]);
  ws=workspaceReducer(ws,{type:"newTab"});
  ws=workspaceReducer(ws,{type:"closeTab",id:ws.kubernetes.active});
  expect(ws.kubernetes.active).toBe(first);
});
