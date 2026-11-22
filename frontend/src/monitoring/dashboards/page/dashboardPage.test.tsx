import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager, onlineManager } from "@tanstack/react-query";
import type { QueryRequest } from "../../api/types";
import type { GroupOut } from "../../api/types";
import { readRecent, recordRecent } from "../../home/recent";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { gate, intercept, linkedProject, panel, seedDashboard, spec } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import type { ReadyMadeOut } from "../api";
import { editSessions } from "../editor/useDashboardEditor";

// The chart chunk as a stub: it prints how many series it was given.
vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  // Focusable, like a table header or a log line in the real charts.
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("button", { type: "button" }, `chart ${data.series.length}`) };
});

beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fallback = async () => json([]);
const REFUSED = "Can't reach Prometheus: the connection was refused. Check the address and that the tool is running.";
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };

const batches = (api: FakeMonitoringApi) =>
  api.requests.filter((r) => r.url === "/api/monitoring/query/batch").map((r) => (r.body as { queries: QueryRequest[] }).queries);

function shop(extra: Parameters<typeof installFakeMonitoringApi>[0] = {}) {
  const doc = spec("API latency", [panel("p-1", "Requests", "up")]);
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: seedDashboard("d1", SHOP, doc) },
    queryAnswers: { up: ok },
    ...extra,
  }, fallback);
}

const notBody = () => expect(document.activeElement).not.toBe(document.body);

describe("Dashboard page", () => {
  it("opens with focus on the title and records it as recent", async () => {
    const user = userEvent.setup();
    shop();
    renderMonitoringApp();
    const find = await screen.findByRole("combobox", { name: "Find anything" });
    await user.click(find);
    await user.type(find, "API lat");
    await user.click(await screen.findByRole("option", { name: /API latency/ }));
    const title = await screen.findByRole("heading", { level: 1, name: "API latency" });
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(readRecent()[0]).toMatchObject({ kind: "dashboard", id: "d1" });
    // The tab is named after the dashboard; the crumb names and opens its owner.
    expect(screen.getAllByRole("tab").some((t) => t.textContent?.includes("API latency"))).toBe(true);
    expect(await screen.findByText("chart 1")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Shop" }));
    expect(await screen.findByRole("heading", { name: "Shop" })).toBeTruthy();
  });

  it("Home's Recently opened opens the dashboard itself", async () => {
    const user = userEvent.setup();
    shop();
    recordRecent({ kind: "dashboard", id: "d1" }, 1);
    renderMonitoringApp();
    const section = await screen.findByRole("region", { name: "Recently opened" });
    await user.click(within(section).getByRole("button", { name: /API latency/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "API latency" })).toBeTruthy();
  });

  it("header tabs, time, refresh and edit by key", async () => {
    const user = userEvent.setup();
    const api = shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    const title = await screen.findByRole("heading", { level: 1, name: "API latency" });
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(await screen.findByText("chart 1")).toBeTruthy();

    const views = screen.getByRole("tablist", { name: "Dashboard views" });
    expect(within(views).getAllByRole("tab").map((t) => [t.textContent, t.getAttribute("aria-keyshortcuts")]))
      .toEqual([["Dashboard", "1"], ["JSON", "2"], ["Versions", "3"]]);
    await user.keyboard("2");
    const jsonTab = within(views).getByRole("tab", { name: "JSON" });
    expect(jsonTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(jsonTab);
    expect(screen.getByLabelText("Dashboard JSON").textContent).toContain('"title": "API latency"');
    await user.keyboard("1");
    expect(within(views).getByRole("tab", { name: "Dashboard" }).getAttribute("aria-selected")).toBe("true");
    notBody();

    await user.keyboard("t");
    const menu = screen.getByRole("menu", { name: "Time range" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(9);
    const checked = within(menu).getByRole("menuitemradio", { name: "Last 6 hours" });
    expect(checked.getAttribute("aria-checked")).toBe("true");
    expect(menu.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Time range" })).toBeNull();
    const time = screen.getByRole("button", { name: "Last 6 hours" });
    expect(document.activeElement).toBe(time);
    expect(time.getAttribute("aria-keyshortcuts")).toBe("t");

    const before = batches(api).length;
    await user.keyboard("r");
    await waitFor(() => expect(batches(api).length).toBe(before + 1));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Refresh now" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(batches(api).length).toBe(before + 1);

    // `e` enters edit mode: Edit gives way to Save dashboard, and the keyboard goes to the first panel.
    await user.keyboard("e");
    expect(screen.getByRole("button", { name: "Save dashboard" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    notBody();
  });

  it("picking a time range replaces the view and re-runs panels", async () => {
    const user = userEvent.setup();
    const api = shop();
    const { current } = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    expect(await screen.findByText("chart 1")).toBeTruthy();
    const first = batches(api)[0][0];
    expect((first.end as number) - (first.start as number)).toBeGreaterThanOrEqual(6 * 3600);

    await user.click(screen.getByRole("button", { name: "Last 6 hours" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Last 1 hour" }));
    expect(current().tabs[0].view).toMatchObject({ page: "dashboard", id: "d1", time: { from: "now-1h", to: "now" } });
    expect(current().tabs[0].back).toEqual([]);
    await waitFor(() => expect(batches(api).length).toBe(2));
    const next = batches(api)[1][0];
    expect((next.end as number) - (next.start as number)).toBeLessThan(2 * 3600);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last 1 hour" }));
  });

  it("a custom range checks its fields and keeps the menu open", async () => {
    const user = userEvent.setup();
    shop();
    const { current } = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    await user.click(await screen.findByRole("button", { name: "Last 6 hours" }));
    await user.click(screen.getByRole("menuitem", { name: "Custom range…" }));
    const from = screen.getByLabelText("From") as HTMLInputElement;
    expect(from.placeholder).toBe("now-6h");
    expect((screen.getByLabelText("To") as HTMLInputElement).placeholder).toBe("now");
    await user.clear(from);
    await user.type(from, "yesterday");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText('Use "now", "now-<number><s|m|h|d|w>", or a UTC time like 2026-11-19T10:00:00Z.')).toBeTruthy();
    expect(screen.getByRole("menu", { name: "Time range" })).toBeTruthy();
    await user.clear(from);
    await user.type(from, "now-2h");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(current().tabs[0].view).toMatchObject({ time: { from: "now-2h", to: "now" } });
    expect(screen.queryByRole("menu", { name: "Time range" })).toBeNull();
    notBody();
  });

  it("each panel shows its own state", async () => {
    const doc = spec("Mixed", [
      panel("a", "Answer", "up", { x: 0, y: 0, w: 6 }),
      panel("b", "Quiet", "nothing", { x: 6, y: 0, w: 6 }),
      panel("c", "Far", "far", { x: 12, y: 0, w: 6 }),
      panel("d", "Broken", "bad{", { x: 18, y: 0, w: 6 }),
    ]);
    installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      dashboards: { d1: seedDashboard("d1", SHOP, doc) },
      queryAnswers: {
        up: ok,
        nothing: { result_type: "matrix", series: [] },
        far: { error: { code: "unreachable", message: REFUSED }, status: 502 },
        "bad{": { error: { code: "bad_query", message: "parse error: unexpected end of input" }, status: 400 },
      },
    }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    const region = async (name: string) => within(await screen.findByRole("region", { name }));
    expect(await (await region("Answer")).findByText("chart 1")).toBeTruthy();
    expect(await (await region("Quiet")).findByText("No data in this time range.")).toBeTruthy();
    const far = await region("Far");
    expect(await far.findByRole("heading", { name: "Source unreachable" })).toBeTruthy();
    expect(far.getByText(REFUSED)).toBeTruthy();
    expect(far.getByRole("button", { name: "Try again" })).toBeTruthy();
    const broken = await region("Broken");
    expect(await broken.findByRole("heading", { name: "Query error" })).toBeTruthy();
    expect(broken.getByText("parse error: unexpected end of input")).toBeTruthy();
    expect(screen.getByText(/^Updated \d\d:\d\d:\d\d$/)).toBeTruthy();
  });

  it("a failed refresh replaces the chart with the reason", async () => {
    const user = userEvent.setup();
    const api = shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    expect(await screen.findByText("chart 1")).toBeTruthy();
    api.state.queryAnswers.up = { error: { code: "unreachable", message: REFUSED }, status: 502 };
    await user.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(await screen.findByRole("heading", { name: "Source unreachable" })).toBeTruthy();
    expect(screen.queryByText("chart 1")).toBeNull();
    expect(screen.getByText(REFUSED)).toBeTruthy();
    // Try again runs it once more.
    api.state.queryAnswers.up = ok;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("chart 1")).toBeTruthy();
    notBody();
  });

  it("auto-refresh reads a new window on each tick, not while the page is hidden", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const api = shop();
      renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1", refresh: "10s" }) });
      expect(await screen.findByText("chart 1")).toBeTruthy();
      expect((screen.getByRole("combobox", { name: "Auto-refresh" }) as HTMLSelectElement).value).toBe("10s");
      const first = batches(api).length;
      act(() => { vi.advanceTimersByTime(10_000); });
      await waitFor(() => expect(batches(api).length).toBe(first + 1));
      expect(screen.getByText("chart 1")).toBeTruthy();
      const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      act(() => { vi.advanceTimersByTime(30_000); });
      await new Promise((r) => setTimeout(r, 30));
      expect(batches(api).length).toBe(first + 1);
      hidden.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a panel that fails while its chart has the keyboard hands it to the panel's title", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const api = shop();
      renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1", refresh: "10s" }) });
      const chart = await screen.findByRole("button", { name: "chart 1" });
      chart.focus();
      api.state.queryAnswers.up = { error: { code: "unreachable", message: REFUSED }, status: 502 };
      act(() => { vi.advanceTimersByTime(10_000); });
      expect(await screen.findByRole("heading", { name: "Source unreachable" })).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Requests" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("focusing the window never sends the old window again", async () => {
    const api = shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    expect(await screen.findByText("chart 1")).toBeTruthy();
    const sent = batches(api).length;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 30));
    // Other reads (the tree, the dashboard) may refresh on focus; a panel's fixed window never does.
    expect(batches(api).length).toBe(sent);
    focusManager.setFocused(undefined);
  });

  it("with auto-refresh on, focusing the window after a missed tick reads a new window", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const api = shop();
      renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1", refresh: "10s" }) });
      expect(await screen.findByText("chart 1")).toBeTruthy();
      const first = batches(api)[0][0];
      const later = Date.now() + 61_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(later);
      act(() => { focusManager.setFocused(true); window.dispatchEvent(new Event("focus")); });
      await waitFor(() => expect(batches(api).length).toBe(2));
      expect(batches(api)[1][0].start).toBeGreaterThan(first.start as number);
      clock.mockRestore();
      focusManager.setFocused(undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it("while panels load the page says Updating…, then when they were read", async () => {
    const user = userEvent.setup();
    shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    expect(await screen.findByText("chart 1")).toBeTruthy();
    expect(screen.getByText(/^Updated \d\d:\d\d:\d\d$/)).toBeTruthy();
    const held = gate();
    intercept((url, pass) => (url.endsWith("/query/batch") ? held.opened.then(pass) : null));
    await user.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(await screen.findByText("Updating…")).toBeTruthy();
    held.open();
    expect(await screen.findByText(/^Updated \d\d:\d\d:\d\d$/)).toBeTruthy();
  });

  it("a project that can't be read says why, and Try again reads it", async () => {
    const user = userEvent.setup();
    shop();
    let broken = true;
    intercept((url) => (broken && url === "/api/monitoring/projects/p1"
      ? Promise.resolve(new Response(JSON.stringify({ detail: "The project couldn't be read." }), { status: 500 }))
      : null));
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    expect((await screen.findByRole("alert")).textContent).toContain("The project couldn't be read.");
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByRole("region", { name: "Requests" })).toBeNull();
    broken = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("chart 1")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    notBody();
  });

  it("a group whose projects can't be read says why, and Try again reads them", async () => {
    const user = userEvent.setup();
    const g: GroupOut = { id: "g1", name: "Everything", project_ids: ["p1", "p2"], created_at: "", updated_at: "" };
    installFakeMonitoringApi({
      projects: [linkedProject("p1", "Dev", "s1"), linkedProject("p2", "Stage", "s1")],
      groups: [g],
      dashboards: { d1: seedDashboard("d1", { kind: "group", id: "g1", name: "Everything" }, spec("Fleet", [panel("p-1", "Up", "up")])) },
      queryAnswers: { up: ok },
    }, fallback);
    let broken = true;
    intercept((url) => (broken && url === "/api/monitoring/projects"
      ? Promise.resolve(new Response(JSON.stringify({ detail: "The projects couldn't be read." }), { status: 500 }))
      : null));
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    expect((await screen.findByRole("alert")).textContent).toContain("The projects couldn't be read.");
    expect(screen.queryByRole("button", { name: /^Projects:/ })).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
    broken = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("chart 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Projects: All" })).toBeTruthy();
    notBody();
  });

  it("a group dashboard runs per project and narrows by Projects", async () => {
    const user = userEvent.setup();
    const g: GroupOut = { id: "g1", name: "Everything", project_ids: ["p1", "p2"], created_at: "", updated_at: "" };
    const api = installFakeMonitoringApi({
      projects: [linkedProject("p1", "Dev", "s1"), linkedProject("p2", "Stage", "s1")],
      groups: [g],
      dashboards: { d1: seedDashboard("d1", { kind: "group", id: "g1", name: "Everything" }, spec("Fleet", [panel("p-1", "Up", "up")])) },
      queryAnswers: { up: ok },
    }, fallback);
    const { current } = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    await waitFor(() => expect(batches(api).length).toBe(1));
    expect(batches(api)[0].map((q) => q.project_id)).toEqual(["p1", "p2"]);
    expect(await screen.findByText("chart 2")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Projects: All" }));
    await user.click(screen.getByRole("checkbox", { name: "Stage" }));
    await waitFor(() => expect(batches(api).length).toBe(2));
    expect(batches(api)[1].map((q) => q.project_id)).toEqual(["p1"]);
    expect(current().tabs[0].view).toMatchObject({ vars: { __projects: ["p1"] } });
    expect(screen.getByRole("button", { name: "Projects: Dev" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: "Stage" }));
  });

  it("ready-made views offer Copy to edit and show their notes", async () => {
    const user = userEvent.setup();
    const id = "ready:p1:pods";
    const ready: ReadyMadeOut = {
      key: "pods", id, title: "Pod health", description: "Pods", missing: [], checked: true, check_message: null,
      notes: ["Restarts need kube-state-metrics; this Prometheus doesn't have it."],
    };
    const api = installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      dashboards: { [id]: seedDashboard(id, SHOP, spec("Pod health", [panel("p-1", "Pods", "up")]), true) },
      readyMade: { p1: [ready] },
      queryAnswers: { up: ok },
    }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id }) });
    expect(await screen.findByRole("heading", { level: 1, name: "Pod health" })).toBeTruthy();
    expect(screen.getByText("Ready-made")).toBeTruthy();
    expect(screen.getByText("Ready-made views are generated from what Shop's Prometheus has. Copy one to change it.")).toBeTruthy();
    expect(await screen.findByText(ready.notes[0])).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy to edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(screen.getByRole("tablist", { name: "Dashboard views" })).getAllByRole("tab").map((t) => t.textContent))
      .toEqual(["Dashboard", "JSON"]);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Copy dashboard…"]);
    await user.keyboard("{Escape}");
    notBody();
    expect(api.requests.some((r) => r.url.includes("/versions"))).toBe(false);
  });

  it("a dashboard that no longer exists offers Go to Home", async () => {
    shop();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "gone" }) });
    expect(await screen.findByText("This dashboard no longer exists.")).toBeTruthy();
    const home = screen.getByRole("button", { name: "Go to Home" });
    await waitFor(() => expect(document.activeElement).toBe(home));
    fireEvent.click(home);
    expect(await screen.findByRole("heading", { name: "Monitoring" })).toBeTruthy();
  });
});
