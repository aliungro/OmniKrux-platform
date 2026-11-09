import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Rail } from "./Rail";
import { Shell } from "./Shell";
vi.mock("@xterm/xterm", () => ({Terminal:class {}}));
vi.mock("@xterm/addon-fit", () => ({FitAddon:class {}}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
beforeEach(()=>{vi.stubGlobal("fetch",vi.fn((url:string)=>Promise.resolve(new Response(JSON.stringify(url.startsWith("/api/kinds")?{kinds:[],clusters:{}}:url.startsWith("/api/audit")?{records:[],next_before:null}:[]),{status:200,headers:{"content-type":"application/json"}}))));});
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
