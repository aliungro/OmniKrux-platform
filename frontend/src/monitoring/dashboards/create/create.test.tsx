import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupOut } from "../../api/types";
import { recordRecent } from "../../home/recent";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { intercept, linkedProject, panel, seedDashboard, spec } from "../../test/dashboardSeeds";
import { renderMonitoringApp, seedProject, tabsWith } from "../../test/renderMonitoringApp";
import type { DashboardOut, ReadyMadeOut } from "../api";
import { readDraft, writeDraft } from "../drafts/draftStore";
import { editorReducer, VIEW } from "../editor/editorState";
import { editSessions } from "../editor/useDashboardEditor";
import { emptyDashboard, newAlert } from "../schema";
import { forgetArrival, openMade } from "./arrival";
import { currentOwner } from "./currentOwner";

vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("button", { type: "button" }, `chart ${data.series.length}`) };
});

beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fallback = async () => json([]);
const T = "2026-01-01T00:00:00Z";
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const group = (id: string, name: string, ids: string[]): GroupOut => ({ id, name, project_ids: ids, created_at: T, updated_at: T });
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };

const READY: ReadyMadeOut = {
  key: "cluster", id: "ready:p1:cluster", title: "Cluster health", description: "Nodes, pods and their resources.",
  missing: [], notes: [], checked: true, check_message: null, source_name: null,
};

function shop(extra: Parameters<typeof installFakeMonitoringApi>[0] = {}): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1"), seedProject("p2", "Blog")],
    groups: [group("g1", "Everything", ["p1", "p2"])],
    dashboards: { api: seedDashboard("api", SHOP, spec("API latency", [panel("p-1", "Requests", "up")])) },
    queryAnswers: { up: ok },
    ...extra,
  }, fallback);
}

const posts = (api: FakeMonitoringApi, url: string) => api.requests.filter((r) => r.method === "POST" && r.url === url);
const note = () => screen.getByRole("navigation", { name: "Monitoring" }).querySelector<HTMLElement>("[data-new-dashboard-note]")!;
const newButton = () => screen.getByRole("button", { name: "New dashboard" });
const notBody = () => expect(document.activeElement).not.toBe(document.body);

describe("New dashboard", () => {
  it("N opens New dashboard for the current project", async () => {
    const api = shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "project", id: "p1" }) });
    await screen.findByRole("heading", { level: 1, name: "Shop" });
    // Typed in a field, n is the field's.
    const find = screen.getByRole("combobox", { name: "Find anything" });
    find.focus();
    fireEvent.keyDown(find, { key: "n" });
    expect(screen.queryByRole("dialog", { name: "New dashboard" })).toBeNull();
    screen.getByRole("main").focus();
    fireEvent.keyDown(screen.getByRole("main"), { key: "n" });
    const dialog = await screen.findByRole("dialog", { name: "New dashboard" });
    const title = within(dialog).getByLabelText("Title") as HTMLInputElement;
    expect(title.value).toBe("New dashboard");
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect([title.selectionStart, title.selectionEnd]).toEqual([0, "New dashboard".length]);
    const goes = within(dialog).getByLabelText("Goes to") as HTMLSelectElement;
    expect(goes.value).toBe("project:p1");
    expect([...goes.querySelectorAll("optgroup")].map((g) => g.label)).toEqual(["Projects", "Groups"]);
    // Ctrl+Enter creates.
    fireEvent.keyDown(title, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(posts(api, "/api/monitoring/dashboards")).toHaveLength(1));
    expect(posts(api, "/api/monitoring/dashboards")[0].body).toEqual({ owner_kind: "project", owner_id: "p1", spec: emptyDashboard("New dashboard") });
    // The tab shows it in edit mode, with the keyboard on + Add panel.
    expect(await screen.findByRole("heading", { level: 1, name: "New dashboard" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Save dashboard" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add panel" })));
    expect(within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab")).toHaveLength(1);
    // In edit mode, n does nothing.
    fireEvent.keyDown(screen.getByRole("main"), { key: "n" });
    expect(screen.queryByRole("dialog", { name: "New dashboard" })).toBeNull();
  });

  it("the bar says where new dashboards go", async () => {
    installFakeMonitoringApi({ projects: [] }, fallback);
    renderMonitoringApp();
    await waitFor(() => expect(note().textContent).toBe("Set up a project first."));
    expect(newButton().getAttribute("aria-disabled")).toBe("true");
    expect(within(newButton()).getByText("N")).toBeTruthy();
    fireEvent.click(newButton());
    expect(screen.queryByRole("dialog")).toBeNull();
    const importButton = screen.getByRole("button", { name: "Import" });
    expect(importButton.hasAttribute("aria-disabled")).toBe(false);
    expect(importButton.getAttribute("title")).toBe("Import dashboards (I)");
    cleanup();

    shop();
    renderMonitoringApp();
    await waitFor(() => expect(note().textContent).toBe("Pick where it goes when you create it."));
    expect(newButton().hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(newButton());
    const dialog = await screen.findByRole("dialog", { name: "New dashboard" });
    expect((within(dialog).getByLabelText("Goes to") as HTMLSelectElement).value).toBe("");
    // Nowhere picked: it says so and the keyboard goes to the choice.
    fireEvent.click(within(dialog).getByRole("button", { name: "Create dashboard" }));
    expect(within(dialog).getByText("Pick where the dashboard goes.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Goes to"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(newButton());
    cleanup();

    // The most recent project or group that still exists.
    recordRecent({ kind: "project", id: "gone" }, 3);
    recordRecent({ kind: "group", id: "g1" }, 2);
    shop();
    renderMonitoringApp();
    await waitFor(() => expect(note().textContent).toBe("New dashboards go to Everything"));
    cleanup();

    // The open page's project, or a dashboard's owner.
    shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "api" }) });
    await waitFor(() => expect(note().textContent).toBe("New dashboards go to Shop"));
  });

  it("currentOwner reads the open page, then the most recent", () => {
    const tree = {
      projects: [{ id: "p1", name: "Shop", kind: "custom" as const, cluster_id: null, color: "custom" as const, dashboards: [{ id: "d1", title: "A", ready_made: false }] }],
      groups: [{ id: "g1", name: "All", project_ids: ["p1"], dashboards: [{ id: "d2", title: "B", ready_made: false }] }],
      source_count: 0,
    };
    expect(currentOwner({ page: "project", id: "p1" }, tree, [])).toEqual({ kind: "project", id: "p1", name: "Shop" });
    expect(currentOwner({ page: "dashboard", id: "d2" }, tree, [])).toEqual({ kind: "group", id: "g1", name: "All" });
    expect(currentOwner({ page: "home" }, tree, [{ kind: "project", id: "x", at: 3 }, { kind: "group", id: "g1", at: 2 }])).toEqual({ kind: "group", id: "g1", name: "All" });
    expect(currentOwner({ page: "home" }, tree, [])).toBeNull();
  });

  it("the current project shows a visible plus", async () => {
    shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "project", id: "p1" }) });
    const plus = await screen.findByRole("button", { name: "New dashboard in Shop" });
    expect(screen.queryByRole("button", { name: "New dashboard in Blog" })).toBeNull();
    fireEvent.click(plus);
    const dialog = await screen.findByRole("dialog", { name: "New dashboard" });
    expect((within(dialog).getByLabelText("Goes to") as HTMLSelectElement).value).toBe("project:p1");
    // A group can be picked instead.
    fireEvent.change(within(dialog).getByLabelText("Goes to"), { target: { value: "group:g1" } });
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("New dashboard");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    notBody();
  });

  it("a taken title focuses Title with the name copy", async () => {
    const api = shop({
      dashboards: { d9: seedDashboard("d9", SHOP, spec("New dashboard", [])) },
    });
    renderMonitoringApp({ tabs: tabsWith({ page: "project", id: "p1" }) });
    fireEvent.click(await screen.findByRole("button", { name: "New dashboard in Shop" }));
    const dialog = await screen.findByRole("dialog", { name: "New dashboard" });
    const title = within(dialog).getByLabelText("Title") as HTMLInputElement;
    expect(title.value).toBe("New dashboard (2)");
    fireEvent.change(title, { target: { value: "New dashboard" } });
    within(dialog).getByRole("button", { name: "Create dashboard" }).focus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create dashboard" }));
    expect(await within(dialog).findByText('A dashboard named "New dashboard" already exists. Pick another name.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(title.getAttribute("aria-invalid")).toBe("true");
    expect(Object.keys(api.state.dashboards)).toEqual(["d9"]);
  });

  it("creating while this tab has unsaved edits opens the new dashboard in a new tab", async () => {
    const user = userEvent.setup();
    shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "api" }) });
    const heading = await screen.findByRole("heading", { level: 1, name: "API latency" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    await screen.findAllByText("chart 1");
    await user.keyboard("e");
    await screen.findByRole("button", { name: "Save dashboard" });
    // A change: the panel moves one step.
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await screen.findByText('Moved "Requests" to column 2, row 1.');
    fireEvent.click(screen.getByRole("button", { name: "New dashboard" }));
    const dialog = await screen.findByRole("dialog", { name: "New dashboard" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create dashboard" }));
    await waitFor(() => expect(within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab")).toHaveLength(2));
    expect(screen.queryByRole("dialog", { name: /Leave/ })).toBeNull();
    expect(await screen.findByRole("heading", { level: 1, name: "New dashboard" })).toBeTruthy();
  });
});

describe("Opening what was just made", () => {
  it("opens in a new tab while this tab holds JSON text that doesn't apply (F33)", () => {
    const started = editorReducer(VIEW, { type: "start", dashboardId: "api", version: 1, spec: spec("API latency", []) });
    editSessions.set("t1", editorReducer(started, { type: "setJson", text: "{ nope", ownerKind: "project" }));
    const navigate = vi.fn();
    const openInNewTab = vi.fn();
    openMade({ id: "made" } as DashboardOut, { edit: false }, { tabId: "t1", nav: { navigate }, openInNewTab });
    expect(openInNewTab).toHaveBeenCalledWith({ page: "dashboard", id: "made" });
    expect(navigate).not.toHaveBeenCalled();
    // Without unsaved work it opens in the same tab.
    editSessions.set("t1", started);
    openMade({ id: "made" } as DashboardOut, { edit: false }, { tabId: "t1", nav: { navigate }, openInNewTab });
    expect(navigate).toHaveBeenCalledWith({ page: "dashboard", id: "made" }, "push");
    forgetArrival("made");
  });
});

describe("Copy and delete", () => {
  it("copy to edit opens an editable copy of a ready-made view", async () => {
    const api = shop({
      dashboards: { "ready:p1:cluster": seedDashboard("ready:p1:cluster", SHOP, spec("Cluster health", [panel("p-1", "CPU", "up")]), true) },
      readyMade: { p1: [READY] },
    });
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "ready:p1:cluster" }) });
    await screen.findByRole("heading", { level: 1, name: "Cluster health" });
    fireEvent.click(screen.getByRole("button", { name: "Copy to edit" }));
    await waitFor(() => expect(posts(api, "/api/monitoring/dashboards/copy")).toHaveLength(1));
    expect(posts(api, "/api/monitoring/dashboards/copy")[0].body).toEqual({ from_id: "ready:p1:cluster", owner_kind: "project", owner_id: "p1" });
    expect(await screen.findByText('Copied "Cluster health". Changes go to your copy.')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save dashboard" })).toBeTruthy();
    expect(screen.queryByText("Ready-made")).toBeNull();
    notBody();
  });

  it("copy dashboard asks for a title and where it goes", async () => {
    const api = shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "api" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy dashboard…" }));
    const dialog = await screen.findByRole("dialog", { name: "Copy dashboard" });
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("API latency (copy)");
    expect((within(dialog).getByLabelText("Goes to") as HTMLSelectElement).value).toBe("project:p1");
    fireEvent.change(within(dialog).getByLabelText("Goes to"), { target: { value: "project:p2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create copy" }));
    expect(await screen.findByRole("heading", { level: 1, name: "API latency (copy)" })).toBeTruthy();
    expect(posts(api, "/api/monitoring/dashboards/copy")[0].body).toEqual({ from_id: "api", owner_kind: "project", owner_id: "p2", title: "API latency (copy)" });
    // Not in edit mode: the copy opens as it is.
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "API latency (copy)" })));
  });

  it("delete asks first, then returns to the owner page with focus on its heading", async () => {
    const api = shop();
    api.state.dashboards.api.versions.push({ ...api.state.dashboards.api.versions[0], out: { ...api.state.dashboards.api.versions[0].out, version: 2 } });
    api.state.dashboards.api.out.version = 2;
    writeDraft({ v: 1, dashboardId: "api", baseVersion: 2, savedAt: 1, draft: spec("API latency", []), jsonText: null, writer: "w-other" });
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "api" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    const more = screen.getByRole("button", { name: "More actions" });
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete dashboard…" }));
    let dialog = await screen.findByRole("alertdialog", { name: 'Delete dashboard "API latency"?' });
    expect(await within(dialog).findByText("Its 2 saved versions go with it.")).toBeTruthy();
    expect(within(dialog).getByText("Your unsaved draft in this browser goes too.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Delete dashboard" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(more);
    expect(api.state.dashboards.api).toBeTruthy();

    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete dashboard…" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
    const heading = await screen.findByRole("heading", { level: 1, name: "Shop" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(api.state.dashboards.api).toBeUndefined();
    expect(api.requests.some((r) => r.method === "DELETE" && r.url === "/api/monitoring/dashboards/api?version=2")).toBe(true);
    expect(readDraft("api")).toBeNull();
  });

  it("deleting a dashboard already deleted elsewhere follows through as a delete", async () => {
    const api = shop();
    writeDraft({ v: 1, dashboardId: "api", baseVersion: 1, savedAt: 1, draft: spec("API latency", []), jsonText: null, writer: "w-other" });
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "api" }, { page: "dashboard", id: "api" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete dashboard…" }));
    const dialog = await screen.findByRole("alertdialog", { name: 'Delete dashboard "API latency"?' });
    // Deleted in another window meanwhile: the delete answers 404.
    delete api.state.dashboards.api;
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete dashboard" }));
    const heading = await screen.findByRole("heading", { level: 1, name: "Shop" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(readDraft("api")).toBeNull();
    expect(api.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("after a delete whose owner page can't be shown, the keyboard is on the workspace, and the heading isn't taken later", async () => {
    const api = shop();
    let broken = true;
    intercept((url) => (broken && url === "/api/monitoring/projects/p1"
      ? Promise.resolve(new Response(JSON.stringify({ detail: "The project couldn't be read." }), { status: 500 }))
      : null));
    const app = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "api" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete dashboard…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Enter", ctrlKey: true });
    expect((await screen.findByRole("alert")).textContent).toContain("The project couldn't be read.");
    expect(api.state.dashboards.api).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement).toBe(screen.getByRole("main"));
    // The tab moves on; the project opened later is a usual visit, not the one after the delete.
    app.navigate({ page: "home" }, "push");
    await screen.findByRole("heading", { level: 1, name: "Monitoring" });
    broken = false;
    screen.getByRole("combobox", { name: "Find anything" }).focus();
    app.navigate({ page: "project", id: "p1" }, "push");
    await screen.findByRole("heading", { level: 1, name: "Shop" });
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { level: 1, name: "Shop" }));
  });

  it("stale delete says review it again", async () => {
    const api = shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "api" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete dashboard…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("Its saved version goes with it.")).toBeTruthy();
    expect(within(dialog).queryByText(/draft/)).toBeNull();
    // Saved somewhere else meanwhile.
    const d = api.state.dashboards.api;
    d.versions.push({ ...d.versions[0], out: { ...d.versions[0].out, version: 2 } });
    d.out.version = 2;
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete dashboard" }));
    expect(await within(dialog).findByText("This dashboard was saved since you opened this. Review it again.")).toBeTruthy();
    expect(await within(dialog).findByText("Its 2 saved versions go with it.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Delete dashboard" })));
    expect(api.state.dashboards.api).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete dashboard" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Shop" })).toBeTruthy();
    expect(api.state.dashboards.api).toBeUndefined();
  });
});

describe("Copy and delete with panel alerts", () => {
  const withAlerts = (n: number) => {
    const panels = [panel("p-1", "Requests", "up"), panel("p-2", "Errors", "up", { x: 12 }), panel("p-3", "Latency", "up", { y: 8 })];
    panels.slice(0, n).forEach((p) => { p.alert = newAlert(p, 1); });
    return shop({ dashboards: { api: seedDashboard("api", SHOP, spec("API latency", panels)) } });
  };

  it("copy and delete dialogs say what happens to alerts", async () => {
    withAlerts(2);
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "api" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy dashboard…" }));
    let dialog = await screen.findByRole("dialog", { name: "Copy dashboard" });
    expect(within(dialog).getByText("Alerts aren't copied; add them on the copy's panels.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete dashboard…" }));
    dialog = await screen.findByRole("alertdialog", { name: 'Delete dashboard "API latency"?' });
    expect(within(dialog).getByText("Its 2 alert rules stay on the Alerts page, without a panel.")).toBeTruthy();
  });

  it("one alert reads in the singular, and none says nothing about alerts", async () => {
    withAlerts(1);
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "api" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete dashboard…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Its alert rule stays on the Alerts page, without a panel.")).toBeTruthy();
    cleanup();

    shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "api" }) });
    await screen.findByRole("heading", { level: 1, name: "API latency" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy dashboard…" }));
    const copy = await screen.findByRole("dialog", { name: "Copy dashboard" });
    expect(within(copy).queryByText(/Alerts aren't copied/)).toBeNull();
  });
});
