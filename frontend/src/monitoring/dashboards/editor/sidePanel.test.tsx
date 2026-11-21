import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupOut } from "../../api/types";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import type { DashboardSpec, PanelSpec } from "../schema";
import { editSessions } from "./useDashboardEditor";

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

const batches = (api: FakeMonitoringApi) => api.requests.filter((r) => r.url === "/api/monitoring/query/batch");
const panels = () => screen.getByRole("group", { name: "Panels" });
const tile = (title: string) => {
  const found = within(panels()).getAllByRole("region").find((t) => t.getAttribute("aria-label")?.startsWith(`${title},`));
  if (!found) throw new Error(`no tile ${title}`);
  return found;
};
const draftPanel = (id: string): PanelSpec => {
  const s = editSessions.get("start0");
  if (s?.mode !== "edit") throw new Error("not editing");
  return s.draft.panels.find((p) => p.id === id)!;
};
const settings = () => screen.getByRole("complementary", { name: "Panel settings" });
const tabNamed = (name: string) => within(settings()).getByRole("tab", { name });

async function editing(api = shop()) {
  const user = userEvent.setup();
  const app = renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
  const title = await screen.findByRole("heading", { level: 1 });
  await waitFor(() => expect(document.activeElement).toBe(title));
  await screen.findAllByText(/^chart /);
  await user.keyboard("e");
  await screen.findByRole("button", { name: "Save dashboard" });
  return { user, api, app };
}

/** Edit mode with the first tile's settings open (Enter on it). */
async function openSettings(api?: FakeMonitoringApi) {
  const out = await editing(api);
  await out.user.keyboard("{Enter}");
  await screen.findByRole("complementary", { name: "Panel settings" });
  return out;
}

describe("The panel side panel", () => {
  it("Enter on a tile opens settings on Query", async () => {
    const { user } = await editing();
    expect(document.activeElement).toBe(tile("Requests"));
    await user.keyboard("{Enter}");
    const aside = settings();
    expect(within(aside).getByRole("heading", { name: "Requests" })).toBeTruthy();
    expect(within(aside).getByRole("button", { name: "Close panel settings" })).toBeTruthy();
    const tablist = within(aside).getByRole("tablist", { name: "Panel settings" });
    expect(within(tablist).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Query", "Chart", "Options", "Alert"]);
    const query = tabNamed("Query");
    expect(document.activeElement).toBe(query);
    expect(query.getAttribute("aria-selected")).toBe("true");
    // ←/→ move between tabs; the keyboard stays on the tabs.
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tabNamed("Chart"));
    expect(tabNamed("Chart").getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tabNamed("Query"));
    // A project dashboard: its first source of each type that exists, then each linked source.
    const source = within(aside).getByRole("combobox", { name: "Source" });
    expect(within(source).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "First Prometheus-compatible source (s1 name)",
      "s1 name",
    ]);
    expect(within(aside).getByRole("textbox", { name: "Query A" })).toBeTruthy();
    expect(within(aside).getByText("Ctrl+Enter runs it now.")).toBeTruthy();
    // One query: nothing to remove.
    expect(within(aside).queryByRole("button", { name: /Remove query/ })).toBeNull();
    // The tile keeps its selection highlight.
    expect(tile("Requests").hasAttribute("data-selected")).toBe(true);
  });

  it("Esc closes settings and returns to the tile", async () => {
    const { user } = await openSettings();
    await user.click(within(settings()).getByRole("textbox", { name: "Query A" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Panel settings" })).toBeNull();
    expect(document.activeElement).toBe(tile("Requests"));
    expect(tile("Requests").hasAttribute("data-selected")).toBe(true);
    expect(screen.getByText("Editing")).toBeTruthy();

    // Esc on the tile while its settings are open closes them first, then goes to Save dashboard.
    await user.keyboard("{Enter}");
    settings();
    tile("Requests").focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Panel settings" })).toBeNull();
    expect(document.activeElement).toBe(tile("Requests"));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save dashboard" }));

    // The close button returns to the tile too.
    tile("Requests").focus();
    await user.keyboard("{Enter}");
    await user.click(within(settings()).getByRole("button", { name: "Close panel settings" }));
    expect(document.activeElement).toBe(tile("Requests"));
  });

  it("group source choices are per project", async () => {
    const g: GroupOut = { id: "g1", name: "Everything", project_ids: ["p1", "p2"], created_at: "", updated_at: "" };
    const api = installFakeMonitoringApi({
      projects: [linkedProject("p1", "Dev", "s1"), linkedProject("p2", "Stage", "s1")],
      groups: [g],
      dashboards: { d1: seedDashboard("d1", { kind: "group", id: "g1", name: "Everything" }, spec("Fleet", [panel("p-1", "Up", "up")])) },
      queryAnswers: { up: ok, "up2": ok },
    }, async () => json([]));
    const { user } = await openSettings(api);
    const source = within(settings()).getByRole("combobox", { name: "Source" });
    expect(within(source).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Each project's Prometheus-compatible source",
      "Each project's Loki source",
    ]);
    // A query edit runs on each project, with its project.
    const field = within(settings()).getByRole("textbox", { name: "Query A" });
    await user.click(field);
    await user.keyboard("{End}2{Control>}{Enter}{/Control}");
    await waitFor(() => expect(batches(api).at(-1)?.body).toMatchObject({ queries: [{ query: "up2", project_id: "p1" }, { query: "up2", project_id: "p2" }] }));
  });

  it("changing type keeps queries and unit", async () => {
    const { user } = await openSettings();
    const before = draftPanel("p-1");
    await user.click(tabNamed("Options"));
    await user.selectOptions(within(settings()).getByRole("combobox", { name: "Unit" }), "Seconds");
    await user.selectOptions(within(settings()).getByRole("combobox", { name: "Decimals" }), "2");
    await user.type(within(settings()).getByRole("textbox", { name: "Min" }), "5");
    await user.selectOptions(within(settings()).getByRole("combobox", { name: "Legend" }), "Hide");
    await user.click(within(settings()).getByRole("button", { name: "+ Add threshold" }));
    await user.click(tabNamed("Chart"));
    await user.selectOptions(within(settings()).getByRole("combobox", { name: "Style" }), "Area");
    expect(draftPanel("p-1").options).toEqual({
      unit: "s", decimals: 2, thresholds: [{ value: 80, color: "warn" }], min: 5, max: null, legend: "hidden", style: "area",
    });
    const types = within(settings()).getByRole("radiogroup", { name: "Chart type" });
    expect(within(types).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Time series", "Stat", "Gauge", "Bar", "Table", "Logs"]);
    expect(within(types).getByRole("radio", { name: "Time series" }).getAttribute("aria-checked")).toBe("true");
    await user.click(within(types).getByRole("radio", { name: "Stat" }));
    const after = draftPanel("p-1");
    expect(after.type).toBe("stat");
    expect(after.queries).toEqual(before.queries);
    expect(after.title).toBe(before.title);
    expect(after.layout).toEqual(before.layout);
    // Kept: unit, decimals, thresholds. Gone: what a stat panel doesn't have (min, max, legend, style).
    expect(after.options).toEqual({ unit: "s", decimals: 2, thresholds: [{ value: 80, color: "warn" }], calc: "last", sparkline: true });
    expect(within(settings()).getByRole("combobox", { name: "Show" })).toBeTruthy();
    expect(within(settings()).getByRole("checkbox", { name: "Sparkline" })).toBeTruthy();
    // Arrows move and select.
    await user.keyboard("{ArrowRight}");
    expect(draftPanel("p-1").type).toBe("gauge");
    expect(document.activeElement).toBe(within(types).getByRole("radio", { name: "Gauge" }));
    // Back to a time series: the kept three survive the trip, the rest start from the defaults.
    await user.click(within(types).getByRole("radio", { name: "Time series" }));
    expect(draftPanel("p-1").options).toEqual({
      unit: "s", decimals: 2, thresholds: [{ value: 80, color: "warn" }], min: null, max: null, legend: "bottom", style: "lines",
    });
  });

  it("switching to Logs keeps only the first query", async () => {
    const { user } = await openSettings();
    await user.click(within(settings()).getByRole("button", { name: "+ Add query" }));
    await user.keyboard("rate(x)");
    expect(draftPanel("p-1").queries.map((q) => q.ref)).toEqual(["A", "B"]);
    const first = draftPanel("p-1").queries[0];
    await user.click(tabNamed("Chart"));
    await user.click(within(settings()).getByRole("radio", { name: "Logs" }));
    const logs = draftPanel("p-1");
    expect(logs.type).toBe("logs");
    expect(logs.queries).toEqual([first]);
    expect(logs.options).toEqual({ limit: 100, wrap: true, order: "newest" });
    await user.click(tabNamed("Query"));
    expect(within(settings()).queryByRole("textbox", { name: "Query B" })).toBeNull();
  });

  it("logs with Prometheus says to pick Loki", async () => {
    const { user } = await openSettings();
    await user.click(tabNamed("Chart"));
    await user.click(within(settings()).getByRole("radio", { name: "Logs" }));
    expect(within(settings()).getByText("A logs panel needs a Loki query. Pick a Loki source in Query.")).toBeTruthy();
    expect(within(settings()).getByRole("textbox", { name: "Lines" })).toBeTruthy();
    expect(within(settings()).getByRole("checkbox", { name: "Wrap long lines" })).toBeTruthy();
    expect(within(settings()).getByRole("combobox", { name: "Order" })).toBeTruthy();
    // Logs panels take one query.
    await user.click(tabNamed("Query"));
    expect(within(settings()).queryByRole("button", { name: "+ Add query" })).toBeNull();
  });

  it("an invalid number leaves the draft as it was", async () => {
    const { user } = await openSettings();
    await user.click(tabNamed("Options"));
    const min = within(settings()).getByRole("textbox", { name: "Min" });
    expect(min.getAttribute("placeholder")).toBe("Auto");
    await user.type(min, "abc");
    expect(within(settings()).getByText("Use a number.")).toBeTruthy();
    expect(min.getAttribute("aria-invalid")).toBe("true");
    expect((draftPanel("p-1").options as { min: number | null }).min).toBeNull();
    await user.clear(min);
    await user.type(min, "12");
    expect((draftPanel("p-1").options as { min: number | null }).min).toBe(12);
    expect(within(settings()).queryByText("Use a number.")).toBeNull();
    // Thresholds: a row, then its removal moves the keyboard to a neighbour.
    await user.click(within(settings()).getByRole("button", { name: "+ Add threshold" }));
    const value = within(settings()).getByRole("textbox", { name: "Threshold 1 value" });
    expect(document.activeElement).toBe(value);
    fireEvent.change(value, { target: { value: "Infinity" } });
    expect(within(settings()).getByText("Use a number.")).toBeTruthy();
    expect((draftPanel("p-1").options as { thresholds: unknown[] }).thresholds).toHaveLength(1);
    expect(Number.isFinite((draftPanel("p-1").options as { thresholds: { value: number }[] }).thresholds[0].value)).toBe(true);
    await user.click(within(settings()).getByRole("button", { name: "Remove threshold 1" }));
    expect((draftPanel("p-1").options as { thresholds: unknown[] }).thresholds).toHaveLength(0);
    expect(document.activeElement).toBe(within(settings()).getByRole("button", { name: "+ Add threshold" }));
  });

  it("removing a query moves the keyboard to its neighbour", async () => {
    const { user } = await openSettings();
    await user.click(within(settings()).getByRole("button", { name: "+ Add query" }));
    const b = within(settings()).getByRole("textbox", { name: "Query B" });
    expect(document.activeElement).toBe(b);
    await user.click(within(settings()).getByRole("button", { name: "Remove query B" }));
    expect(document.activeElement).toBe(within(settings()).getByRole("textbox", { name: "Query A" }));
    expect(draftPanel("p-1").queries.map((q) => q.ref)).toEqual(["A"]);
  });

  it("the Alert tab says when alerts arrive", async () => {
    const { user } = await openSettings();
    await user.click(tabNamed("Alert"));
    const panel = within(settings()).getByRole("tabpanel");
    expect(panel.textContent).toBe("Alerts arrive in a later update, together with the Alerts page.");
    expect(within(panel).queryAllByRole("button")).toHaveLength(0);
    expect(document.activeElement).toBe(tabNamed("Alert"));
  });
});
