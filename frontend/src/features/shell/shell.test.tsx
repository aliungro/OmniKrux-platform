import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Rail } from "./Rail";
import { Shell } from "./Shell";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { HOME, kindView, defaultWorkspace } from "./workspace";
import { KINDS } from "../../test/kinds";
import type { Cluster } from "../../api/types";
import { FakeWebSocket } from "../logs/fakeWebSocket";
vi.mock("@xterm/xterm", () => ({Terminal:class {}}));
vi.mock("@xterm/addon-fit", () => ({FitAddon:class {}}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
const east: Cluster = {id:"c1",name:"East",provider:"aks",context_name:"x",server:"https://east",original_server:null,region:null,environment:"development",state:"ready",message:null};
function stubClusters(clusters: Cluster[]) {
 vi.stubGlobal("fetch",vi.fn((url:string)=>Promise.resolve(new Response(JSON.stringify(url.startsWith("/api/kinds")?KINDS:url==="/api/clusters"?clusters:url.startsWith("/api/audit")?{records:[],next_before:null}:[]),{status:200,headers:{"content-type":"application/json"}}))));
}
beforeEach(()=>{
 vi.stubGlobal("WebSocket",FakeWebSocket);
 stubClusters([east]);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
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

it("labels scoped tabs and renders the provider-colour stripes",()=>{
 const clusters:Cluster[]=[{id:"one",name:"East",provider:"aks",context_name:"x",server:"x",original_server:null,region:null,environment:"development",state:"ready",message:null},{id:"two",name:"West",provider:"gke",context_name:"y",server:"y",original_server:null,region:null,environment:"development",state:"ready",message:null}];
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
 fireEvent.keyDown(target,{key:"ArrowLeft",code:"ArrowLeft",altKey:true});
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
