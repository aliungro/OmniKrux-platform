import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryResponse } from "../api/types";
import { writeDraft } from "../dashboards/drafts/draftStore";
import { editSessions } from "../dashboards/editor/useDashboardEditor";
import { editorReducer, VIEW } from "../dashboards/editor/editorState";
import type { DashboardSpec } from "../dashboards/schema";
import { linkedProject, linkTo, panel, seedDashboard, spec } from "../test/dashboardSeeds";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import type { ExploreView } from "../shell/tabState";
import { readTrail } from "./trailStore";

vi.mock("../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", { "data-chart": "" }, `chart ${data.series.length}`) };
});

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const one: Partial<QueryResponse> = { result_type: "matrix", series: [{ labels: { job: "a" }, points: [[1, 1], [2, 2]] }], took_ms: 7 };
const owner = { kind: "project" as const, id: "p1", name: "Shop" };

function shop(dashboards: Record<string, ReturnType<typeof seedDashboard>> = {}, project = linkedProject("p1", "Shop", "s1")): FakeMonitoringApi {
  return installFakeMonitoringApi({ projects: [project], dashboards, queryAnswers: new Proxy({}, { get: () => one }) }, async () => json([]));
}

async function openExplore(view: ExploreView = { page: "explore", project: "p1", expr: "up" }) {
  const result = renderMonitoringApp({ tabs: tabsWith(view) });
  const heading = await screen.findByRole("heading", { level: 1, name: "Explore" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  return result;
}
const addButton = () => screen.getByRole("button", { name: "Add to dashboard" });
const puts = (api: FakeMonitoringApi) => api.requests.filter((r) => r.method === "PUT");
const latency = (): DashboardSpec => spec("API latency", [panel("p-1", "Latency", "up")]);

describe("Add to dashboard", () => {
  it("a opens the dialog with focus on Dashboard", async () => {
    shop({ d1: seedDashboard("d1", owner, latency()) });
    await openExplore();
    await screen.findByText("chart 1");
    const user = userEvent.setup();
    await user.keyboard("a");
    const box = await screen.findByRole("dialog", { name: "Add to dashboard" });
    const select = within(box).getByRole("combobox", { name: "Dashboard" }) as HTMLSelectElement;
    expect(document.activeElement).toBe(select);
    expect(within(select).getAllByRole("option")[0].textContent).toBe("New dashboard in Shop…");
    await waitFor(() => expect(within(select).getByRole("option", { name: "API latency" })).toBeTruthy());
    expect(within(box).getByRole("textbox", { name: "Title" })).toHaveProperty("value", "Targets up");
    expect(within(box).getByRole("textbox", { name: "Panel title" })).toHaveProperty("value", "Targets up");
    const chart = within(box).getByRole("combobox", { name: "Chart" }) as HTMLSelectElement;
    expect(chart.value).toBe("timeseries");
    expect(within(chart).getAllByRole("option").map((o) => o.textContent)).toEqual(["Time series", "Stat", "Bar", "Table"]);
    expect(within(box).getByRole("button", { name: "Cancel" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(addButton());
  });

  it("Ctrl+Enter adds and returns focus to the button with the status", async () => {
    const api = shop({ d1: seedDashboard("d1", owner, latency()) });
    await openExplore();
    await screen.findByText("chart 1");
    // The status region is there from the start, empty: nothing settles in on page load.
    // Its own row under the header (Task 25), so the header never reflows.
    const status = document.querySelector<HTMLElement>('[data-explore-added] [role="status"]')!;
    expect(status.childElementCount).toBe(0);
    const user = userEvent.setup();
    fireEvent.click(addButton());
    const select = await within(await screen.findByRole("dialog")).findByRole("combobox", { name: "Dashboard" }) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByRole("option", { name: "API latency" })).toBeTruthy());
    await user.selectOptions(select, "d1");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(addButton());
    expect(screen.getByText('Added to "API latency".').closest('[role="status"]')).toBe(status);
    // The message is the region's one child, which carries the settle animation.
    expect(status.childElementCount).toBe(1);
    expect(status.firstElementChild!.className).toMatch(/addMessage/);
    expect(screen.getByText('Added to "API latency".')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open dashboard" })).toBeTruthy();
    expect(puts(api)).toHaveLength(1);
    const body = puts(api)[0].body as { origin: string; spec: DashboardSpec };
    expect(body.origin).toBe("explore");
    expect(body.spec.panels.map((p) => p.title)).toEqual(["Latency", "Targets up"]);
    expect(body.spec.panels[1].queries[0]).toMatchObject({ expr: "up", source: { type: "prometheus", id: "s1" } });
    expect(readTrail("p1").map((e) => e.expr)).toContain("up");
  });

  it("a failure stays under the select with the keyboard on it", async () => {
    const api = shop({ d1: seedDashboard("d1", owner, latency()) });
    await openExplore();
    await screen.findByText("chart 1");
    const user = userEvent.setup();
    fireEvent.click(addButton());
    const box = await screen.findByRole("dialog");
    const select = within(box).getByRole("combobox", { name: "Dashboard" }) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByRole("option", { name: "API latency" })).toBeTruthy());
    await user.selectOptions(select, "d1");
    delete api.state.dashboards.d1;
    await user.click(within(box).getByRole("button", { name: "Add panel" }));
    const alert = await within(box).findByRole("alert");
    expect(alert.textContent).toBe("That dashboard no longer exists.");
    expect(document.activeElement).toBe(alert);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("a draft on the target is mentioned", async () => {
    shop({ d1: seedDashboard("d1", owner, latency()) });
    writeDraft({ v: 1, dashboardId: "d1", baseVersion: 1, savedAt: 1, draft: spec("API latency", [panel("p-1", "Latency", "up"), panel("p-2", "Mine", "x")]), jsonText: null, writer: "w1" });
    await openExplore();
    await screen.findByText("chart 1");
    const user = userEvent.setup();
    fireEvent.click(addButton());
    const box = await screen.findByRole("dialog");
    const select = within(box).getByRole("combobox", { name: "Dashboard" }) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByRole("option", { name: "API latency" })).toBeTruthy());
    expect(within(box).queryByText(/unsaved changes to this dashboard/)).toBeNull();
    await user.selectOptions(select, "d1");
    expect(within(box).getByText("You have unsaved changes to this dashboard in this browser. The panel is saved now; saving your draft later asks you to review the differences.")).toBeTruthy();
  });

  it("log queries default to the Logs chart", async () => {
    shop({}, { ...seedProject("p1", "Shop"), links: [linkTo("s2", "loki")] });
    await openExplore({ page: "explore", project: "p1", source: "s2", expr: '{job="api"}' });
    const user = userEvent.setup();
    await waitFor(() => expect(addButton().getAttribute("aria-disabled")).toBeNull());
    await user.keyboard("a");
    const box = await screen.findByRole("dialog");
    const chart = within(box).getByRole("combobox", { name: "Chart" }) as HTMLSelectElement;
    expect(chart.value).toBe("logs");
    expect(within(chart).getAllByRole("option").map((o) => o.textContent)).toEqual(["Logs"]);
    expect(within(box).getByRole("textbox", { name: "Panel title" })).toHaveProperty("value", 'Logs from {job="api"}');
  });

  it("no query keeps the button disabled with the reason", async () => {
    shop();
    await openExplore({ page: "explore", project: "p1" });
    const button = await screen.findByRole("button", { name: "Add to dashboard" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("Run a query first.");
    fireEvent.click(button);
    await userEvent.setup().keyboard("a");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a live edit session with unsaved work on the target is mentioned", async () => {
    shop({ d1: seedDashboard("d1", owner, latency()) });
    const started = editorReducer(VIEW, { type: "start", dashboardId: "d1", version: 1, spec: latency() });
    expect(started.mode).toBe("edit");
    const edited = { ...started, draft: spec("API latency", [panel("p-1", "Latency", "up"), panel("p-2", "Mine", "x")]) } as typeof started;
    editSessions.set("start1", edited);
    try {
      // The session belongs to a second tab (a tab that is gone takes its session with it).
      renderMonitoringApp({ tabs: tabsWith({ page: "explore", project: "p1", expr: "up" }, { page: "home" }) });
      await screen.findByRole("heading", { level: 1, name: "Explore" });
      await screen.findByText("chart 1");
      const user = userEvent.setup();
      fireEvent.click(addButton());
      const box = await screen.findByRole("dialog");
      const select = within(box).getByRole("combobox", { name: "Dashboard" }) as HTMLSelectElement;
      await waitFor(() => expect(within(select).getByRole("option", { name: "API latency" })).toBeTruthy());
      await user.selectOptions(select, "d1");
      expect(within(box).getByText(/You have unsaved changes to this dashboard in this browser\./)).toBeTruthy();
      // The session itself is never touched.
      expect(editSessions.get("start1")).toBe(edited);
    } finally {
      editSessions.delete("start1");
    }
  });

  it("a successful add makes the app read Monitoring again", async () => {
    const api = shop({ d1: seedDashboard("d1", owner, latency()) });
    await openExplore();
    await screen.findByText("chart 1");
    const user = userEvent.setup();
    fireEvent.click(addButton());
    const box = await screen.findByRole("dialog");
    const select = within(box).getByRole("combobox", { name: "Dashboard" }) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByRole("option", { name: "API latency" })).toBeTruthy());
    await user.selectOptions(select, "d1");
    const trees = () => api.requests.filter((r) => r.method === "GET" && r.url === "/api/monitoring/tree").length;
    const before = trees();
    await user.click(within(box).getByRole("button", { name: "Add panel" }));
    await waitFor(() => expect(puts(api)).toHaveLength(1));
    await waitFor(() => expect(trees()).toBeGreaterThan(before));
  });

  it("a new dashboard is made in one POST and avoids a taken title", async () => {
    const taken = seedDashboard("d1", owner, spec("Targets up", [panel("p-1", "Latency", "up")]));
    const api = shop({ d1: taken });
    await openExplore();
    await screen.findByText("chart 1");
    const user = userEvent.setup();
    fireEvent.click(addButton());
    const box = await screen.findByRole("dialog");
    const title = within(box).getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe("Targets up (2)"));
    await user.click(within(box).getByRole("button", { name: "Add panel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const posts = api.requests.filter((r) => r.method === "POST" && r.url === "/api/monitoring/dashboards");
    expect(posts).toHaveLength(1);
    expect(puts(api)).toHaveLength(0);
    const body = posts[0].body as { spec: DashboardSpec };
    expect(body.spec.title).toBe("Targets up (2)");
    expect(body.spec.panels.map((p) => p.title)).toEqual(["Targets up"]);
    expect(screen.getByText('Added to "Targets up (2)".')).toBeTruthy();
  });

  it("the dialog suggests a title from the query", async () => {
    shop();
    await openExplore({ page: "explore", project: "p1", expr: "sum(rate(http_requests_total[5m]))" });
    await screen.findByText("chart 1");
    fireEvent.click(addButton());
    let box = await screen.findByRole("dialog");
    expect(within(box).getByRole("textbox", { name: "Title" })).toHaveProperty("value", "HTTP requests");
    fireEvent.click(within(box).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // A query that names no metric: a plain new dashboard.
    fireEvent.change(screen.getByRole("textbox", { name: "Query" }), { target: { value: "vector(1)" } });
    await waitFor(() => expect(document.querySelector("[data-explore-meta]")?.textContent).toContain("1 series"));
    fireEvent.click(addButton());
    box = await screen.findByRole("dialog");
    expect(within(box).getByRole("textbox", { name: "Title" })).toHaveProperty("value", "New dashboard");
    cleanup();
    // A log query: its selector.
    shop({}, { ...seedProject("p1", "Shop"), links: [linkTo("s2", "loki")] });
    await openExplore({ page: "explore", project: "p1", source: "s2", expr: '{job="api"} |= "error"' });
    await waitFor(() => expect(addButton().getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(addButton());
    box = await screen.findByRole("dialog");
    expect(within(box).getByRole("textbox", { name: "Title" })).toHaveProperty("value", 'Logs from {job="api"}');
  });

  it("a query Explore marked invalid keeps the button disabled", async () => {
    installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      queryAnswers: { up: { error: { code: "bad_query", message: "parse error at 1:3" }, status: 400 } },
    }, async () => json([]));
    await openExplore();
    await waitFor(() => expect(document.querySelector("[data-explore-meta]")?.textContent).toContain("✗"));
    const button = addButton();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("Run a query first.");
    fireEvent.click(button);
    await userEvent.setup().keyboard("a");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the Added status", () => {
  it("animates its message, never the region that is there on page load", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ExplorePage.module.css"), "utf8");
    const rule = (name: string) => css.match(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule("addStatus")).not.toMatch(/animation/);
    expect(rule("addMessage")).toMatch(/animation:\s*settle/);
  });
});
