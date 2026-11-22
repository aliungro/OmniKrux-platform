import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
    expect(importButton.getAttribute("aria-disabled")).toBe("true");
    expect(importButton.getAttribute("aria-description")).toBe("Importing dashboards arrives in a later update.");
    fireEvent.click(create);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tabs()).toHaveLength(1);
  });

  it("Explore and Alerts say they come later", async () => {
    installFakeMonitoringApi();
    renderMonitoringApp();
    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    expect(await screen.findByRole("heading", { name: "Alerts" })).toBeTruthy();
    expect(screen.getByText("Alerts aren't here yet. They come in a later update of Monitoring. Until then, nothing here evaluates rules or sends notifications.")).toBeTruthy();
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
