import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsView } from "./SettingsView";
import { KINDS } from "../../test/kinds";
import { PINNED_KEY, resetPinnedKinds, savePinned } from "./pinnedKinds";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const rows = () => within(screen.getByRole("list",{name:"Pinned kinds"})).getAllByRole("listitem");
const rowOrder = () => rows().map(row => row.querySelector("strong")!.textContent);
function pointAt(target: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", clientY = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return fireEvent(target, event);
}
function hitTest() {
  const before = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  const hit = vi.fn();
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
  return { hit, restore: () => {
    if (before) Object.defineProperty(document, "elementFromPoint", before);
    else Reflect.deleteProperty(document, "elementFromPoint");
  } };
}

it("settings adds, removes and reorders pinned kinds", () => {
  render(<SettingsView kinds={KINDS.kinds}/>);
  fireEvent.click(screen.getByRole("button",{name:"Remove Pods"}));
  expect(rows()[0].textContent).toContain("Deployments");
  fireEvent.click(screen.getByRole("button",{name:"Move Services up"}));
  expect(rows()[3].textContent).toContain("Services");
  expect(screen.getByRole("status").textContent).toBe("Services moved to position 4 of 10.");
  fireEvent.click(screen.getByRole("button",{name:"Move Services down"}));
  expect(rows()[4].textContent).toContain("Services");
  expect(screen.getByRole("status").textContent).toBe("Services moved to position 5 of 10.");
  const add = screen.getByRole("combobox",{name:"Add a kind"});
  fireEvent.change(add,{target:{value:"cert"}});
  fireEvent.keyDown(add,{key:"ArrowDown"}); fireEvent.keyDown(add,{key:"Enter"});
  expect(rows().at(-1)!.textContent).toContain("Certificates");
  expect(screen.queryByRole("option",{name:"Certificates"})).toBeNull();
});
it("drops a dragged pin on either half of another row, persists it, and announces its position", () => {
  savePinned(localStorage, ["pods", "deployments.apps", "services", "secrets"]);
  const save = vi.spyOn(Storage.prototype, "setItem");
  const view = render(<SettingsView kinds={KINDS.kinds} />);
  const handle = screen.getByTitle("Drag Secrets to reorder");
  const pods = rows()[0], services = rows()[2];
  for (const target of [pods, services]) {
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 100, height: 40 } as DOMRect);
  }

  const { hit, restore } = hitTest();
  hit.mockReturnValue(pods);
  pointAt(handle, "pointerdown");
  pointAt(handle, "pointermove", 110);
  expect(pods.getAttribute("data-drop-placement")).toBe("before");
  expect(save).not.toHaveBeenCalled();
  pointAt(handle, "pointerup", 110);
  expect(rowOrder()).toEqual(["Secrets", "Pods", "Deployments", "Services"]);
  expect(pods.getAttribute("data-drop-placement")).toBeNull();
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toBe("Secrets moved to position 1 of 4.");

  hit.mockReturnValue(services);
  pointAt(handle, "pointerdown");
  pointAt(handle, "pointermove", 135);
  expect(services.getAttribute("data-drop-placement")).toBe("after");
  pointAt(handle, "pointerup", 135);
  restore();
  expect(rowOrder()).toEqual(["Pods", "Deployments", "Services", "Secrets"]);
  expect(save).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status").textContent).toBe("Secrets moved to position 4 of 4.");
  expect(JSON.parse(localStorage.getItem(PINNED_KEY)!).kinds).toEqual(["pods", "deployments.apps", "services", "secrets"]);

  view.unmount();
  resetPinnedKinds();
  render(<SettingsView kinds={KINDS.kinds} />);
  expect(rowOrder()).toEqual(["Pods", "Deployments", "Services", "Secrets"]);
});

it("clears cancelled drags and ignores drags that did not start on a handle", () => {
  const save = vi.spyOn(Storage.prototype, "setItem");
  render(<SettingsView kinds={KINDS.kinds} />);
  const initial = rowOrder();
  const pods = rows()[0], secrets = rows()[7];
  const handle = screen.getByTitle("Drag Secrets to reorder");
  const { hit, restore } = hitTest();
  hit.mockReturnValue(pods);
  pointAt(secrets, "pointerdown");
  pointAt(handle, "pointermove");
  expect(pods.getAttribute("data-drop-placement")).toBeNull();
  pointAt(handle, "pointerup");

  pointAt(handle, "pointerdown");
  pointAt(handle, "pointermove");
  expect(pods.getAttribute("data-drop-placement")).not.toBeNull();
  pointAt(handle, "pointercancel");
  expect(pods.getAttribute("data-drop-placement")).toBeNull();
  pointAt(handle, "pointerup");
  restore();
  expect(rowOrder()).toEqual(initial);
  expect(save).not.toHaveBeenCalled();
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
  expect(within(screen.getByRole("region",{name:"This browser"})).getByRole("alert").textContent).toBe("Pinned kinds can't be saved in this browser (storage is full). Your changes last until you close this page.");
  set.mockRestore(); fireEvent.click(screen.getByRole("button",{name:"Reset to default"}));
  expect(screen.queryByRole("alert")).toBeNull();
});
it("workspace save problems are also said in this browser", () => {
  render(<SettingsView kinds={KINDS.kinds} saveProblem="this browser blocks site storage"/>);
  expect(screen.getByRole("alert").textContent).toContain("this browser blocks site storage");
});
it("workspace and pinned save failures remain independently visible in Settings", () => {
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  const view = render(<SettingsView kinds={KINDS.kinds} saveProblem="this browser blocks site storage"/>);
  fireEvent.click(screen.getByRole("button", { name: "Remove Pods" }));
  expect(screen.getAllByRole("alert").map(el => el.textContent)).toEqual([
    "Tabs can't be saved in this browser (this browser blocks site storage). They last until you close this page.",
    "Pinned kinds can't be saved in this browser (storage is full). Your changes last until you close this page.",
  ]);
  view.rerender(<SettingsView kinds={KINDS.kinds}/>);
  expect(screen.getByRole("alert").textContent).toContain("Pinned kinds can't be saved");
  set.mockRestore(); fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  expect(screen.queryByRole("alert")).toBeNull();
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

it.each([
  ["broken", "they aren't valid JSON"],
  ['{"version":2,"kinds":["pods"]}', "they're from another version of Omnikrux"],
  ['{"version":1,"kinds":["bad/key"]}', "the saved list contains an invalid kind"],
])("unreadable pinned storage explains its own reset once: %s", (raw, reason) => {
  localStorage.setItem("omnikrux.pinnedKinds",raw);
  const view=render(<SettingsView kinds={KINDS.kinds}/>);
  expect(rows()[0].querySelector("strong")!.textContent).toBe("Pods");
  expect(screen.getByRole("alert").textContent).toContain(`Your saved pinned kinds couldn't be read (${reason}), so Omnikrux restored the default pinned kinds.`);
  fireEvent.click(screen.getByRole("button",{name:"Remove Services"}));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button",{name:"Dismiss pinned kinds notice"}));
  view.unmount(); render(<SettingsView kinds={KINDS.kinds}/>);
  expect(screen.queryByRole("alert")).toBeNull();
});
it("a blocked pinned storage read explains the fallback separately from tabs", () => {
  vi.spyOn(Storage.prototype,"getItem").mockImplementation(()=>{throw new DOMException("blocked","SecurityError");});
  render(<SettingsView kinds={KINDS.kinds}/>);
  expect(screen.getByRole("alert").textContent).toContain("Your saved pinned kinds couldn't be read (this browser blocks site storage)");
  expect(screen.getByRole("alert").textContent).not.toContain("fresh Home tab");
});
it("keyboard removal follows the next row, previous row, then add field", async () => {
  localStorage.setItem("omnikrux.pinnedKinds",JSON.stringify({version:1,kinds:["pods","services","nodes"]}));
  const user=userEvent.setup(); render(<SettingsView kinds={KINDS.kinds}/>);
  screen.getByRole("button",{name:"Remove Services"}).focus(); await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("button",{name:"Remove Nodes"}));
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("button",{name:"Remove Pods"}));
  await user.keyboard("{Enter}");
  expect(document.activeElement).toBe(screen.getByRole("combobox",{name:"Add a kind"}));
});
it("the picker scrolls the keyboard active option into view", () => {
  const scrolled: Element[]=[];
  Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:function(this:Element) {scrolled.push(this);}});
  try {
    const kinds=Array.from({length:30},(_,i)=>({...KINDS.kinds[0],key:`item-${i}`,plural_label:`Kind ${String(i).padStart(2,"0")}`}));
    render(<SettingsView kinds={kinds}/>);
    const add=screen.getByRole("combobox"); fireEvent.focus(add);
    for(let i=0;i<20;i++) fireEvent.keyDown(add,{key:"ArrowDown"});
    expect(scrolled.at(-1)).toBe(document.getElementById(add.getAttribute("aria-activedescendant")!));
  } finally { delete (HTMLElement.prototype as {scrollIntoView?: unknown}).scrollIntoView; }
});
