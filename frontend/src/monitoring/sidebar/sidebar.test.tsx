import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { GroupOut } from "../api/types";
import { readRecent } from "../home/recent";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject } from "../test/renderMonitoringApp";
import { treeRows } from "./treeModel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const group = (id: string, name: string, projectIds: string[]): GroupOut =>
  ({ id, name, project_ids: projectIds, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });

function seedTwo(fallback?: Parameters<typeof installFakeMonitoringApi>[1]) {
  return installFakeMonitoringApi({
    projects: [seedProject("p1", "A", "kubernetes", { id: "c1", provider: "aks" }), seedProject("p2", "B")],
    groups: [group("g1", "Both", ["p1", "p2"])],
  }, fallback);
}

const tree = () => screen.getByRole("tree", { name: "Projects and groups" });
const rowTexts = () => [...tree().querySelectorAll<HTMLElement>("[data-row-kind]")].map((el) => `${el.dataset.rowKind}:${el.dataset.rowLabel}`);
const activeTab = () => within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")!;
const find = () => screen.getByRole("combobox", { name: "Find anything" }) as HTMLInputElement;

describe("Monitoring sidebar", () => {
  it("sidebar lists sections, groups and projects", async () => {
    seedTwo();
    renderMonitoringApp();
    const nav = screen.getByRole("navigation", { name: "Monitoring" });
    expect(within(nav).getByText("Monitoring")).toBeTruthy();
    expect(within(nav).getByText("Alt 2")).toBeTruthy();
    expect(find().getAttribute("placeholder")).toBe("Find anything");
    await screen.findByRole("treeitem", { name: "Both" });
    expect(rowTexts()).toEqual(["section:Groups", "group:Both", "section:Projects", "project:A", "project:B"]);
    expect(screen.getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Explore" }).hasAttribute("aria-current")).toBe(false);
    // The colour dot follows the cluster's provider; a project of your own is lilac.
    const dot = (name: string) => screen.getByRole("treeitem", { name }).querySelector<HTMLElement>("[data-dot]")!.style.background;
    expect(dot("A")).toBe("var(--aks)");
    expect(dot("B")).toBe("var(--focus)");
  });

  it("shows the empty lines, the source count, and the + buttons open their pages", async () => {
    installFakeMonitoringApi({ sources: [] });
    renderMonitoringApp();
    expect(await screen.findByText("Combine projects into a group with +")).toBeTruthy();
    expect(screen.getByText("No projects yet")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^Sources/ })).getByText("0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    await waitFor(() => expect(activeTab().textContent).toContain("New project"));
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    await waitFor(() => expect(activeTab().textContent).toContain("New group"));
  });

  it("arrow keys move through the tree and → opens a group", async () => {
    seedTwo();
    renderMonitoringApp();
    const groupRow = await screen.findByRole("treeitem", { name: "Both" });
    expect(groupRow.tabIndex).toBe(0);
    expect(screen.getByRole("treeitem", { name: "A" }).tabIndex).toBe(-1);
    groupRow.focus();
    expect(groupRow.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(groupRow, { key: "ArrowRight" });
    expect(await screen.findByRole("treeitem", { name: "Go to project A" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "Go to project B" })).toBeTruthy();
    expect(groupRow.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(groupRow);
    expect(JSON.parse(localStorage.getItem("omnikrux.monitoring.sidebar") ?? "[]")).toEqual(["group:g1"]);
    fireEvent.keyDown(groupRow, { key: "ArrowDown" });
    const shortcut = screen.getByRole("treeitem", { name: "Go to project A" });
    expect(document.activeElement).toBe(shortcut);
    expect(shortcut.tabIndex).toBe(0);
    fireEvent.keyDown(shortcut, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(groupRow);
    fireEvent.keyDown(groupRow, { key: "ArrowLeft" });
    expect(screen.queryByRole("treeitem", { name: "Go to project A" })).toBeNull();
    expect(document.activeElement).toBe(groupRow);
    // Down from the group skips the Projects heading; a project opens to its dashboards.
    fireEvent.keyDown(groupRow, { key: "ArrowDown" });
    const a = screen.getByRole("treeitem", { name: "A" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(screen.getByText("No dashboards yet")).toBeTruthy();
    fireEvent.keyDown(a, { key: "ArrowUp" });
    expect(document.activeElement).toBe(groupRow);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("a row removed under the keyboard hands it back to the tree", async () => {
    const api = seedTwo();
    const { client } = renderMonitoringApp();
    const b = await screen.findByRole("treeitem", { name: "B" });
    b.focus();
    api.state.projects = api.state.projects.filter((p) => p.id !== "p2");
    api.state.groups[0].project_ids = ["p1"];
    await client.invalidateQueries();
    await waitFor(() => expect(screen.queryByRole("treeitem", { name: "B" })).toBeNull());
    await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("treeitem"));
  });

  it("Enter on a shortcut opens the project in the active tab", async () => {
    seedTwo();
    renderMonitoringApp();
    const groupRow = await screen.findByRole("treeitem", { name: "Both" });
    groupRow.focus();
    fireEvent.keyDown(groupRow, { key: "ArrowRight" });
    fireEvent.keyDown(groupRow, { key: "ArrowDown" });
    const shortcut = screen.getByRole("treeitem", { name: "Go to project A" });
    fireEvent.keyDown(shortcut, { key: "Enter" });
    await waitFor(() => expect(activeTab().textContent).toContain("A"));
    expect(within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab")).toHaveLength(1);
    expect(readRecent().map((r) => `${r.kind}:${r.id}`)).toEqual(["project:p1"]);
    // Ctrl+Enter opens the group in a new tab, and the group is remembered as recent too.
    fireEvent.keyDown(groupRow, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab")).toHaveLength(2));
    await waitFor(() => expect(activeTab().textContent).toContain("Both"));
    await waitFor(() => expect(readRecent().map((r) => `${r.kind}:${r.id}`)).toEqual(["group:g1", "project:p1"]));
    // Ctrl+click on a project row opens a third tab.
    fireEvent.click(screen.getByRole("treeitem", { name: "B" }), { ctrlKey: true });
    await waitFor(() => expect(within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab")).toHaveLength(3));
  });

  it("slash focuses Find and Enter opens the top hit", async () => {
    seedTwo();
    renderMonitoringApp();
    await screen.findByRole("treeitem", { name: "Both" });
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(find());
    fireEvent.change(find(), { target: { value: "bo" } });
    const list = screen.getByRole("listbox", { name: "Find results" });
    expect(within(list).getAllByRole("option")[0].textContent).toContain("Both");
    expect(find().getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(find(), { key: "Enter" });
    await waitFor(() => expect(activeTab().textContent).toContain("Both"));
    expect(find().value).toBe("");
    expect(document.activeElement).toBe(screen.getByRole("main"));
    // "/" typed into a field is the field's.
    find().focus();
    fireEvent.keyDown(find(), { key: "/" });
    expect(document.activeElement).toBe(find());
  });

  it("Esc in Find clears, then returns to main", async () => {
    seedTwo();
    renderMonitoringApp();
    await screen.findByRole("treeitem", { name: "Both" });
    find().focus();
    fireEvent.change(find(), { target: { value: "A" } });
    fireEvent.keyDown(find(), { key: "Escape" });
    expect(find().value).toBe("");
    expect(document.activeElement).toBe(find());
    fireEvent.keyDown(find(), { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("Find subtitles name the cluster, not its id", async () => {
    seedTwo(async (url) => new Response(JSON.stringify(url === "/api/clusters" ? [{ id: "c1", name: "East cluster", provider: "aks" }] : []), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    renderMonitoringApp();
    await screen.findByRole("treeitem", { name: "Both" });
    find().focus();
    fireEvent.change(find(), { target: { value: "A" } });
    await waitFor(() => expect(screen.getByRole("option", { name: /^A/ }).textContent).toContain("Kubernetes · East cluster"));
  });

  it("treeRows lays out the sections", () => {
    const out = treeRows({
      projects: [{ id: "p1", name: "A", kind: "custom", cluster_id: null, color: "custom", dashboards: [] }],
      groups: [{ id: "g1", name: "G", project_ids: ["p1"], dashboards: [] }],
      source_count: 0,
    }, new Set(["group:g1", "project:p1"]));
    expect(out.map((r) => [r.kind, r.level, r.label])).toEqual([
      ["section", 0, "Groups"], ["group", 0, "G"], ["shortcut", 1, "A"],
      ["section", 0, "Projects"], ["project", 0, "A"], ["empty", 1, "No dashboards yet"],
    ]);
  });
});
