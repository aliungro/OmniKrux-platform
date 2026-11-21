// Leaving a dashboard with unsaved changes, through the real shell: its keys, top bar and the
// Monitoring tab strip all ask the app's leave check first.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Shell } from "../../../features/shell/Shell";
import { defaultWorkspace } from "../../../features/shell/workspace";
import { KINDS } from "../../../test/kinds";
import { readRecent } from "../../home/recent";
import { installFakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import type { MonitoringView } from "../../shell/tabState";
import { editSessions } from "../editor/useDashboardEditor";

// The chart chunk as a stub.
vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
});

beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };
const KEY = "omnikrux.monitoring.draft.d1";
const TITLE = 'Leave "API latency" with unsaved changes?';

/** The shell's own requests: kinds, clusters, settings and the audit list. */
const shellApi = async (url: string) => json(
  url.startsWith("/api/kinds") ? KINDS
    : url.startsWith("/api/audit") ? { records: [], next_before: null }
      : url === "/api/settings" ? { encryption: { source: "environment", path: null }, discovery_interval_s: 600 } : [],
);

/** A workspace showing Monitoring with these tabs (the first active). */
function seedTabs(...tabs: { view: MonitoringView; back?: MonitoringView[] }[]) {
  const ws = defaultWorkspace();
  ws.app = "monitoring";
  ws.monitoring = { tabs: tabs.map((t, i) => ({ id: `m${i}`, view: t.view, back: t.back ?? [], forward: [], scrollTop: 0 })), active: "m0", closed: [] };
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws));
}

const D1: MonitoringView = { page: "dashboard", id: "d1" };
const HOME: MonitoringView = { page: "home" };

function setup(...tabs: { view: MonitoringView; back?: MonitoringView[] }[]) {
  return setupWith({}, ...tabs);
}

/** `blocked`: storage refuses every write once the workspace is seeded. */
function setupWith({ blocked = false }, ...tabs: { view: MonitoringView; back?: MonitoringView[] }[]) {
  installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: seedDashboard("d1", SHOP, spec("API latency", [panel("p-1", "Requests", "up", { x: 0, y: 0, w: 8, h: 8 })])) },
    queryAnswers: { up: ok },
  }, shellApi);
  seedTabs(...(tabs.length ? tabs : [{ view: D1 }, { view: HOME }]));
  if (blocked) vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Shell /></QueryClientProvider>);
}

const monitoringTabs = () => within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab");
const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
const altKey = (key: string, code: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key, code, altKey: true });
const dialog = () => screen.getByRole("alertdialog", { name: TITLE });
const notBody = () => expect(document.activeElement).not.toBe(document.body);

/** d1 open and in edit mode; `change` moves its panel, so there is something to lose. */
async function editing({ change = true } = {}) {
  const user = userEvent.setup();
  const title = await screen.findByRole("heading", { level: 1, name: "API latency" }, { timeout: 3000 });
  await waitFor(() => expect(document.activeElement).toBe(title));
  await screen.findAllByText("chart 1");
  await user.keyboard("e");
  await screen.findByRole("button", { name: "Save dashboard" });
  if (change) {
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await screen.findByText('Moved "Requests" to column 2, row 1.');
  }
  return user;
}

describe("Leaving a dashboard with unsaved changes", () => {
  it("Alt+W on an edited dashboard asks first", async () => {
    setup();
    await editing();
    altKey("w", "KeyW");
    const ask = dialog();
    expect(within(ask).getByText("Your changes stay saved as a draft in this browser and are offered back when you open the dashboard again.")).toBeTruthy();
    expect(within(ask).getAllByRole("button").map((b) => b.textContent)).toEqual(["Stay", "Discard changes", "Keep draft and leave"]);
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Stay" }));
    // Nothing moves the keyboard after the held key: the shell leaves it to the dialog.
    await frame();
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Stay" }));
    expect(monitoringTabs()).toHaveLength(2);
    expect(screen.getByText("Editing")).toBeTruthy();
  });

  it("Keep draft and leave closes the tab and keeps the draft", async () => {
    setup();
    await editing();
    altKey("w", "KeyW");
    // Ctrl+Enter is Keep draft and leave; the draft is written at once (no 500 ms wait).
    fireEvent.keyDown(within(dialog()).getByRole("button", { name: "Stay" }), { key: "Enter", code: "Enter", ctrlKey: true });
    await waitFor(() => expect(monitoringTabs()).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")?.draft.panels[0].layout.x).toBe(1);
    expect(editSessions.has("m0")).toBe(false);
    await frame();
    notBody();
  });

  it("Discard changes closes the tab and removes the draft", async () => {
    setup();
    await editing();
    await waitFor(() => expect(localStorage.getItem(KEY)).not.toBeNull(), { timeout: 1500 });
    altKey("w", "KeyW");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(monitoringTabs()).toHaveLength(1));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(editSessions.has("m0")).toBe(false);
    await frame();
    notBody();
  });

  it("opening another item from the sidebar in the same tab asks first", async () => {
    setup();
    const user = await editing();
    const before = readRecent();
    await user.click(await screen.findByRole("treeitem", { name: "Shop" }));
    expect(dialog()).toBeTruthy();
    // Held, the move changes nothing: still the dashboard, and nothing recorded as opened.
    expect(screen.getByRole("heading", { level: 1, name: "API latency" })).toBeTruthy();
    expect(readRecent()).toEqual(before);
    await user.click(within(dialog()).getByRole("button", { name: "Keep draft and leave" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Shop" })).toBeTruthy();
    expect(readRecent()[0]).toMatchObject({ kind: "project", id: "p1" });
    expect(localStorage.getItem(KEY)).not.toBeNull();
    notBody();
  });

  it("Alt+Left asks first", async () => {
    setup({ view: D1, back: [HOME] });
    const user = await editing();
    altKey("ArrowLeft", "ArrowLeft");
    expect(dialog()).toBeTruthy();
    await frame();
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Stay" }));
    await user.click(within(dialog()).getByRole("button", { name: "Stay" }));
    expect(screen.getByRole("heading", { level: 1, name: "API latency" })).toBeTruthy();
    // The top bar's Back asks the same.
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(within(dialog()).getByRole("button", { name: "Keep draft and leave" }));
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "API latency" })).toBeNull());
    expect(editSessions.has("m0")).toBe(false);
    notBody();
  });

  it("Esc in the dialog stays and restores focus", async () => {
    setup();
    const user = await editing();
    const tile = document.activeElement as HTMLElement;
    expect(tile.dataset.tileId).toBe("p-1");
    altKey("w", "KeyW");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(tile);
    expect(monitoringTabs()).toHaveLength(2);
    expect(screen.getByText("Editing")).toBeTruthy();

    // The tab strip's close button asks too; the strip doesn't take the keyboard from the dialog.
    const close = screen.getByRole("button", { name: "Close API latency" });
    await user.click(close);
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Stay" }));
    await frame();
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Stay" }));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(close);
    expect(monitoringTabs()).toHaveLength(2);
  });

  it("a held close of a tab that isn't active closes that tab and keeps the draft", async () => {
    setup();
    const user = await editing();
    // The other tab is shown; the edited one's session lives on in memory.
    await user.click(monitoringTabs()[1]);
    await waitFor(() => expect(monitoringTabs()[1].getAttribute("aria-selected")).toBe("true"));
    const close = screen.getByRole("button", { name: "Close API latency" });
    await user.click(close);
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Stay" }));
    await user.click(within(dialog()).getByRole("button", { name: "Keep draft and leave" }));
    await waitFor(() => expect(monitoringTabs()).toHaveLength(1));
    expect(monitoringTabs()[0].getAttribute("aria-selected")).toBe("true");
    expect(monitoringTabs()[0].textContent).toContain("Home");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")?.draft.panels[0].layout.x).toBe(1);
    expect(editSessions.size).toBe(0);
    await frame();
    notBody();
  });

  it("a held replace navigation is performed again as a replace", async () => {
    installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      dashboards: { d1: seedDashboard("d1", SHOP, spec("API latency", [panel("p-1", "Requests", "up", { x: 0, y: 0, w: 8, h: 8 })])) },
      queryAnswers: { up: ok },
    }, shellApi);
    const app = renderMonitoringApp({ tabs: tabsWith(D1) });
    await editing();
    app.navigate({ page: "project", id: "p1" }, "replace");
    expect(dialog()).toBeTruthy();
    expect(app.current().tabs[0].view).toEqual(D1);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Keep draft and leave" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Shop" })).toBeTruthy();
    // Replaced, not pushed: Back doesn't return to the dashboard.
    expect(app.current().tabs[0].view).toEqual({ page: "project", id: "p1" });
    expect(app.current().tabs[0].back).toEqual([]);
  });

  it("without changes nothing is asked", async () => {
    setup();
    await editing({ change: false });
    altKey("w", "KeyW");
    await waitFor(() => expect(monitoringTabs()).toHaveLength(1));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await frame();
    notBody();
  });

  it("with blocked storage the dialog says changes are lost and has no Keep draft", async () => {
    setupWith({ blocked: true });
    await editing();
    altKey("w", "KeyW");
    const ask = dialog();
    expect(within(ask).getByText("This browser can't keep drafts, so leaving loses these changes.")).toBeTruthy();
    expect(within(ask).queryByRole("button", { name: "Keep draft and leave" })).toBeNull();
    // Ctrl+Enter keeps nothing: there is no draft to keep.
    fireEvent.keyDown(within(ask).getByRole("button", { name: "Stay" }), { key: "Enter", code: "Enter", ctrlKey: true });
    expect(dialog()).toBeTruthy();
    expect(monitoringTabs()).toHaveLength(2);
    fireEvent.click(within(ask).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(monitoringTabs()).toHaveLength(1));
  });
});
