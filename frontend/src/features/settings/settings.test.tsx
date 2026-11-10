import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsView } from "./SettingsView";
import { KINDS } from "../../test/kinds";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const rows = () => within(screen.getByRole("list",{name:"Pinned kinds"})).getAllByRole("listitem");

it("settings adds, removes and reorders pinned kinds", () => {
  render(<SettingsView kinds={KINDS.kinds}/>);
  fireEvent.click(screen.getByRole("button",{name:"Remove Pods"}));
  expect(rows()[0].textContent).toContain("Deployments");
  fireEvent.click(screen.getByRole("button",{name:"Move Services up"}));
  expect(rows()[3].textContent).toContain("Services");
  fireEvent.click(screen.getByRole("button",{name:"Move Services down"}));
  expect(rows()[4].textContent).toContain("Services");
  const add = screen.getByRole("combobox",{name:"Add a kind"});
  fireEvent.change(add,{target:{value:"cert"}});
  fireEvent.keyDown(add,{key:"ArrowDown"}); fireEvent.keyDown(add,{key:"Enter"});
  expect(rows().at(-1)!.textContent).toContain("Certificates");
  expect(screen.queryByRole("option",{name:"Certificates"})).toBeNull();
});
it("reset to default restores the row", () => {
  render(<SettingsView kinds={KINDS.kinds}/>);
  fireEvent.click(screen.getByRole("button",{name:"Remove Secrets"}));
  fireEvent.click(screen.getByRole("button",{name:"Reset to default"}));
  expect(rows().map(r=>r.querySelector("strong")!.textContent)).toEqual(["Pods","Deployments","StatefulSets","DaemonSets","Jobs","Services","Ingresses","Secrets","Nodes","Events","Helm releases"]);
});
it("a pinned kind no cluster serves is marked in settings", () => {
  render(<SettingsView kinds={KINDS.kinds}/>);
  const secrets = rows().find(r=>r.textContent?.includes("Secrets"))!;
  expect(secrets.textContent).toContain("No cluster serves this kind right now, so its tab is hidden.");
});
it("an unavailable catalog kind keeps its discovered title in settings", () => {
  localStorage.setItem("omnikrux.pinnedKinds",JSON.stringify({version:1,kinds:["records.example.io"]}));
  render(<SettingsView kinds={[{...KINDS.kinds[0],key:"records.example.io",plural_label:"DNS records",clusters:[]}]}/>);
  expect(rows()[0].querySelector("strong")!.textContent).toBe("DNS records");
  expect(rows()[0].textContent).toContain("No cluster serves this kind right now, so its tab is hidden.");
});
it("empty pins explain the row and unmatched add searches explain the result", () => {
  localStorage.setItem("omnikrux.pinnedKinds",JSON.stringify({version:1,kinds:[]}));
  render(<SettingsView kinds={KINDS.kinds}/>);
  expect(screen.getByText("No pinned kinds: only the kind you open gets a tab.")).toBeTruthy();
  const add=screen.getByRole("combobox"); fireEvent.change(add,{target:{value:"nothing matches"}});
  expect(screen.getByText("No kind matches")).toBeTruthy();
});
it("a save problem is said in this browser and clears after a successful save", () => {
  const set=vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new DOMException("full","QuotaExceededError");});
  render(<SettingsView kinds={KINDS.kinds}/>);
  fireEvent.click(screen.getByRole("button",{name:"Remove Pods"}));
  expect(within(screen.getByRole("region",{name:"This browser"})).getByRole("alert").textContent).toBe("Tabs can't be saved in this browser (storage is full). They last until you close this page.");
  set.mockRestore(); fireEvent.click(screen.getByRole("button",{name:"Reset to default"}));
  expect(screen.queryByRole("alert")).toBeNull();
});
it("workspace save problems are also said in this browser", () => {
  render(<SettingsView kinds={KINDS.kinds} saveProblem="this browser blocks site storage"/>);
  expect(screen.getByRole("alert").textContent).toContain("this browser blocks site storage");
});
it("edit pinned kinds reaches the section without writing its anchor into the route", () => {
  const scroll=vi.fn(); Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:scroll});
  history.replaceState(null,"","/#/settings");
  render(<SettingsView kinds={KINDS.kinds} section="pinned-kinds"/>);
  expect(scroll).toHaveBeenCalled();
  expect(screen.getByRole("region",{name:"Pinned kinds"}).id).toBe("pinned-kinds");
  expect(location.hash).toBe("#/settings");
  delete (HTMLElement.prototype as {scrollIntoView?: unknown}).scrollIntoView;
});
