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
import { FOLLOW_SETTLE_MS } from "../dock/follow";
import type { MonitoringAppProps } from "../../monitoring/MonitoringApp";
// The dock tests' terminal: a helper textarea inside a .xterm root, as xterm draws it. Like xterm, it
// listens for keys on its textarea, asks the custom key handler first, and types what that allows;
// `xterm.stopsKeys` makes it stop the key there, as xterm (or an IME path) can.
const xterm = vi.hoisted(() => ({ stopsKeys: false, typed: [] as string[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    input = document.createElement("textarea");
    handler: ((e: KeyboardEvent) => boolean) | null = null;
    loadAddon() {}
    open(host: HTMLElement) {
      const root = document.createElement("div");
      root.className = "xterm";
      root.append(this.input);
      host.append(root);
      this.input.addEventListener("keydown", (e) => {
        if (xterm.stopsKeys) e.stopPropagation();
        if (this.handler?.(e) === false) return;
        xterm.typed.push(e.key);
      }, true);
    }
    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean) { this.handler = handler; }
    focus() { this.input.focus(); }
    write() {}
    reset() {}
    dispose() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
  },
}));
const rowRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../territories/ResourceRowView", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../territories/ResourceRowView")>();
  return { ...orig, ResourceRowView: (props: Parameters<typeof orig.ResourceRowView>[0]) => { rowRenders.count++; return orig.ResourceRowView(props); } };
});
// The Monitoring app as a probe: its heading, the tab's view, and two links that navigate the tab.
vi.mock("../../monitoring/MonitoringApp", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ nav }: MonitoringAppProps) => h("section", null,
      h("h1", null, "Monitoring"),
      h("p", { "data-testid": "monitoring-view" }, JSON.stringify(nav.view)),
      h("button", { type: "button", onClick: () => nav.navigate({ page: "project", id: "p1" }, "push") }, "Open project p1"),
      h("button", { type: "button", onClick: () => nav.navigate(() => ({ page: "group", id: "g1" }), "push") }, "Open group g1")),
  };
});
vi.mock("@xterm/addon-fit", () => ({FitAddon:class { fit() {} }}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
// The YAML editor as CodeMirror draws it: a contenteditable box.
vi.mock("../actions/lazyCodeMirror", () => ({
  EDITOR_UNAVAILABLE: "Couldn't load the editor. Reload the page.",
  loadCodeMirror: async () => ({
    mergeView: () => ({ destroy: () => {} }),
    editor: (parent: HTMLElement) => {
      const content = document.createElement("div");
      content.setAttribute("contenteditable", "true");
      content.tabIndex = 0;
      parent.append(content);
      return { focus: () => content.focus(), destroy: () => content.remove() };
    },
  }),
}));
const east: Cluster = {id:"c1",name:"East",provider:"aks",context_name:"x",server:"https://east",...FILE_CLUSTER_METADATA, original_server:null,region:null,environment:"development",state:"ready",message:null};
function stubClusters(clusters: Cluster[]) {
 vi.stubGlobal("fetch",vi.fn((url:string)=>Promise.resolve(new Response(JSON.stringify(url.startsWith("/api/kinds")?KINDS:url==="/api/clusters"?clusters:url.startsWith("/api/audit")?{records:[],next_before:null}:url==="/api/settings"?{encryption:{source:"environment",path:null},discovery_interval_s:600}:[]),{status:200,headers:{"content-type":"application/json"}}))));
}
beforeEach(()=>{
 xterm.stopsKeys = false;
 xterm.typed = [];
 FakeWebSocket.instances = [];
 vi.stubGlobal("WebSocket",FakeWebSocket);
 stubClusters([east]);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function renderShell(){return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Shell/></QueryClientProvider>);}
it("lists the built apps and marks the current app", () => {
  render(<Rail app="kubernetes" onSelect={() => {}} />);
  const nav = screen.getByRole("navigation", { name: "Apps" });
  expect(nav.querySelectorAll("button")).toHaveLength(4);
  expect(screen.getByRole("button", { name: "Kubernetes" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "Monitoring" }).getAttribute("aria-keyshortcuts")).toBe("Alt+2");
  expect(screen.getByRole("button", { name: "Audit log" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
});
// Shell's lazy Monitoring component loads once per test file: this test must be the first to show it.
it("the Monitoring view loads lazily", async () => {
  renderShell();
  fireEvent.keyDown(document.body, { key: "2", code: "Digit2", altKey: true });
  expect(screen.getByText("Loading Monitoring…")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Monitoring" })).toBeNull();
  expect(await screen.findByRole("heading", { name: "Monitoring" })).toBeTruthy();
  expect(screen.queryByText("Loading Monitoring…")).toBeNull();
});
const savedMonitoring = () => JSON.parse(localStorage.getItem("omnikrux.workspace") ?? "{}").monitoring as { tabs: { id: string }[]; active: string } | undefined;
const monitoringView = () => JSON.parse(screen.getByTestId("monitoring-view").textContent ?? "null");
it("Alt+2 opens Monitoring and Alt+1 returns to the same Kubernetes tab", async () => {
  renderShell();
  fireEvent.click(screen.getByRole("button", { name: "New tab" }));
  const kubeTabs = () => within(screen.getByRole("tablist", { name: "Kubernetes tabs" })).getAllByRole("tab");
  fireEvent.click(kubeTabs()[0]);
  expect(kubeTabs()[0].getAttribute("aria-selected")).toBe("true");
  const rail = screen.getByRole("button", { name: "Monitoring" });
  expect(rail.getAttribute("aria-keyshortcuts")).toBe("Alt+2");
  fireEvent.keyDown(document.body, { key: "2", code: "Digit2", altKey: true });
  expect(rail.getAttribute("aria-current")).toBe("page");
  await screen.findByRole("heading", { name: "Monitoring" });
  expect(screen.queryByRole("tablist", { name: "Kubernetes tabs" })).toBeNull();
  expect(location.hash).toMatch(/^#\/monitoring\/.+/);
  await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  fireEvent.keyDown(document.activeElement!, { key: "1", code: "Digit1", altKey: true });
  expect(screen.getByRole("button", { name: "Kubernetes" }).getAttribute("aria-current")).toBe("page");
  expect(kubeTabs()).toHaveLength(2);
  expect(kubeTabs()[0].getAttribute("aria-selected")).toBe("true");
  await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  expect(document.activeElement).not.toBeNull();
});
it("Alt+T and Alt+W manage Monitoring tabs while Monitoring is shown", async () => {
  renderShell();
  fireEvent.keyDown(document.body, { key: "2", code: "Digit2", altKey: true });
  await screen.findByRole("heading", { name: "Monitoring" });
  await waitFor(() => expect(savedMonitoring()?.tabs).toHaveLength(1));
  const first = savedMonitoring()!.active;
  fireEvent.keyDown(document.body, { key: "t", code: "KeyT", altKey: true });
  await waitFor(() => expect(savedMonitoring()?.tabs).toHaveLength(2));
  const second = savedMonitoring()!.active;
  expect(second).not.toBe(first);
  expect(location.hash).toBe(`#/monitoring/${second}`);
  fireEvent.keyDown(document.body, { key: "PageUp", code: "PageUp", altKey: true });
  await waitFor(() => expect(savedMonitoring()?.active).toBe(first));
  fireEvent.keyDown(document.body, { key: "PageDown", code: "PageDown", altKey: true });
  await waitFor(() => expect(savedMonitoring()?.active).toBe(second));
  fireEvent.keyDown(document.body, { key: "w", code: "KeyW", altKey: true });
  await waitFor(() => expect(savedMonitoring()?.tabs.map((t) => t.id)).toEqual([first]));
  expect(location.hash).toBe(`#/monitoring/${first}`);
  await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  fireEvent.keyDown(document.body, { key: "1", code: "Digit1", altKey: true });
  expect(within(screen.getByRole("tablist", { name: "Kubernetes tabs" })).getAllByRole("tab")).toHaveLength(1);
});
it("Back in Kubernetes is unaffected by Monitoring navigation", async () => {
  renderShell();
  fireEvent.click(await screen.findByRole("button", { name: /East/ }));
  expect(screen.queryByRole("heading", { name: "Where do you want to look?" })).toBeNull();
  fireEvent.keyDown(document.body, { key: "2", code: "Digit2", altKey: true });
  await screen.findByRole("heading", { name: "Monitoring" });
  const back = () => screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
  expect(back().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open project p1" }));
  fireEvent.click(screen.getByRole("button", { name: "Open group g1" }));
  expect(monitoringView()).toEqual({ page: "group", id: "g1" });
  expect(back().disabled).toBe(false);
  fireEvent.keyDown(document.body, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
  expect(monitoringView()).toEqual({ page: "project", id: "p1" });
  fireEvent.click(screen.getByRole("button", { name: "Forward" }));
  expect(monitoringView()).toEqual({ page: "group", id: "g1" });
  // The browser's Back while Monitoring is shown steps the Monitoring tab, never the Kubernetes one.
  act(() => { window.dispatchEvent(new PopStateEvent("popstate", { state: { omnikrux: history.state.omnikrux - 1 } })); });
  expect(monitoringView()).toEqual({ page: "project", id: "p1" });
  fireEvent.keyDown(document.body, { key: "1", code: "Digit1", altKey: true });
  expect(screen.queryByRole("heading", { name: "Where do you want to look?" })).toBeNull();
  expect(back().disabled).toBe(false);
  fireEvent.keyDown(document.body, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
  expect(screen.getByRole("heading", { name: "Where do you want to look?" })).toBeTruthy();
  expect(back().disabled).toBe(true);
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
 await screen.findByText("Nothing has been changed from OmniKrux yet.");
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
const logSockets = () => FakeWebSocket.instances.filter((socket) => socket.url.includes("/api/logs?"));
const logStream = (name: string) => logSockets().find((socket) => socket.params.get("pod") === name)!;
const logTab = (name: string) => screen.findByRole("tab", { name: new RegExp(`Logs.*${name}`) });
const podRow = (name: string, root: HTMLElement = screen.getByRole("main")) =>
  within(root).getByRole("gridcell", { name }).closest<HTMLElement>("[data-row-key]")!;
type Serve = (url: string, init?: RequestInit) => Promise<Response> | null;
async function renderPods(describePod: (url: string) => Promise<Response> = async () => describeResponse(), split = false, serve: Serve = () => null) {
  for (const key of ["clientHeight", "offsetHeight", "clientWidth", "offsetWidth"] as const) {
    vi.spyOn(HTMLElement.prototype, key, "get").mockReturnValue(600);
  }
  stubClusters([east]);
  const fetch = vi.mocked(window.fetch).getMockImplementation()!;
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => serve(url, init) ?? (url.includes("/describe") ? describePod(url) : fetch(url))));
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

it("L keeps the keyboard on the table and down retargets the follow log", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  const tab = await logTab(pods[0].name);
  expect(document.activeElement).toBe(first);
  expect(tab.getAttribute("aria-selected")).toBe("true");
  const firstStream = logStream(pods[0].name);
  expect(firstStream.closedByClient).toBe(false);

  fireEvent.keyDown(first, { key: "ArrowDown" });
  const second = podRow(pods[1].name);
  expect(document.activeElement).toBe(second);
  expect(second.getAttribute("aria-selected")).toBe("true");
  await waitFor(() => expect(logSockets().some((socket) => socket.params.get("pod") === pods[1].name)).toBe(true));
  // One follow tab, the same one, retargeted in place: the old stream is closed, the tab stays
  // selected, and the keyboard never left the table.
  expect(firstStream.closedByClient).toBe(true);
  expect(logStream(pods[1].name).closedByClient).toBe(false);
  expect(screen.getAllByRole("tab", { name: /Logs/ })).toEqual([tab]);
  expect(tab.getAttribute("aria-selected")).toBe("true");
  expect(await logTab(pods[1].name)).toBe(tab);
  expect(document.activeElement).toBe(second);

  // L again on the followed pod changes nothing; from the tab, Alt+Up comes back to the same row.
  fireEvent.keyDown(second, { key: "l" });
  expect(document.activeElement).toBe(second);
  tab.focus();
  fireEvent.keyDown(tab, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(second));
  expect(logStream(pods[1].name).closedByClient).toBe(false);
  expect(logSockets().filter((socket) => !socket.closedByClient)).toHaveLength(1);
});

it("holding down opens one stream after the selection settles", async () => {
  const watches = await renderPods();
  const many = Array.from({ length: 12 }, (_, i): ResourceRow => ({ ...pods[0], uid: `held-${i}`, name: `held-${String(i).padStart(2, "0")}` }));
  updatePods(watches, many);
  await waitFor(() => expect(screen.getAllByRole("gridcell", { name: "held-11" })).toHaveLength(1));
  const main = screen.getByRole("main");
  main.focus();
  fireEvent.keyDown(main, { key: "ArrowDown" });
  const start = document.activeElement as HTMLElement;
  fireEvent.keyDown(start, { key: "l" });
  await waitFor(() => expect(logSockets()).toHaveLength(1));
  const opened = logSockets()[0];

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    for (let i = 0; i < 8; i++) {
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      act(() => vi.advanceTimersByTime(30));
    }
    const eighth = (document.activeElement as HTMLElement).textContent ?? "";
    const target = many.find((p) => eighth.includes(p.name))!;
    expect(target.name).not.toBe(opened.params.get("pod"));
    act(() => vi.advanceTimersByTime(FOLLOW_SETTLE_MS - 31));
    expect(logSockets()).toHaveLength(1);
    expect(opened.closedByClient).toBe(false);
    for (let i = 0; i < 5; i++) await act(async () => vi.advanceTimersByTime(10));
    expect(logSockets()).toHaveLength(2);
    expect(logSockets()[1].params.get("pod")).toBe(target.name);
    expect(opened.closedByClient).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("p reopens the same previous log without moving focus", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "p" });
  const previous = await screen.findByRole("tab", { name: /Logs Previous.*api-first/ });
  expect(document.activeElement).toBe(first);
  previous.focus();
  fireEvent.keyDown(previous, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(first));
  fireEvent.keyDown(first, { key: "p" });
  await waitFor(() => expect(previous.getAttribute("aria-selected")).toBe("true"));
  expect(document.activeElement).toBe(first);
  expect(screen.getAllByRole("tab", { name: /Logs Previous/ })).toHaveLength(1);
});

const pin = { key: "L", shiftKey: true };

it("selects a pinned log behind another tab when focus moved away during a slow describe", async () => {
  let finish!: (response: Response) => void;
  await renderPods((url) => url.includes(pods[0].name) ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(describeResponse()));
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  const second = podRow(pods[1].name);
  fireEvent.keyDown(second, pin);
  const secondTab = await logTab(pods[1].name);
  fireEvent.keyDown(secondTab, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(second));
  fireEvent.keyDown(second, { key: "ArrowUp" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, pin);
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
  await act(async () => finish(describeResponse()));
  const firstTab = await logTab(pods[0].name);
  await waitFor(() => expect(firstTab.getAttribute("aria-selected")).toBe("true"));
  expect(secondTab.getAttribute("aria-selected")).toBe("false");
  expect(document.activeElement).toBe(second);
});

it("selects an already pinned log again on shift+L when focus moved away before it resolved", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, pin);
  const firstTab = await logTab(pods[0].name);
  fireEvent.keyDown(firstTab, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(first));
  fireEvent.keyDown(first, { key: "ArrowDown" });
  const second = podRow(pods[1].name);
  fireEvent.keyDown(second, pin);
  const secondTab = await logTab(pods[1].name);
  fireEvent.keyDown(secondTab, { key: "ArrowUp", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(second));
  fireEvent.keyDown(second, { key: "ArrowUp" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, pin);
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
  tab.focus();
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
  tab.focus();
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

const deletable = {
  ...KINDS,
  kinds: KINDS.kinds.map((k) => (k.key === "pods" ? { ...k, verbs: ["get", "list", "watch", "update", "delete"] } : k)),
};
function serveDeletes(): { serve: Serve; plans: () => unknown[] } {
  const plans: unknown[] = [];
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  const serve: Serve = (url, init) => {
    if (url.startsWith("/api/kinds")) return json(deletable);
    if (url.includes("/yaml")) return json({ yaml: "kind: Pod\n" });
    if (url === "/api/actions/plan" && init?.method === "POST") {
      const req = JSON.parse(String(init.body)) as { target: { name: string } };
      plans.push(req);
      return json({
        plan_id: "p1", action: "delete", target: req.target, kind: "Pod",
        cluster: { id: "c1", name: "East", provider: "aks", environment: "development" }, title: `Delete Pod ${req.target.name}`,
        summary: [`Delete Pod demo/${req.target.name}.`], warnings: [], blocked: [], diff: null, confirm_text: null,
        apply_label: "Delete", expires_at: "2026-11-16T10:05:00Z",
      });
    }
    if (url === "/api/actions/p1/apply") return json({ outcome: "succeeded", message: "Deleted.", job_id: null, audit_id: 1 });
    return null;
  };
  return { serve, plans: () => plans };
}
function press(el: Element, init: KeyboardEventInit = { key: "Delete", ctrlKey: true }) {
  const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

it.each(["connected", "Escape", "Cancel"] as const)("inspector Delete restores owned focus for %s", async close => {
  const { serve, plans } = serveDeletes();
  const watches = await renderPods(undefined, false, serve);
  await userEvent.click(podRow(pods[0].name));
  const inspector = await screen.findByRole("region", { name: "Details for " + pods[0].name });
  const opener = within(inspector).getByRole("button", { name: /^Delete\b/ });
  await userEvent.click(opener);
  const review = await screen.findByRole("dialog", { name: "Delete Pod " + pods[0].name });
  if (close === "connected") {
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement === opener).toBe(true));
    return;
  }
  updatePods(watches, [pods[1]]);
  await waitFor(() => expect(opener.isConnected).toBe(false));
  expect(review.contains(document.activeElement)).toBe(true);
  if (close === "Escape") await userEvent.keyboard("{Escape}");
  else await userEvent.click(within(review).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement === podRow(pods[1].name)).toBe(true));
  updatePods(watches, [{ ...pods[0], uid: "replacement" }, pods[1]]);
  await waitFor(() => expect(podRow(pods[0].name).getAttribute("aria-selected")).toBe("false"));
  expect(screen.queryByRole("region", { name: /^Details for/ })).toBeNull();
  expect(plans()).toHaveLength(1);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/apply"))).toBe(false);
});
it.each(["Escape", "Cancel"] as const)("a same-name replacement that arrives during an inspector Delete review is never selected (%s)", async close => {
  const { serve, plans } = serveDeletes();
  const watches = await renderPods(undefined, false, serve);
  await userEvent.click(podRow(pods[0].name));
  const inspector = await screen.findByRole("region", { name: "Details for " + pods[0].name });
  await userEvent.click(within(inspector).getByRole("button", { name: /^Delete\b/ }));
  const review = await screen.findByRole("dialog", { name: "Delete Pod " + pods[0].name });
  // The Pod goes and its same-name replacement arrives while the review is still open.
  updatePods(watches, [pods[1]]);
  await waitFor(() => expect(screen.queryByRole("region", { name: /^Details for/ })).toBeNull());
  updatePods(watches, [{ ...pods[0], uid: "replacement" }, pods[1]]);
  await waitFor(() => expect(podRow(pods[0].name)).toBeTruthy());
  expect(review.contains(document.activeElement)).toBe(true);
  if (close === "Escape") await userEvent.keyboard("{Escape}");
  else await userEvent.click(within(review).getByRole("button", { name: "Cancel" }));
  const grid = podRow(pods[1].name).closest('[role="grid"]')!;
  await waitFor(() => expect(grid.contains(document.activeElement) && document.activeElement?.hasAttribute("data-row-key")).toBe(true));
  expect(podRow(pods[0].name).getAttribute("aria-selected")).toBe("false");
  expect(screen.queryByRole("region", { name: /^Details for/ })).toBeNull();
  expect(plans()).toHaveLength(1);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/apply"))).toBe(false);
});
it("after a ctrl+delete removal focus is on a row, not the body", async () => {
  const { serve, plans } = serveDeletes();
  const three = [...pods, { ...pods[1], uid: "api-third", name: "api-third" }];
  const watches = await renderPods(undefined, false, serve);
  updatePods(watches, three);
  await screen.findByRole("gridcell", { name: "api-third" });
  const first = startAtFirstPod();
  expect(press(first).defaultPrevented).toBe(true);
  const review = await screen.findByRole("dialog", { name: `Delete Pod ${pods[0].name}` });
  expect(plans()).toEqual([expect.objectContaining({ action: "delete", params: { expected_uid: pods[0].uid } })]);
  fireEvent.click(within(review).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: `Delete Pod ${pods[0].name}` })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(first));
  // The watch then says the pod is gone.
  updatePods(watches, three.slice(1));
  await waitFor(() => expect(first.isConnected).toBe(false));
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement).toBe(podRow(pods[1].name));
});

it("ctrl+delete never acts from a field, a kind tab or a dialog", async () => {
  const { serve, plans } = serveDeletes();
  await renderPods(undefined, false, serve);
  const first = startAtFirstPod();
  const details = () => screen.queryByRole("region", { name: /^Details for/ });
  const nothing = async () => {
    await act(async () => {});
    expect(plans()).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: /^Delete Pod/ })).toBeNull();
  };

  // The filter: Ctrl+Delete and Ctrl+Backspace edit the text, as they always do.
  const filter = screen.getByRole("textbox", { name: /Filter by name/ });
  filter.focus();
  expect(press(filter).defaultPrevented).toBe(false);
  expect(press(filter, { key: "Backspace", ctrlKey: true }).defaultPrevented).toBe(false);
  expect(press(filter, { key: "Backspace", metaKey: true }).defaultPrevented).toBe(false);
  await nothing();
  expect(details()).toBeNull();

  // The selected kind tab.
  const kindTab = within(screen.getByRole("tablist", { name: "Kinds" })).getByRole("tab", { selected: true });
  kindTab.focus();
  expect(press(kindTab).defaultPrevented).toBe(false);
  await nothing();
  expect(details()).toBeNull();

  // The "?" sheet's Close button.
  first.focus();
  fireEvent.keyDown(first, { key: "?" });
  const sheet = screen.getByRole("dialog", { name: "All shortcuts" });
  const close = within(sheet).getByRole("button", { name: /Close/ });
  expect(document.activeElement).toBe(close);
  press(close);
  await nothing();
  expect(details()).toBeNull();
  fireEvent.keyDown(close, { key: "Escape" });

  // The palette's input.
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "k", ctrlKey: true });
  const input = within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox");
  expect(document.activeElement).toBe(input);
  expect(press(input).defaultPrevented).toBe(false);
  await nothing();
  expect(details()).toBeNull();
  fireEvent.keyDown(input, { key: "Escape" });

  // The YAML editor.
  const row = podRow(pods[0].name);
  row.focus();
  fireEvent.keyDown(row, { key: "e" });
  const editor = await waitFor(() => {
    const box = details()?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!box) throw new Error("Waiting for the editor");
    return box;
  });
  await waitFor(() => expect(document.activeElement).toBe(editor));
  expect(press(editor).defaultPrevented).toBe(false);
  expect(press(editor, { key: "Backspace", metaKey: true }).defaultPrevented).toBe(false);
  await nothing();
  expect(editor.isConnected).toBe(true);
});

it("lists the dock's close and return shortcuts in help", () => {
  renderShell();
  fireEvent.keyDown(document.body, { key: "?" });
  const help = within(screen.getByRole("dialog", { name: "All shortcuts" }));
  expect(help.getByText("Back to the table, same row (never closes a log)")).toBeTruthy();
  expect(help.getByText("Back to the table, from a log or a shell")).toBeTruthy();
  expect(help.getByText("Delete what has the focus: a resource row (reviewed first) or a dock tab")).toBeTruthy();
});

const terminalOf = () => document.querySelector<HTMLTextAreaElement>(".xterm textarea");

it("S still opens a shell that takes the keyboard", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "s" });
  const tab = await screen.findByRole("tab", { name: new RegExp(`^Shell.*${pods[0].name}`) });
  expect(tab.getAttribute("aria-selected")).toBe("true");
  await waitFor(() => expect(document.activeElement).toBe(terminalOf()));
});

it("alt+up from a shell returns to the table", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "s" });
  await waitFor(() => expect(document.activeElement).toBe(terminalOf()));
  const terminal = terminalOf()!;
  // Esc is the terminal's (vim, less).
  expect(fireEvent.keyDown(terminal, { key: "Escape" })).toBe(true);
  expect(document.activeElement).toBe(terminal);
  expect(fireEvent.keyDown(terminal, { key: "ArrowUp", altKey: true })).toBe(false);
  await waitFor(() => expect(document.activeElement).toBe(first));
  expect(screen.getByRole("tab", { name: new RegExp(`^Shell.*${pods[0].name}`) })).toBeTruthy();
});

it("in a shell the bar says alt up goes back to the table", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "s" });
  await waitFor(() => expect(document.activeElement).toBe(terminalOf()));
  const strip = await screen.findByRole("navigation", { name: "Keyboard shortcuts: shell" });
  expect(within(strip).getAllByRole("listitem")[0].textContent).toBe("Alt ↑ back to the table");
  expect(strip.textContent).not.toContain("Esc");
  expect(zoneDock().getAttribute("data-keyboard-zone")).toBe("logs");
  fireEvent.keyDown(terminalOf()!, { key: "ArrowUp", altKey: true });
  await screen.findByRole("navigation", { name: "Keyboard shortcuts: table" });
  expect(screen.queryByRole("navigation", { name: "Keyboard shortcuts: shell" })).toBeNull();
});

it("alt+up leaves a terminal that stops the key on its textarea, at once and unsent", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "s" });
  await waitFor(() => expect(document.activeElement).toBe(terminalOf()));
  const terminal = terminalOf()!;
  xterm.stopsKeys = true;
  // Typed keys are the shell's.
  fireEvent.keyDown(terminal, { key: "a" });
  expect(xterm.typed).toEqual(["a"]);
  expect(fireEvent.keyDown(terminal, { key: "ArrowUp", altKey: true })).toBe(false);
  // Same tick: no frame to wait for, so nothing can take the focus first.
  expect(document.activeElement).toBe(first);
  expect(xterm.typed).toEqual(["a"]);
  // Held, it leaves once and still sends nothing.
  act(() => terminal.focus());
  expect(fireEvent.keyDown(terminal, { key: "ArrowUp", altKey: true, repeat: true })).toBe(false);
  expect(document.activeElement).toBe(terminal);
  expect(xterm.typed).toEqual(["a"]);
});

it("alt+down from a row moves into the follow log and esc comes back", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  await logTab(pods[0].name);
  expect(document.activeElement).toBe(first);
  expect(fireEvent.keyDown(first, { key: "ArrowDown", altKey: true })).toBe(false);
  const log = screen.getByRole("log");
  expect(document.activeElement).toBe(log);
  expect(first.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(log, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(first));
  expect(screen.getAllByRole("tab", { name: /Logs/ })).toHaveLength(1);
  expect(logStream(pods[0].name).closedByClient).toBe(false);
});

it("alt+down works from the audit log too, and says so with nothing open", async () => {
  renderShell();
  fireEvent.click(screen.getByRole("button", { name: "Audit log" }));
  const main = screen.getByRole("main");
  await waitFor(() => expect(document.activeElement).toBe(main));
  expect(fireEvent.keyDown(main, { key: "ArrowDown", altKey: true })).toBe(false);
  expect(screen.getByText("No logs open yet: press L on a pod first.")).toBeTruthy();
  expect(document.activeElement).toBe(main);
});

it("moving to a deployment keeps the last pod and says so", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  await logTab(pods[0].name);
  const main = screen.getByRole("main");
  main.focus();
  fireEvent.keyDown(main, { key: "ArrowRight" });
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
  await screen.findByRole("gridcell", { name: "api" });
  main.focus();
  fireEvent.keyDown(main, { key: "ArrowDown" });
  await new Promise((resolve) => setTimeout(resolve, FOLLOW_SETTLE_MS));
  const pane = screen.getByRole("region", { name: `Logs for ${pods[0].name}` });
  await waitFor(() => expect(within(pane).getByRole("status").textContent)
    .toBe(`Still showing ${pods[0].name}: the selected row isn't a pod.`));
  expect(logStream(pods[0].name).closedByClient).toBe(false);
});

it("does not close an open pod inspector on a repeated Escape after returning", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "Enter" });
  const inspector = screen.getByRole("region", { name: /^Details for/ });
  first.focus();
  fireEvent.keyDown(first, { key: "l" });
  const tab = await logTab(pods[0].name);
  tab.focus();
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
  expect(within(pins).getByRole("button", { name: "Actions for Pods" })).toBeTruthy();
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

const zonePane = () => document.querySelector('[data-active-pane="true"]')!;
const zoneDock = () => document.querySelector("[data-dock]")!;

it("the lilac outline moves with the keyboard", async () => {
  await renderPods();
  expect(zonePane().getAttribute("data-keyboard-zone")).toBe("table");
  expect(zoneDock().hasAttribute("data-keyboard-zone")).toBe(false);
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  await logTab(pods[0].name);
  fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
  await waitFor(() => expect(zoneDock().getAttribute("data-keyboard-zone")).toBe("logs"));
  expect(zonePane().hasAttribute("data-keyboard-zone")).toBe(false);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(zonePane().getAttribute("data-keyboard-zone")).toBe("table"));
  expect(zoneDock().hasAttribute("data-keyboard-zone")).toBe(false);
  fireEvent.keyDown(document.activeElement!, { key: "/" });
  const filter = within(screen.getByRole("group", { name: "Filter rows" })).getByRole("textbox") as HTMLInputElement;
  filter.focus();
  await waitFor(() => expect(zonePane().hasAttribute("data-keyboard-zone")).toBe(false));
  expect(zoneDock().hasAttribute("data-keyboard-zone")).toBe(false);
});

it("a Home tab's pane has no keyboard zone outline", async () => {
  renderShell();
  expect(screen.getByRole("heading", { name: "Where do you want to look?" })).toBeTruthy();
  const main = screen.getByRole("main");
  main.focus();
  expect(document.activeElement).toBe(main);
  await act(async () => { await Promise.resolve(); });
  expect(zonePane().hasAttribute("data-keyboard-zone")).toBe(false);
});

it("the logs bar shows outside kubernetes too", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  await logTab(pods[0].name);
  expect(screen.getByRole("navigation", { name: "Keyboard shortcuts: table" })).toBeTruthy();
  fireEvent.keyDown(first, { key: "8", code: "Digit8", altKey: true });
  await screen.findByRole("heading", { name: "Audit log" });
  expect(screen.queryByRole("navigation", { name: /^Keyboard shortcuts/ })).toBeNull();
  const main = screen.getByRole("main");
  main.focus();
  expect(document.activeElement).toBe(main);
  fireEvent.keyDown(main, { key: "ArrowDown", altKey: true });
  const strip = await screen.findByRole("navigation", { name: "Keyboard shortcuts: logs" });
  expect(strip.textContent).toContain("back to the table");
  expect(screen.queryByRole("navigation", { name: "Keyboard shortcuts: table" })).toBeNull();
});

it("no element carries the outline while a dialog or the ? sheet is open", async () => {
  const { serve } = serveDeletes();
  await renderPods(undefined, false, serve);
  const first = startAtFirstPod();
  await waitFor(() => expect(zonePane().getAttribute("data-keyboard-zone")).toBe("table"));
  press(first);
  await screen.findByRole("dialog", { name: `Delete Pod ${pods[0].name}` });
  await waitFor(() => expect(document.querySelector("[data-keyboard-zone]")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(zonePane().getAttribute("data-keyboard-zone")).toBe("table"));
  fireEvent.keyDown(document.activeElement!, { key: "?" });
  await screen.findByRole("dialog", { name: "All shortcuts" });
  await waitFor(() => expect(document.querySelector("[data-keyboard-zone]")).toBeNull());
});

it("a zone change does not re-render the table rows", async () => {
  await renderPods();
  const first = startAtFirstPod();
  fireEvent.keyDown(first, { key: "l" });
  await logTab(pods[0].name);
  await waitFor(() => expect(zonePane().getAttribute("data-keyboard-zone")).toBe("table"));
  await act(async () => { await new Promise((r) => setTimeout(r, FOLLOW_SETTLE_MS + 50)); });
  const before = rowRenders.count;
  expect(before).toBeGreaterThan(0);
  fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
  await waitFor(() => expect(zoneDock().getAttribute("data-keyboard-zone")).toBe("logs"));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(zonePane().getAttribute("data-keyboard-zone")).toBe("table"));
  expect(rowRenders.count).toBe(before);
});

it.each([{ key: "Escape" }, { key: "ArrowUp", altKey: true }])("$key from logs reveals and focuses the selected virtualized row", async (keys) => {
  const watches = await renderPods();
  const many = Array.from({ length: 10000 }, (_, i) => ({ ...pods[0], uid: "z" + i, name: "z" + i }));
  updatePods(watches, [...pods, ...many]);
  const first = startAtFirstPod();
  const targetKey = first.dataset.rowKey;
  fireEvent.keyDown(first, { key: "l" });
  const tab = await logTab(pods[0].name);
  tab.focus();
  const grid = first.closest<HTMLElement>('[role="grid"]')!;
  const viewport = grid.parentElement!;
  Object.defineProperty(viewport, "scrollHeight", { value: 360200 });
  let requested: number | undefined;
  viewport.scrollTo = ((opts: ScrollToOptions) => { requested = opts.top; }) as typeof viewport.scrollTo;
  fireEvent.scroll(viewport, { target: { scrollTop: 36000 } });
  expect(first.isConnected).toBe(false);
  expect(grid.querySelectorAll("[data-row-key]").length).toBeLessThan(60);
  fireEvent.keyDown(tab, keys);
  expect(requested).toBeDefined();
  fireEvent.scroll(viewport, { target: { scrollTop: requested } });
  await waitFor(() => expect(document.activeElement).toBe(podRow(pods[0].name)));
  expect((document.activeElement as HTMLElement).dataset.rowKey).toBe(targetKey);
  expect(viewport.scrollTop).toBeLessThan(100);
  expect(grid.querySelectorAll("[data-row-key]").length).toBeLessThan(60);
  expect(await logTab(pods[0].name)).toBe(tab);
  expect(logStream(pods[0].name).closedByClient).toBe(false);
});

it("closing the final focused log keeps an offscreen selection outside the deferred return", async () => {
  const watches = await renderPods();
  updatePods(watches, [...pods, ...Array.from({ length: 200 }, (_, i) => ({ ...pods[0], uid: "z" + i, name: "z" + i }))]);
  const selected = startAtFirstPod();
  fireEvent.keyDown(selected, { key: "l" });
  const tab = await logTab(pods[0].name);
  tab.focus();
  const viewport = selected.closest<HTMLElement>('[role="grid"]')!.parentElement!;
  Object.defineProperty(viewport, "scrollHeight", { value: 8000 });
  fireEvent.scroll(viewport, { target: { scrollTop: 3600 } });
  expect(selected.isConnected).toBe(false);
  const scroll = vi.fn();
  viewport.scrollTo = scroll;
  const frames: FrameRequestCallback[] = [];
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => frames.push(callback));
  try {
    press(tab);
    expect(tab.isConnected).toBe(false);
    expect(frames.length).toBeGreaterThan(0);
    const field = screen.getByRole("textbox", { name: /Filter by name/ });
    field.focus();
    field.blur();
    act(() => frames.splice(0).forEach(callback => callback(performance.now())));
    expect(scroll).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(viewport.scrollTop).toBe(3600);
  } finally {
    raf.mockRestore();
  }
});
