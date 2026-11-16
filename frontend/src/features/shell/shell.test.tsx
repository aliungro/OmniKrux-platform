import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Rail } from "./Rail";
import { Shell } from "./Shell";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { HOME, kindView, defaultWorkspace } from "./workspace";
import { KINDS } from "../../test/kinds";
import { describeBody, container } from "../../test/describe";
import type { Cluster, ResourceRow } from "../../api/types";
import { FakeWebSocket } from "../logs/fakeWebSocket";
vi.mock("@xterm/xterm", () => ({Terminal:class {}}));
vi.mock("@xterm/addon-fit", () => ({FitAddon:class {}}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
const east: Cluster = {id:"c1",name:"East",provider:"aks",context_name:"x",server:"https://east",...FILE_CLUSTER_METADATA, original_server:null,region:null,environment:"development",state:"ready",message:null};
function stubClusters(clusters: Cluster[]) {
 vi.stubGlobal("fetch",vi.fn((url:string)=>Promise.resolve(new Response(JSON.stringify(url.startsWith("/api/kinds")?KINDS:url==="/api/clusters"?clusters:url.startsWith("/api/audit")?{records:[],next_before:null}:url==="/api/settings"?{encryption:{source:"environment",path:null},discovery_interval_s:600}:[]),{status:200,headers:{"content-type":"application/json"}}))));
}
beforeEach(()=>{
 FakeWebSocket.instances = [];
 vi.stubGlobal("WebSocket",FakeWebSocket);
 stubClusters([east]);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function renderShell(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Shell/></QueryClientProvider>);}
it("lists the built apps and marks the current app", () => {
  render(<Rail app="kubernetes" onSelect={() => {}} />);
  const nav = screen.getByRole("navigation", { name: "Apps" });
  expect(nav.querySelectorAll("button")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "Kubernetes" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "Audit log" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
});
it("opens Home, switches apps, and restores its workspace",()=>{
 renderShell();
 expect(screen.getByRole("heading",{name:"Where do you want to look?"})).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"New tab"}));
 expect(within(screen.getByRole("tablist",{name:"Kubernetes tabs"})).getAllByRole("tab")).toHaveLength(2);
 fireEvent.keyDown(document.body,{key:"8",code:"Digit8",altKey:true});
 expect(screen.getByRole("tablist",{name:"Audit log tabs"})).toBeTruthy();
 fireEvent.keyDown(document.body,{key:"1",code:"Digit1",altKey:true});
 expect(within(screen.getByRole("tablist",{name:"Kubernetes tabs"})).getAllByRole("tab")).toHaveLength(2);
});
it("leaves Alt shortcuts to a focused terminal",()=>{
 renderShell(); const terminal=document.createElement("div"); terminal.className="xterm";terminal.tabIndex=0;document.body.append(terminal);terminal.focus();
 fireEvent.keyDown(terminal,{key:"9",code:"Digit9",altKey:true});
 expect(screen.getByRole("tablist",{name:"Kubernetes tabs"})).toBeTruthy();terminal.remove();
});
it("closes the active tab and activates its neighbour",()=>{
 renderShell();fireEvent.click(screen.getByRole("button",{name:"New tab"}));
 const tabs=screen.getByRole("tablist",{name:"Kubernetes tabs"});
 expect(within(tabs).getAllByRole("tab")).toHaveLength(2);
 const closes=within(tabs).getAllByRole("button",{name:"Close tab Home"});
 fireEvent.click(closes[1]);
 expect(within(tabs).getAllByRole("tab")).toHaveLength(1);
 expect(within(tabs).getByRole("tab").getAttribute("aria-selected")).toBe("true");
});
it("ignores AltGr app shortcuts",()=>{
 renderShell();fireEvent.keyDown(document.body,{key:"[",code:"Digit8",altKey:true,ctrlKey:true});
 expect(screen.getByRole("tablist",{name:"Kubernetes tabs"})).toBeTruthy();
});

it.each(["Audit log", "Settings"])("does not offer Close tab in %s", (app)=>{
 renderShell();
 fireEvent.click(screen.getByRole("button",{name:"New tab"}));
 fireEvent.click(screen.getByRole("button",{name:app}));
 fireEvent.click(screen.getByRole("button",{name:"Commands and kinds"}));
 expect(within(screen.getByRole("dialog",{name:"Commands"})).queryByRole("option",{name:"Close tab"})).toBeNull();
 fireEvent.keyDown(within(screen.getByRole("dialog",{name:"Commands"})).getByRole("combobox"),{key:"Escape"});
 fireEvent.click(screen.getByRole("button",{name:"Kubernetes"}));
 expect(within(screen.getByRole("tablist",{name:"Kubernetes tabs"})).getAllByRole("tab")).toHaveLength(2);
});

it("Alt+Left prevents the browser default and steps back once",async()=>{
 renderShell();fireEvent.click(await screen.findByRole("button",{name:/East/}));
 const event=new KeyboardEvent("keydown",{key:"ArrowLeft",altKey:true,bubbles:true,cancelable:true});
 fireEvent(document.body,event);
 expect(event.defaultPrevented).toBe(true);
 expect(screen.getByRole("heading",{name:"Where do you want to look?"})).toBeTruthy();
 expect((screen.getByRole("button",{name:"Forward"}) as HTMLButtonElement).disabled).toBe(false);
});

it("widens Home’s cluster scope in the same tab and restores it on Back", async () => {
  stubClusters([east, { ...east, id: "c2", name: "West", provider: "gke" }]);
  renderShell();
  fireEvent.click(await screen.findByRole("button", { name: /East/ }));
  const filters = await screen.findByRole("group", { name: "Filter rows" });
  const input = within(filters).getByRole<HTMLInputElement>("textbox", { name: /Filter by name/ });
  fireEvent.change(input, { target: { value: "api" } });
  expect(within(filters).queryByRole("button", { name: "Clusters" })).toBeNull();
  fireEvent.click(within(filters).getByRole("button", { name: "Show all clusters" }));
  expect(document.activeElement).toBe(within(filters).getByRole("button", { name: "Clusters" }));
  expect(input.value).toBe("api");
  expect(within(screen.getByRole("tablist", { name: "Kubernetes tabs" })).getAllByRole("tab")).toHaveLength(1);
  expect(within(screen.getByRole("tablist", { name: "Kinds" })).getByRole("tab", { name: /Pods/, selected: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(within(filters).getByRole("button", { name: "Show all clusters" })).toBeTruthy();
  expect(within(filters).queryByRole("button", { name: "Clusters" })).toBeNull();
  expect(input.value).toBe("api");
});

it("steps kinds from a new view with no selected row and from a focused resource row", async () => {
  for (const key of ["clientHeight", "offsetHeight", "clientWidth", "offsetWidth"] as const) {
    vi.spyOn(HTMLElement.prototype, key, "get").mockReturnValue(600);
  }
  renderShell();
  fireEvent.click(await screen.findByRole("button", { name: /East/ }));
  await within(await screen.findByRole("tablist", { name: "Kinds" })).findByRole("tab", { name: "Deployments" });
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  await screen.findByRole("grid", { name: "Deployments by cluster" });

  const socket = await waitFor(() => {
    const connection = FakeWebSocket.instances.filter(w => w.params.get("kind") === "deployments.apps" && !w.closedByClient).at(-1);
    if (!connection) throw new Error("Waiting for the Deployments watch");
    return connection;
  });
  act(() => {
    socket.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    socket.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [{
      uid: "dep", cluster_id: "c1", kind: "Deployment", namespace: "demo", name: "api",
      created_at: null, labels: {}, columns: {},
    }] });
  });
  const row = (await screen.findByRole("gridcell", { name: "api" })).closest<HTMLElement>("[data-row-key]")!;
  row.focus();
  fireEvent.keyDown(row, { key: "ArrowLeft" });
  await screen.findByRole("grid", { name: "Pods by cluster" });
});

it("steps kinds from the console after workspace and app switches", async () => {
  renderShell();
  fireEvent.click(await screen.findByRole("button", { name: /East/ }));
  await within(await screen.findByRole("tablist", { name: "Kinds" })).findByRole("tab", { name: "Deployments" });
  fireEvent.click(screen.getByRole("button", { name: "New tab" }));
  const tabs = screen.getByRole("tablist", { name: "Kubernetes tabs" });
  fireEvent.click(within(tabs).getByRole("tab", { name: /Pods/ }));
  const console = screen.getByRole("main");
  await waitFor(() => expect(document.activeElement).toBe(console));
  fireEvent.keyDown(console, { key: "ArrowRight" });
  await screen.findByRole("grid", { name: "Deployments by cluster" });
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  await waitFor(() => expect(document.activeElement).toBe(console));
  fireEvent.keyDown(console, { key: "ArrowLeft" });
  await screen.findByRole("grid", { name: "Pods by cluster" });
});

it("keeps horizontal keys with the filter, menu, dialog, terminal and workspace tabs", async () => {
  const ws = defaultWorkspace();
  ws.kubernetes.tabs[0].view = kindView(HOME, "pods");
  ws.kubernetes.tabs.push({ id: "other", view: HOME, back: [], forward: [], scrollTop: 0 });
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws));
  renderShell();
  const kinds = within(await screen.findByRole("tablist", { name: "Kinds" }));
  const pods = kinds.getByRole("tab", { name: /Pods/, selected: true });
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: /Filter by name/ });
  fireEvent.change(input, { target: { value: "api" } });
  input.focus();
  input.setSelectionRange(2, 2);
  await userEvent.keyboard("{ArrowLeft}");
  expect(input.selectionStart).toBe(1);
  expect(kinds.getByRole("tab", { selected: true })).toBe(pods);

  fireEvent.contextMenu(pods);
  const menu = screen.getByRole("menu");
  fireEvent.keyDown(within(menu).getAllByRole("menuitem")[0], { key: "ArrowRight" });
  expect(kinds.getByRole("tab", { selected: true })).toBe(pods);
  fireEvent.keyDown(menu, { key: "Escape" });

  fireEvent.keyDown(pods, { key: "?" });
  const dialog = screen.getByRole("dialog", { name: "All shortcuts" });
  expect(within(dialog).getByText("Move between kinds")).toBeTruthy();
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  expect(kinds.getByRole("tab", { selected: true })).toBe(pods);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

  const terminal = document.createElement("div");
  terminal.className = "xterm";
  terminal.tabIndex = 0;
  screen.getByRole("main").append(terminal);
  try {
    terminal.focus();
    fireEvent.keyDown(terminal, { key: "ArrowRight" });
    expect(document.activeElement).toBe(terminal);
    expect(kinds.getByRole("tab", { selected: true })).toBe(pods);
  } finally {
    terminal.remove();
  }

  const tabs = within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
  const workspace = tabs.getByRole("tab", { name: /Pods/ });
  workspace.focus();
  fireEvent.keyDown(workspace, { key: "ArrowRight" });
  expect(document.activeElement).toBe(tabs.getByRole("tab", { name: "Home" }));
  expect(kinds.getByRole("tab", { selected: true })).toBe(pods);
});

it("labels scoped tabs and renders the provider-colour stripes",()=>{
 const clusters:Cluster[]=[{id:"one",name:"East",provider:"aks",context_name:"x",server:"x",...FILE_CLUSTER_METADATA, original_server:null,region:null,environment:"development",state:"ready",message:null},{id:"two",name:"West",provider:"gke",context_name:"y",server:"y",...FILE_CLUSTER_METADATA, original_server:null,region:null,environment:"development",state:"ready",message:null}];
 const view=kindView(HOME,"pods",["one","two"]);
 render(<WorkspaceTabs app="kubernetes" tabs={[{id:"t",view,back:[],forward:[],scrollTop:0}]} active="t" clusters={clusters} kinds={KINDS.kinds} onActivate={()=>{}} onClose={()=>{}} onNew={()=>{}}/>);
 const tab=screen.getByRole("tab",{name:"Pods · 2 clusters"});
 expect(tab.getAttribute("title")).toBe("Pods on East, West");
 const stripes=tab.parentElement!.querySelectorAll("[style]");
 expect(Array.from(stripes).map(e=>(e as HTMLElement).style.background)).toEqual(["rgb(47, 139, 255)","rgb(47, 191, 113)"]);
});

it("reopening Audit refetches its first page",async()=>{
 renderShell();
 fireEvent.click(screen.getByRole("button",{name:"Audit log"}));
 await screen.findByText("Nothing has been changed from Omnikrux yet.");
 const calls=()=>vi.mocked(fetch).mock.calls.filter(([url])=>String(url).startsWith("/api/audit"));
 const first=calls().length;
 fireEvent.click(screen.getByRole("button",{name:"Settings"}));
 fireEvent.click(screen.getByRole("button",{name:"Audit log"}));
 await waitFor(()=>expect(calls().length).toBeGreaterThan(first));
 expect(String(calls().at(-1)![0])).not.toContain("before=");
});

it("shows a Home notice for malformed saved tabs",()=>{
 localStorage.setItem("omnikrux.workspace",JSON.stringify({version:1,kubernetes:{tabs:"bad"}})); renderShell();
 expect(screen.getByText(/Your saved tabs couldn't be read/)).toBeTruthy();
});
it.each(["Kinds","Kubernetes tabs"])("Alt history from %s moves exactly one entry in both directions",async (strip)=>{
 const ws=defaultWorkspace(); const tab=ws.kubernetes.tabs[0];
 const pods=kindView(HOME,"pods"); if(pods.page!=="kind") throw new Error("expected kind"); const filtered={...pods,filters:{...pods.filters,text:"needle"}};
 tab.view=filtered; tab.back=[HOME,pods]; localStorage.setItem("omnikrux.workspace",JSON.stringify(ws));
 renderShell(); await screen.findByRole("tablist",{name:"Kinds"});
 const target=within(screen.getByRole("tablist",{name:strip})).getByRole("tab",{selected:true}); target.focus();
 if (strip === "Kinds") fireEvent.keyDown(target, { key: "ArrowRight" });
 fireEvent.keyDown(document.activeElement!,{key:"ArrowLeft",code:"ArrowLeft",altKey:true});
 expect((screen.getByPlaceholderText(/filter/i) as HTMLInputElement).value).toBe("");
 fireEvent.keyDown(document.activeElement!,{key:"ArrowRight",code:"ArrowRight",altKey:true});
 expect((screen.getByPlaceholderText(/filter/i) as HTMLInputElement).value).toBe("needle");
 await new Promise(r=>setTimeout(r,300));
 expect(within(screen.getByRole("tablist",{name:"Kinds"})).getByRole("tab",{name:/Pods/,selected:true})).toBeTruthy();
});
it("browser Back and Forward cancel pending kind arrows for same-kind filter history",async()=>{
 const ws=defaultWorkspace();const tab=ws.kubernetes.tabs[0]; const pods=kindView(HOME,"pods");
 tab.view=pods;localStorage.setItem("omnikrux.workspace",JSON.stringify(ws));
 history.replaceState({omnikrux:0},"","/"); renderShell(); await screen.findByRole("tablist",{name:"Kinds"});
 fireEvent.change(screen.getByPlaceholderText(/filter/i),{target:{value:"needle"}});
 const arrow=()=>{const current=within(screen.getByRole("tablist",{name:"Kinds"})).getByRole("tab",{selected:true});current.focus();fireEvent.keyDown(current,{key:"ArrowRight"});};
 arrow();fireEvent(window,new PopStateEvent("popstate",{state:{omnikrux:0}})); await new Promise(r=>setTimeout(r,300));
 expect((screen.getByPlaceholderText(/filter/i) as HTMLInputElement).value).toBe("");
 expect(within(screen.getByRole("tablist",{name:"Kinds"})).getByRole("tab",{name:/Pods/,selected:true})).toBeTruthy();
 arrow();fireEvent(window,new PopStateEvent("popstate",{state:{omnikrux:1}}));await new Promise(r=>setTimeout(r,300));
 expect((screen.getByPlaceholderText(/filter/i) as HTMLInputElement).value).toBe("needle");
 expect(within(screen.getByRole("tablist",{name:"Kinds"})).getByRole("tab",{name:/Pods/,selected:true})).toBeTruthy();
});

it.each(["Kinds","Kubernetes tabs"])("modified navigation keys do not rove %s",async strip=>{
 const ws=defaultWorkspace(); ws.kubernetes.tabs[0].view=kindView(HOME,"pods"); localStorage.setItem("omnikrux.workspace",JSON.stringify(ws));
 renderShell(); await screen.findByRole("tablist",{name:"Kinds"}); const target=within(screen.getByRole("tablist",{name:strip})).getByRole("tab",{selected:true});target.focus();
 for(const key of ["ArrowLeft","ArrowRight","Home","End"]) {fireEvent.keyDown(target,{key,altKey:true,ctrlKey:true}); expect(document.activeElement).toBe(target);}
 await new Promise(r=>setTimeout(r,300));expect(document.activeElement).toBe(target);
});

const pods = ["api-first", "api-second"].map((name): ResourceRow => ({
  uid: name, cluster_id: "c1", kind: "Pod", namespace: "demo", name,
  created_at: null, labels: {}, columns: {},
}));
const describeResponse = () => new Response(JSON.stringify(describeBody({ containers: [container({ name: "app" })] })));
const logStream = (name: string) => FakeWebSocket.instances.find((socket) => socket.url.includes("/api/logs?") && socket.params.get("pod") === name)!;
const logTab = (name: string) => screen.findByRole("tab", { name: new RegExp(`Logs.*${name}`) });
const podRow = (name: string, root: HTMLElement = screen.getByRole("main")) =>
  within(root).getByRole("gridcell", { name }).closest<HTMLElement>("[data-row-key]")!;
async function renderPods(describePod: (url: string) => Promise<Response> = async () => describeResponse(), split = false) {
  for (const key of ["clientHeight", "offsetHeight", "clientWidth", "offsetWidth"] as const) {
    vi.spyOn(HTMLElement.prototype, key, "get").mockReturnValue(600);
  }
  stubClusters([east]);
  const fetch = vi.mocked(window.fetch).getMockImplementation()!;
  vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/describe") ? describePod(url) : fetch(url)));
  const ws = defaultWorkspace();
  const view = kindView(HOME, "pods");
  ws.kubernetes.tabs[0].view = view;
  if (split) {
    ws.kubernetes.tabs.push({ id: "other", view, back: [], forward: [], scrollTop: 0 });
  }
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws));
  renderShell();
  if (split) {
    const tabs = within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
    const peer = (await tabs.findAllByRole("tab", { name: /Pods/ }))[1];
    fireEvent.contextMenu(peer);
    fireEvent.click(screen.getByRole("menuitem", { name: "Split side by side" }));
  }
  const watches = await waitFor(() => {
    const sockets = FakeWebSocket.instances.filter((socket) => socket.params.get("kind") === "pods" && !socket.closedByClient);
    expect(sockets).toHaveLength(1);
    return sockets;
  });
  updatePods(watches, pods);
  await waitFor(() => expect(screen.getAllByRole("gridcell", { name: pods[0].name })).toHaveLength(split ? 2 : 1));
  return watches;
}
function updatePods(watches: FakeWebSocket[], rows: ResourceRow[]) {
  act(() => {
    for (const watch of watches) {
      watch.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
      watch.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows });
    }
  });
}
function startAtFirstPod() {
  const main = screen.getByRole("main");
  main.focus();
  fireEvent.keyDown(main, { key: "ArrowDown" });
  const first = podRow(pods[0].name);
  expect(document.activeElement).toBe(first);
  return first;
}

it("moves from a pod to its exact log tab and returns for the next ArrowDown", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  const firstTab = await logTab(pods[0].name);
  expect(document.activeElement).toBe(firstTab);
  fireEvent.keyDown(firstTab, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(first));
  expect(logStream(pods[0].name).closedByClient).toBe(true);
  fireEvent.keyDown(first, { key: "ArrowDown" });
  const second = podRow(pods[1].name);
  expect(document.activeElement).toBe(second);
  fireEvent.keyDown(second, { key: "l" });
  const secondTab = await logTab(pods[1].name);
  expect(document.activeElement).toBe(secondTab);
  fireEvent.keyDown(secondTab, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(second));
  expect(logStream(pods[1].name).closedByClient).toBe(false);
});

it("reopens the same Previous log by focusing its committed tab", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "p" });
  const previous = await screen.findByRole("tab", { name: /Logs Previous.*api-first/ });
  expect(document.activeElement).toBe(previous);
  fireEvent.keyDown(previous, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(first));
  const wrapper = previous.parentElement!;
  const strip = within(screen.getByRole("region", { name: "Logs and shells" })).getByRole("tablist");
  Object.defineProperty(strip, "clientHeight", { value: 102 });
  vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 34, 600, 102));
  vi.spyOn(wrapper, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 34));
  strip.scrollTop = 34;
  fireEvent.keyDown(first, { key: "p" });
  await waitFor(() => expect(document.activeElement).toBe(previous));
  expect(strip.scrollTop).toBe(0);
  expect(screen.getAllByRole("tab", { name: /Logs Previous/ })).toHaveLength(1);
});

it("opens a superseded describe in the background and keeps the newer tab focused", async () => {
  let finish!: (response: Response) => void;
  await renderPods((url) => url.includes(pods[0].name) ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(describeResponse()));
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  fireEvent.keyDown(first, { key: "ArrowDown" });
  fireEvent.keyDown(podRow(pods[1].name), { key: "l" });
  const secondTab = await logTab(pods[1].name);
  expect(document.activeElement).toBe(secondTab);
  await act(async () => finish(describeResponse()));
  await logTab(pods[0].name);
  expect(document.activeElement).toBe(secondTab);
});

it("drops the keyboard handoff if focus leaves and comes back during a slow describe", async () => {
  let finish!: (response: Response) => void;
  await renderPods(() => new Promise((resolve) => { finish = resolve; }));
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  screen.getByRole("main").focus();
  first.focus();
  await act(async () => finish(describeResponse()));
  await logTab(pods[0].name);
  expect(document.activeElement).toBe(first);
});

it("selects a keyboard-opened log behind another tab when focus moved away during a slow describe", async () => {
  let finish!: (response: Response) => void;
  await renderPods((url) => url.includes(pods[0].name) ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(describeResponse()));
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  const second = podRow(pods[1].name);
  fireEvent.keyDown(second, { key: "l" });
  const secondTab = await logTab(pods[1].name);
  fireEvent.keyDown(secondTab, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(second));
  fireEvent.keyDown(second, { key: "ArrowUp" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "l" });
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
  await act(async () => finish(describeResponse()));
  const firstTab = await logTab(pods[0].name);
  await waitFor(() => expect(firstTab.getAttribute("aria-selected")).toBe("true"));
  expect(secondTab.getAttribute("aria-selected")).toBe("false");
  expect(document.activeElement).toBe(second);
});

it("selects an already open log again on L when focus moved away before it resolved", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  const firstTab = await logTab(pods[0].name);
  fireEvent.keyDown(firstTab, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(first));
  fireEvent.keyDown(first, { key: "ArrowDown" });
  const second = podRow(pods[1].name);
  fireEvent.keyDown(second, { key: "l" });
  const secondTab = await logTab(pods[1].name);
  fireEvent.keyDown(secondTab, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(second));
  fireEvent.keyDown(second, { key: "ArrowUp" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "l" });
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
  await waitFor(() => expect(firstTab.getAttribute("aria-selected")).toBe("true"));
  expect(screen.getAllByRole("tab", { name: new RegExp(`Logs.*${pods[0].name}`) })).toHaveLength(1);
  expect(document.activeElement).toBe(second);
});

it("returns to the main view when the opening row is removed and another pod remains", async () => {
  const watches = await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  const tab = await logTab(pods[0].name);
  updatePods(watches, pods.slice(1));
  await waitFor(() => expect(first.isConnected).toBe(false));
  expect(podRow(pods[1].name).isConnected).toBe(true);
  fireEvent.keyDown(tab, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));
});

it("returns to the selected pod in the active split workspace", async () => {
  await renderPods(undefined, true);
  const [left, right] = Array.from(screen.getByRole("main").querySelectorAll<HTMLElement>("[data-active-pane]"));
  const leftFirst = podRow(pods[0].name, left);
  leftFirst.focus();
  fireEvent.keyDown(leftFirst, { key: "ArrowDown" });
  const rightFirst = podRow(pods[0].name, right);
  rightFirst.focus();
  fireEvent.keyDown(rightFirst, { key: "l" });
  const tab = await logTab(pods[0].name);
  expect(document.activeElement).toBe(tab);
  fireEvent.keyDown(tab, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(rightFirst));
  expect(podRow(pods[1].name, left).getAttribute("aria-selected")).toBe("true");
  expect(rightFirst.getAttribute("aria-selected")).toBe("true");
});

it.each(["Audit log", "Settings"])("leaves the shared dock for the active %s view", async (app) => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  const tab = await logTab(pods[0].name);
  fireEvent.click(screen.getByRole("button", { name: app }));
  const main = screen.getByRole("main");
  await waitFor(() => expect(document.activeElement).toBe(main));
  tab.focus();
  fireEvent.keyDown(tab, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(main));
  expect(logStream(pods[0].name).closedByClient).toBe(false);
});

it("lists the logs zone's back shortcuts in help", () => {
  renderShell();
  fireEvent.keyDown(document.body, { key: "?" });
  const help = within(screen.getByRole("dialog", { name: "All shortcuts" }));
  expect(help.getByText("Back to the table, same row (never closes a log)")).toBeTruthy();
  expect(help.getByText("Back to the table, from a log or a shell")).toBeTruthy();
});

it("does not close an open pod inspector on a repeated Escape after returning", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "Enter" });
  const inspector = screen.getByRole("region", { name: /^Details for/ });
  first.focus();
  fireEvent.keyDown(first, { key: "l" });
  const tab = await logTab(pods[0].name);
  expect(document.activeElement).toBe(tab);
  fireEvent.keyDown(tab, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(first));
  fireEvent.keyDown(first, { key: "Escape", repeat: true });
  expect(inspector.isConnected).toBe(true);
});

it("does not pull focus back from a workspace control after a deferred return", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  const tab = await logTab(pods[0].name);
  fireEvent.keyDown(tab, { key: "ArrowUp", altKey: true });
  const filter = screen.getByRole("textbox", { name: /Filter by name/ });
  filter.focus();
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(document.activeElement).toBe(filter);
});

it("existing settings route shows global cloud sections and retains pinned kinds and browser notices", async () => {
  const ws = defaultWorkspace();
  stubClusters([east, { ...east, id: 'c2', name: 'West' }]);
  ws.kubernetes.tabs[0].view = kindView(HOME, 'pods', ['c1']);
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws));
  localStorage.setItem("omnikrux.pinnedKinds", "invalid-json");
  history.replaceState(null, "", "/#/settings");
  renderShell();

  expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
  expect(location.hash).toBe("#/settings");
  const pins = screen.getByRole("region", { name: "Pinned kinds" });
  expect(pins.id).toBe("pinned-kinds");
  expect(within(pins).getByRole("button", { name: "Remove Pods" })).toBeTruthy();
  const browser = screen.getByRole("region", { name: "This browser" });
  expect(browser.id).toBe("this-browser");
  expect(within(browser).getByRole("alert").textContent).toContain("Your saved pinned kinds couldn't be read");
  expect(screen.getByRole("heading", { name: "Cloud accounts" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Clusters" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Encryption" })).toBeTruthy();
  expect(await screen.findByText("West")).toBeTruthy();
});

it("switching from a scoped split to Settings and back restores both panes and the active tab's history", async () => {
  const ws = defaultWorkspace();
  const tab = ws.kubernetes.tabs[0];
  const pods = kindView(HOME, "pods", ["c1"]);
  tab.view = kindView(pods, "deployments.apps");
  tab.back = [pods];
  ws.kubernetes.tabs.push({ id: "peer", view: HOME, back: [], forward: [], scrollTop: 0 });
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws));
  renderShell();

  const getTabs = () => within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
  const deploymentTab = { name: "Deployments · East", selected: true };
  await getTabs().findByRole("tab", deploymentTab);
  fireEvent.contextMenu(getTabs().getByRole("tab", { name: "Home" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Split side by side" }));
  expect(await screen.findByRole("region", { name: "Home" })).toBeTruthy();
  expect(await screen.findByRole("region", { name: "Deployments · East" })).toBeTruthy();
  const activeHash = location.hash;

  const rail = within(screen.getByRole("navigation", { name: "Apps" }));
  fireEvent.click(rail.getByRole("button", { name: "Settings" }));
  expect(await screen.findByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
  expect(location.hash).toBe("#/settings");
  expect(screen.queryByRole("region", { name: "Deployments · East" })).toBeNull();

  fireEvent.click(rail.getByRole("button", { name: "Kubernetes" }));
  expect(location.hash).toBe(activeHash);
  expect(getTabs().getByRole("tab", deploymentTab)).toBeTruthy();
  expect(getTabs().getAllByRole("tab")).toHaveLength(2);
  expect(screen.getByRole("region", { name: "Home" })).toBeTruthy();
  expect(await screen.findByRole("region", { name: "Deployments · East" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("region", { name: "Pods · East" })).toBeTruthy();
  expect(getTabs().getByRole("tab", { name: "Pods · East", selected: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Forward" }));
  expect(await screen.findByRole("region", { name: "Deployments · East" })).toBeTruthy();
});
