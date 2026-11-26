import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Shell } from "../features/shell/Shell";
import { defaultWorkspace } from "../features/shell/workspace";
import { KINDS } from "../test/kinds";
import { installFakeMonitoringApi } from "./test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "./test/renderMonitoringApp";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const tablist = () => screen.getByRole("tablist", { name: "Monitoring tabs" });
const tabs = () => within(tablist()).getAllByRole("tab");

describe("Monitoring app shell", () => {
  it("the New dashboard bar is live; with no project it asks for one first", async () => {
    installFakeMonitoringApi();
    renderMonitoringApp();
    const create = screen.getByRole("button", { name: "New dashboard" });
    expect(await screen.findByText("Set up a project first.")).toBeTruthy();
    expect(create.getAttribute("aria-disabled")).toBe("true");
    const importButton = screen.getByRole("button", { name: "Import" });
    expect(importButton.hasAttribute("aria-disabled")).toBe(false);
    expect(importButton.getAttribute("title")).toBe("Import dashboards (I)");
    fireEvent.click(create);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tabs()).toHaveLength(1);
  });

  it("Alerts opens the Alerts page", async () => {
    installFakeMonitoringApi();
    renderMonitoringApp();
    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    expect(await screen.findByRole("heading", { name: "Alerts", level: 1 })).toBeTruthy();
    expect(await screen.findByRole("note")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Alerts views" })).toBeTruthy();
    expect(tabs()[0].textContent).toContain("Alerts");
  });

  it("a removed project shows Go to Home with focus on it", async () => {
    installFakeMonitoringApi({ projects: [seedProject("p1", "Kept")] });
    renderMonitoringApp({ tabs: tabsWith({ page: "project", id: "gone" }) });
    expect(await screen.findByText("This project no longer exists.")).toBeTruthy();
    const home = screen.getByRole("button", { name: "Go to Home" });
    await waitFor(() => expect(document.activeElement).toBe(home));
    fireEvent.click(home);
    await waitFor(() => expect(tabs()[0].textContent).toContain("Home"));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Go to Home leaves the keyboard where the user is working", async () => {
    installFakeMonitoringApi({ projects: [seedProject("p1", "Kept")] });
    renderMonitoringApp({ tabs: tabsWith({ page: "project", id: "gone" }) });
    // Typing in Find while the tree is still loading: the page appearing doesn't take the keyboard.
    const find = screen.getByRole("combobox", { name: "Find anything" }) as HTMLInputElement;
    find.focus();
    fireEvent.change(find, { target: { value: "Ke" } });
    expect(await screen.findByText("This project no longer exists.")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(find);
    expect(find.value).toBe("Ke");
    expect(screen.getByRole("button", { name: "Go to Home" })).toBeTruthy();
  });

  it("a removed group or source says so too", async () => {
    installFakeMonitoringApi();
    renderMonitoringApp({ tabs: tabsWith({ page: "group", id: "g9" }, { page: "source", id: "s9" }) });
    expect(await screen.findByText("This group no longer exists.")).toBeTruthy();
    fireEvent.click(tabs()[1]);
    expect(await screen.findByText("This source no longer exists.")).toBeTruthy();
  });

  it("the tab strip moves with arrows, closes and opens tabs", async () => {
    installFakeMonitoringApi({ projects: [seedProject("p1", "Shop")] });
    renderMonitoringApp({ tabs: tabsWith({ page: "home" }, { page: "project", id: "p1" }) });
    await waitFor(() => expect(tabs()[1].textContent).toContain("Shop"));
    expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
    tabs()[0].focus();
    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs()[1]);
    expect(tabs()[1].tabIndex).toBe(0);
    fireEvent.click(tabs()[1]);
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close Shop" }));
    expect(tabs()).toHaveLength(1);
    expect(document.activeElement).toBe(tabs()[0]);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(tabs()).toHaveLength(2);
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
  });
});

describe("Find from the shell", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const shellApi = async (url: string) => json(
    url.startsWith("/api/kinds") ? KINDS
      : url.startsWith("/api/audit") ? { records: [], next_before: null }
        : url === "/api/settings" ? { encryption: { source: "environment", path: null }, discovery_interval_s: 600 } : [],
  );

  it("Ctrl K in Monitoring goes to Monitoring's Find", async () => {
    localStorage.clear();
    installFakeMonitoringApi({ projects: [seedProject("p1", "Shop")] }, shellApi);
    const ws = defaultWorkspace();
    ws.app = "monitoring";
    localStorage.setItem("omnikrux.workspace", JSON.stringify(ws));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Shell /></QueryClientProvider>);
    await screen.findByRole("treeitem", { name: "Shop" }, { timeout: 3000 });
    const find = screen.getByRole("combobox", { name: "Find anything" });
    screen.getByRole("main").focus();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(find);
    expect(screen.queryByRole("dialog", { name: "Commands" })).toBeNull();
    // The top bar's box goes there too.
    screen.getByRole("main").focus();
    fireEvent.click(screen.getByRole("button", { name: "Find in Monitoring" }));
    expect(document.activeElement).toBe(find);
    expect(screen.queryByRole("dialog")).toBeNull();
    // And "/" still does.
    screen.getByRole("main").focus();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(find);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("Narrow windows", () => {
  /** A window 760 px wide or less: Monitoring's own narrow query matches. */
  const narrow = () => vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("760px"), media: q, addEventListener() {}, removeEventListener() {},
  }));
  const notBody = () => expect(document.activeElement).not.toBe(document.body);
  const toggle = () => screen.getByRole("button", { name: "Projects and pages" });
  const drawer = () => screen.queryByRole("navigation", { name: "Monitoring" });
  const page = () => document.querySelector("[data-monitoring-page]") as HTMLElement;

  it("under 760 px the sidebar folds into a drawer", async () => {
    narrow();
    installFakeMonitoringApi({ projects: [seedProject("p1", "Shop")] });
    renderMonitoringApp();
    // Folded: the bar's button, and the page below takes the rest of the height.
    const button = toggle();
    expect(drawer()).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    const nav = document.getElementById(button.getAttribute("aria-controls")!)!;
    expect(nav.tagName).toBe("NAV");
    expect(nav.hidden).toBe(true);
    // Opened from the button: the keyboard goes into the drawer.
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(drawer()).toBe(nav);
    expect(nav.contains(document.activeElement)).toBe(true);
    // The button folds it again, and keeps the keyboard.
    button.focus();
    fireEvent.click(button);
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(button);
    // "/" opens it with Find focused; Esc in an empty Find folds it back to the button.
    screen.getByRole("main").focus();
    fireEvent.keyDown(document.body, { key: "/" });
    const find = screen.getByRole("combobox", { name: "Find anything" });
    expect(drawer()).toBe(nav);
    expect(document.activeElement).toBe(find);
    fireEvent.keyDown(find, { key: "Escape" });
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(button);
    // Ctrl K and the top bar's box (the shell's Find event) do the same.
    screen.getByRole("main").focus();
    act(() => { window.dispatchEvent(new Event("omnikrux:monitoring-find")); });
    expect(drawer()).toBe(nav);
    expect(document.activeElement).toBe(find);
    notBody();
  });

  it("a wide window keeps the sidebar and has no drawer button", () => {
    installFakeMonitoringApi();
    renderMonitoringApp();
    expect(drawer()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Projects and pages" })).toBeNull();
  });

  it("choosing a row closes the drawer and keeps the keyboard on the page", async () => {
    narrow();
    installFakeMonitoringApi({ projects: [seedProject("p1", "Shop")] });
    renderMonitoringApp();
    fireEvent.click(toggle());
    const shop = await screen.findByRole("treeitem", { name: "Shop" });
    shop.focus();
    fireEvent.keyDown(shop, { key: "Enter" });
    await waitFor(() => expect(tabs()[0].textContent).toContain("Shop"));
    expect(drawer()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const active = document.activeElement as HTMLElement;
    expect(active === screen.getByRole("main") || page().contains(active)).toBe(true);
    notBody();
    // A page link in the drawer (Alerts) does the same.
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    expect(drawer()).toBeNull();
    expect(await screen.findByRole("heading", { name: "Alerts", level: 1 })).toBeTruthy();
    notBody();
  });

  it("Esc closes the drawer and returns to its button", async () => {
    narrow();
    installFakeMonitoringApi({ projects: [seedProject("p1", "Shop")] });
    renderMonitoringApp();
    fireEvent.click(toggle());
    const shop = await screen.findByRole("treeitem", { name: "Shop" });
    shop.focus();
    notBody();
    fireEvent.keyDown(shop, { key: "Escape" });
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // A click outside (on the page behind it) closes it the same way.
    fireEvent.click(toggle());
    expect(drawer()).toBeTruthy();
    notBody();
    fireEvent.pointerDown(document.querySelector("[data-drawer-scrim]") as HTMLElement);
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(toggle());
    // The keyboard leaving the drawer (Tab past its end) folds it, wherever the keyboard went.
    fireEvent.click(toggle());
    notBody();
    const inside = document.activeElement as HTMLElement;
    expect(drawer()!.contains(inside)).toBe(true);
    act(() => screen.getByRole("main").focus());
    expect(drawer()).toBeNull();
    notBody();
  });

  it("New dashboard from the drawer never leaves the keyboard in the folded drawer", async () => {
    narrow();
    installFakeMonitoringApi({ projects: [seedProject("p1", "Shop")] });
    renderMonitoringApp();
    const nav = document.getElementById(toggle().getAttribute("aria-controls")!)!;
    const inHiddenNav = () => nav.hidden && nav.contains(document.activeElement);
    fireEvent.click(toggle());
    await screen.findByRole("treeitem", { name: "Shop" });
    notBody();
    const create = within(nav).getByRole("button", { name: "New dashboard" });
    await waitFor(() => expect(create.hasAttribute("aria-disabled")).toBe(false));
    create.focus();
    fireEvent.click(create);
    // The drawer folds and the dialog has the keyboard: never a row or button in the hidden nav,
    // not even before the dialog takes it.
    expect(inHiddenNav()).toBe(false);
    notBody();
    const dialog = await screen.findByRole("dialog");
    expect(drawer()).toBeNull();
    expect(inHiddenNav()).toBe(false);
    notBody();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    // Cancel hands it back to the drawer's button.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(toggle()));
    expect(inHiddenNav()).toBe(false);
    notBody();
  });
});


describe("The drawer's width", () => {
  // jsdom lays nothing out: the rule is checked as written (the browser confirms the drawer ends
  // inside a 375 px window, after the app rail, with no sideways page scroll).
  it("is never wider than the space it opens in, borders included", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(process.cwd(), "src", "monitoring", "sidebar", "Sidebar.module.css"), "utf8");
    const at = css.indexOf("\n.drawer {");
    const rule = css.slice(at, css.indexOf("}", at));
    // 100% of the app's box (the window less the app rail), not of the window.
    expect(rule).toMatch(/width: min\(320px, 100%\)/);
    expect(rule).toMatch(/max-width: 100%/);
    expect(rule).toMatch(/box-sizing: border-box/);
    expect(rule).toMatch(/overflow-x: hidden/);
  });
});
