import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import type { DashboardSpec } from "../schema";
import { editSessions } from "./useDashboardEditor";

// The chart chunk as a stub.
vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
});

// CodeMirror doesn't run in jsdom: the diff draws both sides as text.
vi.mock("../../../features/actions/lazyCodeMirror", () => ({
  loadCodeMirror: () => Promise.resolve({
    mergeView: (parent: HTMLElement, before: string, after: string) => {
      const a = document.createElement("pre");
      a.dataset.testid = "diff-before";
      a.textContent = before;
      const b = document.createElement("pre");
      b.dataset.testid = "diff-after";
      b.textContent = after;
      parent.append(a, b);
      return { destroy: () => parent.replaceChildren() };
    },
    editor: () => ({ destroy: () => {}, focus: () => {} }),
  }),
}));

// Edit sessions outlive the page (switching app and back resumes them); each test starts clean.
beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };

const doc = (): DashboardSpec => spec("API latency", [
  panel("p-1", "Requests", "up", { x: 0, y: 0, w: 8, h: 8 }),
  panel("p-2", "Errors", "errors", { x: 12, y: 0, w: 12, h: 8 }),
]);

function shop(): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: seedDashboard("d1", SHOP, doc()) },
    queryAnswers: { up: ok, errors: ok },
  }, async () => json([]));
}

const puts = (api: FakeMonitoringApi) => api.requests.filter((r) => r.method === "PUT" && r.url.startsWith("/api/monitoring/dashboards/"));
const batches = (api: FakeMonitoringApi) => api.requests.filter((r) => r.url === "/api/monitoring/query/batch");
const panels = () => screen.getByRole("group", { name: "Panels" });
const tile = (title: string) => {
  const found = within(panels()).getAllByRole("region").find((t) => t.getAttribute("aria-label")?.startsWith(`${title},`));
  if (!found) throw new Error(`no tile ${title}`);
  return found;
};
const notBody = () => expect(document.activeElement).not.toBe(document.body);

async function editing(api = shop()) {
  const user = userEvent.setup();
  const app = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
  const title = await screen.findByRole("heading", { level: 1, name: "API latency" });
  await waitFor(() => expect(document.activeElement).toBe(title));
  await screen.findAllByText("chart 1");
  await user.keyboard("e");
  await screen.findByRole("button", { name: "Save dashboard" });
  return { user, api, app };
}

describe("Edit mode", () => {
  it("Edit by key shows the edit bar with Save dashboard", async () => {
    const { api } = await editing();
    expect(screen.getByText("Editing")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save dashboard" });
    expect(save.getAttribute("aria-keyshortcuts")).toBe("Control+S");
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    // Time and refresh stay.
    expect(screen.getByRole("button", { name: "Last 6 hours" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh now" })).toBeTruthy();
    // The keyboard lands on the first tile; one tile is in the Tab order.
    expect(document.activeElement).toBe(tile("Requests"));
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 1, row 1");
    expect(tile("Requests").tabIndex).toBe(0);
    expect(tile("Errors").tabIndex).toBe(-1);
    expect(within(tile("Requests")).getByRole("button", { name: "Move Requests" })).toBeTruthy();
    expect(within(tile("Requests")).getByRole("button", { name: "Resize Requests" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add panel" })).toBeTruthy();
    // Entering edit mode re-runs nothing (one batch per panel, from opening).
    await new Promise((r) => setTimeout(r, 30));
    expect(batches(api)).toHaveLength(2);
  });

  it("arrow keys move between tiles; Shift+Right moves the panel and is announced", async () => {
    const { user } = await editing();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tile("Errors"));
    expect(tile("Errors").tabIndex).toBe(0);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tile("Requests"));
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 2, row 1");
    expect(await screen.findByText('Moved "Requests" to column 2, row 1.')).toBeTruthy();
    expect(document.activeElement).toBe(tile("Requests"));
  });

  it("Ctrl+Shift+Right widens the panel", async () => {
    const { user } = await editing();
    await user.keyboard("{Control>}{Shift>}{ArrowRight}{/Shift}{/Control}");
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 9 by 8, column 1, row 1");
    expect(await screen.findByText('Resized "Requests" to 9 by 8.')).toBeTruthy();
    expect(document.activeElement).toBe(tile("Requests"));
  });

  it("a adds a panel and focuses Query A", async () => {
    const { user } = await editing();
    await user.keyboard("a");
    // The free spot for 12 by 8: a new row under the two panels.
    expect(tile("New panel").getAttribute("aria-label")).toBe("New panel, 12 by 8, column 1, row 9");
    const field = await screen.findByRole("textbox", { name: "Query A" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(screen.getByRole("complementary", { name: "Panel settings" })).toBeTruthy();
    // Esc in the settings goes back to the tile.
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(tile("New panel"));
  });

  it("clicking the Add panel tile adds one there", async () => {
    const { user } = await editing();
    await user.click(screen.getByRole("button", { name: "Add panel" }));
    expect(tile("New panel")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Query A" })));
  });

  it("Ctrl+Delete removes the tile and says Discard brings it back", async () => {
    const { user } = await editing();
    await user.keyboard("{Control>}{Delete}{/Control}");
    expect(within(panels()).getAllByRole("region")).toHaveLength(1);
    expect(await screen.findByText('Removed "Requests". Discard brings it back.')).toBeTruthy();
    expect(document.activeElement).toBe(tile("Errors"));
  });

  it("Esc on a tile goes to Save dashboard", async () => {
    const { user } = await editing();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save dashboard" }));
    expect(screen.getByText("Editing")).toBeTruthy();
  });

  it("Ctrl+S saves and returns focus to Edit", async () => {
    const { user, api } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    const runs = batches(api).length;
    await user.keyboard("{Control>}s{/Control}");
    const edit = await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(puts(api)).toHaveLength(1);
    const body = puts(api)[0].body as { base_version: number; spec: DashboardSpec };
    expect(body.base_version).toBe(1);
    expect(body.spec.panels.find((p) => p.id === "p-1")?.layout).toEqual({ x: 1, y: 0, w: 8, h: 8 });
    expect(api.state.dashboards.d1.out.version).toBe(2);
    expect(screen.queryByText("Editing")).toBeNull();
    // The save re-reads the dashboard, not its panels.
    await new Promise((r) => setTimeout(r, 30));
    expect(batches(api).length).toBe(runs);
    // Outside edit mode Ctrl+S is the browser's.
    const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    edit.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("Discard asks first when there are changes", async () => {
    const { user } = await editing();
    // Without changes it just leaves edit mode.
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" })));
    await user.keyboard("e");
    await screen.findByRole("button", { name: "Save dashboard" });
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    const discard = screen.getByRole("button", { name: "Discard" });
    await user.click(discard);
    const dialog = screen.getByRole("alertdialog", { name: 'Discard your changes to "API latency"?' });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Discard changes" }));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(discard);
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 2, row 1");
    await user.click(discard);
    await user.keyboard("{Control>}{Enter}{/Control}");
    const edit = await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(screen.queryByText("Editing")).toBeNull();
  });

  it("a refused save keeps the draft and offers the review", async () => {
    const { user, api } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    // Someone saved version 2 somewhere else meanwhile.
    const theirs = doc();
    theirs.panels[1].title = "Errors (theirs)";
    const d = api.state.dashboards.d1;
    d.out = { ...d.out, version: 2, spec: theirs };
    await user.keyboard("{Control>}s{/Control}");
    expect(await screen.findByText("This dashboard was saved somewhere else since you started (version 2). Review the differences before saving.")).toBeTruthy();
    // The draft survives the refusal.
    expect(screen.getByText("Editing")).toBeTruthy();
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 2, row 1");
    notBody();

    await user.click(screen.getByRole("button", { name: "Review differences" }));
    const dialog = screen.getByRole("dialog", { name: "Saved version 2 and your draft" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Save over it" }));
    expect(within(dialog).getByRole("button", { name: "Keep editing" })).toBeTruthy();
    expect(within(dialog).getByText("Saved version 2")).toBeTruthy();
    expect(within(dialog).getByText("Your draft")).toBeTruthy();
    expect((await within(dialog).findByTestId("diff-before")).textContent).toContain("Errors (theirs)");
    expect(within(dialog).getByTestId("diff-after").textContent).toContain('"x": 1');

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(puts(api)).toHaveLength(2));
    expect((puts(api)[1].body as { base_version: number }).base_version).toBe(2);
    const edit = await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(api.state.dashboards.d1.out.version).toBe(3);
  });

  it("a save refused by Ctrl+S on a tile puts the keyboard on Review differences", async () => {
    const { user, api } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(document.activeElement).toBe(tile("Requests"));
    const d = api.state.dashboards.d1;
    d.out = { ...d.out, version: 2 };
    await user.keyboard("{Control>}s{/Control}");
    const review = await screen.findByRole("button", { name: "Review differences" });
    await waitFor(() => expect(document.activeElement).toBe(review));
    // And stays there once the newer version has been read.
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(review);
    expect(screen.getByText("Editing")).toBeTruthy();
  });

  it("a save refused from the Save button puts the keyboard on Review differences", async () => {
    const { user, api } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    const d = api.state.dashboards.d1;
    d.out = { ...d.out, version: 2 };
    await user.click(screen.getByRole("button", { name: "Save dashboard" }));
    const review = await screen.findByRole("button", { name: "Review differences" });
    await waitFor(() => expect(document.activeElement).toBe(review));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(review);
  });

  it("after a refused save, a re-read that fails keeps edit mode and the review", async () => {
    const { user, api } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    const d = api.state.dashboards.d1;
    d.out = { ...d.out, version: 2 };
    let broken = true;
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => (broken && (init?.method ?? "GET") === "GET" && String(input) === "/api/monitoring/dashboards/d1"
      ? Promise.reject(new TypeError("Failed to fetch"))
      : inner(input, init))));
    await user.keyboard("{Control>}s{/Control}");
    const notice = (await screen.findByText(/^Couldn't read this dashboard again/)).closest('[role="alert"]') as HTMLElement;
    expect(notice.textContent).toContain("Check that it's running, then try again.");
    expect(screen.getByText("Editing")).toBeTruthy();
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 2, row 1");
    const review = screen.getByRole("button", { name: "Review differences" });
    await waitFor(() => expect(document.activeElement).toBe(review));
    broken = false;
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText(/^Couldn't read this dashboard again/)).toBeNull());
    notBody();
    await user.click(review);
    const dialog = screen.getByRole("dialog", { name: "Saved version 2 and your draft" });
    expect(await within(dialog).findByTestId("diff-before")).toBeTruthy();
  });

  it("a save the server refuses as invalid shows its problems with Show in JSON", async () => {
    const { user, api } = await editing();
    await user.keyboard("a");
    await screen.findByRole("textbox", { name: "Query A" });
    await user.click(screen.getByRole("button", { name: "Save dashboard" }));
    const problems = await screen.findByRole("alert");
    expect(problems.textContent).toContain("panels[2].queries[0].expr");
    expect(screen.getByText("Editing")).toBeTruthy();
    await user.click(within(problems).getByRole("button", { name: "Show in JSON" }));
    expect(screen.getByRole("tab", { name: "JSON" }).getAttribute("aria-selected")).toBe("true");
    expect(puts(api)).toHaveLength(1);
  });

  it("dragging a tile by its handle moves it", async () => {
    await editing();
    // jsdom has no layout: the grid is 950 px wide, so each column is 30 px plus a 10 px gap.
    vi.spyOn(panels(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 950, 400));
    const handle = within(tile("Requests")).getByRole("button", { name: "Move Requests" });
    const point = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(handle, event);
    };
    point("pointerdown", 100, 100);
    point("pointermove", 182, 104);
    // The target is outlined while dragging.
    expect(screen.getByTestId("drop-target")).toBeTruthy();
    point("pointerup", 182, 104);
    expect(screen.queryByTestId("drop-target")).toBeNull();
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 3, row 1");
    expect(document.activeElement).toBe(tile("Requests"));

    // Esc during a drag puts it back where it started.
    const resize = within(tile("Requests")).getByRole("button", { name: "Resize Requests" });
    const at = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
      Object.defineProperty(event, "pointerId", { value: 2 });
      fireEvent(resize, event);
    };
    at("pointerdown", 300, 300);
    at("pointermove", 380, 380);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    at("pointerup", 380, 380);
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 3, row 1");
    expect(screen.getByText("Editing")).toBeTruthy();
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Save dashboard" }));
  });

  it("entering edit mode from the JSON tab puts the keyboard on Save dashboard", async () => {
    const user = userEvent.setup();
    shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    const title = await screen.findByRole("heading", { level: 1, name: "API latency" });
    await waitFor(() => expect(document.activeElement).toBe(title));
    await user.keyboard("2");
    expect(screen.getByRole("tab", { name: "JSON" }).getAttribute("aria-selected")).toBe("true");
    await user.keyboard("e");
    const save = await screen.findByRole("button", { name: "Save dashboard" });
    notBody();
    expect(document.activeElement).toBe(save);
  });

  it("saving with no changes writes nothing and leaves edit mode", async () => {
    const { user, api } = await editing();
    await user.keyboard("{Control>}s{/Control}");
    const edit = await screen.findByRole("button", { name: "Edit" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(screen.queryByText("Editing")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(puts(api)).toHaveLength(0);
    expect(api.state.dashboards.d1.out.version).toBe(1);
  });

  it("Ctrl+S with a dialog open saves nothing and keeps the browser's Save away", async () => {
    const { user, api } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    const dialog = screen.getByRole("alertdialog");
    const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(dialog.isConnected).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(puts(api)).toHaveLength(0);
  });

  it("Save over it refused as invalid shows the problems with Show in JSON", async () => {
    const { user, api } = await editing();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    const d = api.state.dashboards.d1;
    d.out = { ...d.out, version: 2 };
    await user.keyboard("{Control>}s{/Control}");
    await screen.findByText(/saved somewhere else since you started \(version 2\)/);
    // The next save is refused as invalid.
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => (init?.method === "PUT"
      ? Promise.resolve(new Response(JSON.stringify({ detail: {
        code: "invalid_dashboard", message: "The dashboard has problems.", problems: [{ path: "panels[0].title", message: "Use at most 120 characters." }],
      } }), { status: 422, headers: { "content-type": "application/json" } }))
      : inner(input, init))));
    await user.click(screen.getByRole("button", { name: "Review differences" }));
    await within(screen.getByRole("dialog")).findByTestId("diff-before");
    await user.keyboard("{Control>}{Enter}{/Control}");
    const problems = await screen.findByRole("alert");
    expect(problems.textContent).toContain("panels[0].title");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/saved somewhere else/)).toBeNull();
    const show = within(problems).getByRole("button", { name: "Show in JSON" });
    await waitFor(() => expect(document.activeElement).toBe(show));
    expect(screen.getByText("Editing")).toBeTruthy();
  });

  it("a drag that ends where it started changes nothing", async () => {
    const { user } = await editing();
    vi.spyOn(panels(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 950, 400));
    const handle = within(tile("Requests")).getByRole("button", { name: "Move Requests" });
    const point = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
      Object.defineProperty(event, "pointerId", { value: 3 });
      fireEvent(handle, event);
    };
    point("pointerdown", 100, 100);
    point("pointermove", 182, 104);
    point("pointermove", 103, 101);
    point("pointerup", 103, 101);
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 1, row 1");
    expect(screen.queryByText(/^Moved "Requests"/)).toBeNull();
    // Nothing changed, so Discard doesn't ask.
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" })));
  });

  it("a drag clamped at the left edge changes nothing", async () => {
    const { user } = await editing();
    vi.spyOn(panels(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 950, 400));
    const handle = within(tile("Requests")).getByRole("button", { name: "Move Requests" });
    const point = (type: string, clientX: number, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
      Object.defineProperty(event, "pointerId", { value: 4 });
      fireEvent(handle, event);
    };
    // Three columns to the left of column 1: it can't go further than where it is.
    point("pointerdown", 200, 100);
    point("pointermove", 80, 100);
    point("pointerup", 80, 100);
    expect(tile("Requests").getAttribute("aria-label")).toBe("Requests, 8 by 8, column 1, row 1");
    expect(screen.queryByText(/^Moved "Requests"/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" })));
  });

  it("Enter on a tile opens its settings with the keyboard on the Query tab", async () => {
    const { user } = await editing();
    await user.keyboard("{Enter}");
    const query = within(screen.getByRole("complementary", { name: "Panel settings" })).getByRole("tab", { name: "Query" });
    expect(document.activeElement).toBe(query);
    expect(query.getAttribute("aria-selected")).toBe("true");
  });
});
