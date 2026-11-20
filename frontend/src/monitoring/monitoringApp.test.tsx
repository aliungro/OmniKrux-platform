import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installFakeMonitoringApi } from "./test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "./test/renderMonitoringApp";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const tablist = () => screen.getByRole("tablist", { name: "Monitoring tabs" });
const tabs = () => within(tablist()).getAllByRole("tab");

describe("Monitoring app shell", () => {
  it("the New dashboard bar is visible and disabled", async () => {
    installFakeMonitoringApi();
    renderMonitoringApp();
    const create = screen.getByRole("button", { name: /New dashboard/ });
    expect(create.getAttribute("aria-disabled")).toBe("true");
    const importButton = screen.getByRole("button", { name: "Import" });
    expect(importButton.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Dashboards arrive in the next update.")).toBeTruthy();
    fireEvent.click(create);
    expect(tabs()).toHaveLength(1);
  });

  it("Explore and Alerts say they come later", async () => {
    installFakeMonitoringApi();
    renderMonitoringApp();
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    expect(await screen.findByRole("heading", { name: "Explore" })).toBeTruthy();
    expect(screen.getByText("Explore isn't here yet. It comes in a later update of Monitoring, after dashboards: query as you type, browse metrics and logs, and send a query to a dashboard.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Explore" }).getAttribute("aria-current")).toBe("page");
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
