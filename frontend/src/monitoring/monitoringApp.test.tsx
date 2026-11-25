import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
