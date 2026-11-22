import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GroupOut } from "../api/types";
import { metric, source, catalogOf } from "../catalog/fixtures";
import type { CatalogOut } from "../catalog/api";
import { JSON_FIRST, type EditingState } from "../dashboards/editor/editorState";
import { editSessions } from "../dashboards/editor/useDashboardEditor";
import type { DashboardSpec, OwnerKind } from "../dashboards/schema";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec } from "../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../test/renderMonitoringApp";
import { buildFinderIndex, findPanels } from "./finder";
import { CAT } from "./testCatalogs";

// The chart chunk as a stub (panels and previews).
vi.mock("../charts", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`),
    MiniChart: () => createElement("span", null, "mini chart"),
  };
});

// CodeMirror doesn't run in jsdom: the JSON editor is a textarea.
vi.mock("../../features/actions/lazyCodeMirror", () => ({
  loadCodeMirror: () => Promise.resolve({
    mergeView: () => ({ destroy: () => {} }),
    editor: (parent: HTMLElement, doc: string, onChange: (text: string) => void, label: string) => {
      const area = document.createElement("textarea");
      area.value = doc;
      area.setAttribute("aria-label", label);
      area.addEventListener("input", () => onChange(area.value));
      parent.append(area);
      return { focus: () => area.focus(), destroy: () => area.remove() };
    },
  }),
}));

beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };

/** The finder tests' catalog as the server would send it for one project. */
const shopCatalog = (projectId: string): CatalogOut => catalogOf(projectId, source("s1", {
  built_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  metrics: CAT.metrics.map((m) => metric(m.name, { type: m.type, labels: m.labels, series: m.series, family: m.family })),
}));
const ERRORS_BY_ROUTE = findPanels(buildFinderIndex(CAT), "errors by route")[0];

const doc = (): DashboardSpec => spec("API latency", [
  panel("p-1", "Requests", "up", { x: 0, y: 0, w: 12, h: 8 }),
]);

function shop(owner: { kind: OwnerKind; id: string; name: string } = { kind: "project", id: "p1", name: "Shop" }, groups: GroupOut[] = []) {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1"), linkedProject("p2", "Stage", "s1")],
    groups,
    catalogs: { p1: shopCatalog("p1"), p2: shopCatalog("p2") },
    dashboards: { d1: seedDashboard("d1", owner, doc()) },
    queryAnswers: { up: ok },
  }, async () => json([]));
}

const panels = () => screen.getByRole("group", { name: "Panels" });
const tile = (title: string) => {
  const found = within(panels()).getAllByRole("region").find((t) => t.getAttribute("aria-label")?.startsWith(`${title},`));
  if (!found) throw new Error(`no tile ${title}`);
  return found;
};
const dialog = () => screen.getByRole("dialog", { name: "Add panel" });
const input = () => within(dialog()).getByRole("combobox", { name: "What do you want to see" });
const options = () => within(within(dialog()).getByRole("listbox", { name: "Results" })).getAllByRole("option");
const active = () => document.getElementById(input().getAttribute("aria-activedescendant") ?? "");
const draft = (): EditingState => {
  const s = [...editSessions.values()].find((x) => x.mode === "edit");
  if (!s || s.mode !== "edit") throw new Error("not editing");
  return s;
};
const notBody = () => expect(document.activeElement).not.toBe(document.body);
const grid = () => panels().parentElement!.querySelector<HTMLElement>('[role="status"][aria-live="polite"]')!;

async function editing(api: FakeMonitoringApi = shop()) {
  const user = userEvent.setup();
  renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
  const title = await screen.findByRole("heading", { level: 1, name: "API latency" });
  await waitFor(() => expect(document.activeElement).toBe(title));
  await user.keyboard("e");
  await screen.findByRole("button", { name: "Save dashboard" });
  await waitFor(() => expect(document.activeElement).toBe(tile("Requests")));
  return { user, api };
}

async function opened(api?: FakeMonitoringApi) {
  const ctx = await editing(api);
  await ctx.user.keyboard("a");
  await waitFor(() => expect(document.activeElement).toBe(input()));
  return ctx;
}

async function typed(text: string, api?: FakeMonitoringApi) {
  const ctx = await opened(api);
  await ctx.user.keyboard(text);
  await waitFor(() => expect(options()[0].textContent).toContain(ERRORS_BY_ROUTE.title));
  return ctx;
}

describe("Add panel search", () => {
  it("a opens Add panel with focus in the input and suggestions listed", async () => {
    await opened();
    expect(input().getAttribute("placeholder")).toBe("Type what you want to see, like errors by route");
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    // With no text: the suggestions under their heading, then Empty panel last.
    expect(await within(dialog()).findByText("Suggested for Shop · from what Prometheus have")).toBeTruthy();
    const list = options();
    expect(list.length).toBeGreaterThan(1);
    expect(list.at(-1)!.textContent).toContain("Empty panel");
    expect(list.at(-1)!.textContent).toContain("Write the query yourself.");
    expect(input().getAttribute("aria-controls")).toBe(within(dialog()).getByRole("listbox").id);
    expect(active()).toBe(list[0]);
    expect(list[0].getAttribute("aria-selected")).toBe("true");
    expect(within(dialog()).getByText("Enter adds the first")).toBeTruthy();
    expect(within(dialog()).getByText("Known metrics from 5 min ago")).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Refresh list" })).toBeTruthy();
  });

  it("typing finds results and the first is active", async () => {
    await typed("errors by route");
    const list = options();
    expect(list[0].textContent).toContain("Http requests errors per second by route");
    expect(active()).toBe(list[0]);
    expect(within(dialog()).getByText("Enter adds the first")).toBeTruthy();
    expect(within(list[0]).getByText("Enter to add")).toBeTruthy();
    expect(list.at(-1)!.textContent).toContain("Empty panel");
  });

  it("arrows move the active result and the hint follows", async () => {
    const { user } = await typed("errors by route");
    const list = options();
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(list[1]);
    expect(list[1].getAttribute("aria-selected")).toBe("true");
    expect(list[0].getAttribute("aria-selected")).toBe("false");
    expect(within(dialog()).getByText("Enter adds the highlighted one")).toBeTruthy();
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe(list[0]);
    expect(within(dialog()).getByText("Enter adds the first")).toBeTruthy();
    // Wrapping: up from the first is Empty panel, down from there is the first again.
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe(list.at(-1));
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(list[0]);
    expect(document.activeElement).toBe(input());
  });

  it("Enter adds the active result to the draft and focuses the new tile", async () => {
    const { user } = await typed("errors by route");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add panel" })).toBeNull());
    const added = draft().draft.panels.at(-1)!;
    expect(added.title).toBe("Http requests errors per second by route");
    expect(added.queries[0].expr).toBe(ERRORS_BY_ROUTE.expr);
    expect(added.queries[0].source).toEqual({ type: "prometheus", id: "s1" });
    expect(draft().selected).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(tile("Http requests errors per second by route")));
    notBody();
    expect(grid().textContent).toBe('Added "Http requests errors per second by route". Enter opens its settings.');
    // Enter on it opens its settings.
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("complementary", { name: "Panel settings" })).toBeTruthy();
  });

  it("Ctrl+End then Enter adds an empty panel and focuses Query A", async () => {
    const { user } = await typed("errors by route");
    await user.keyboard("{Control>}{End}{/Control}");
    expect(active()).toBe(options().at(-1));
    expect(within(dialog()).getByText("Enter adds the highlighted one")).toBeTruthy();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add panel" })).toBeNull());
    expect(tile("New panel").getAttribute("aria-label")).toBe("New panel, 12 by 8, column 13, row 1");
    const field = await screen.findByRole("textbox", { name: "Query A" });
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(screen.getByRole("complementary", { name: "Panel settings" })).toBeTruthy();
  });

  it("Esc clears, then closes back to the tile", async () => {
    const { user } = await editing();
    await user.click(screen.getByRole("button", { name: "Add panel" }));
    await waitFor(() => expect(document.activeElement).toBe(input()));
    await user.keyboard("errors");
    await user.keyboard("{Escape}");
    expect(input()).toHaveProperty("value", "");
    expect(screen.getByRole("dialog", { name: "Add panel" })).toBeTruthy();
    expect(document.activeElement).toBe(input());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Add panel" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add panel" }));
    // After `a`, Esc goes back to the panel tile that had the keyboard.
    tile("Requests").focus();
    await user.keyboard("a");
    await waitFor(() => expect(document.activeElement).toBe(input()));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(tile("Requests"));
    expect(draft().draft.panels).toHaveLength(1);
  });

  it("nothing matches says so and keeps Empty panel", async () => {
    const { user } = await opened();
    await user.keyboard("zzqx");
    expect(await within(dialog()).findByText("Nothing matches yet. Try another word.")).toBeTruthy();
    const list = options();
    expect(list).toHaveLength(1);
    expect(list[0].textContent).toContain("Empty panel");
    expect(active()).toBe(list[0]);
  });

  it("a group dashboard adds a panel with a null source", async () => {
    const g: GroupOut = { id: "g1", name: "Everything", project_ids: ["p1", "p2"], created_at: "", updated_at: "" };
    const api = shop({ kind: "group", id: "g1", name: "Everything" }, [g]);
    const { user } = await typed("errors by route", api);
    // Each member's catalog is read on its own.
    const reads = api.requests.filter((r) => r.url.includes("/catalog")).map((r) => r.url.split("?")[0]);
    expect(new Set(reads)).toEqual(new Set(["/api/monitoring/projects/p1/catalog", "/api/monitoring/projects/p2/catalog"]));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add panel" })).toBeNull());
    expect(draft().draft.panels.at(-1)!.queries[0].source).toEqual({ type: "prometheus", id: null });
    // Previews ran per project, each with its project.
    const previews = api.requests.filter((r) => r.url === "/api/monitoring/query/batch")
      .flatMap((r) => (r.body as { queries: { project_id: string; query: string }[] }).queries)
      .filter((q) => q.query !== "up");
    expect(previews.length).toBeGreaterThan(0);
    expect(previews.every((q) => q.project_id === "p1" || q.project_id === "p2")).toBe(true);
  });

  it("Refresh list asks for a fresh catalog", async () => {
    const { user, api } = await opened();
    await within(dialog()).findByText("Known metrics from 5 min ago");
    await user.click(within(dialog()).getByRole("button", { name: "Refresh list" }));
    await waitFor(() => expect(api.requests.some((r) => r.url === "/api/monitoring/projects/p1/catalog?refresh=true")).toBe(true));
    expect(screen.getByRole("dialog", { name: "Add panel" })).toBeTruthy();
  });

  it("insertPanel is refused while the JSON text doesn't apply", async () => {
    const { user } = await editing();
    await user.click(screen.getByRole("tab", { name: "JSON" }));
    const area = await screen.findByRole("textbox", { name: "Dashboard JSON" }) as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: "{ nope" } });
    await waitFor(() => expect(screen.getByTestId("json-state").textContent).toMatch(/^✗/));
    await user.click(screen.getByRole("tab", { name: "Dashboard" }));
    tile("Requests").focus();
    await user.keyboard("a");
    await waitFor(() => expect(document.activeElement).toBe(input()));
    await user.keyboard("errors by route");
    await waitFor(() => expect(options()[0].textContent).toContain(ERRORS_BY_ROUTE.title));
    await user.keyboard("{Enter}");
    // The search stays open, nothing is added, and the grid says why.
    expect(screen.getByRole("dialog", { name: "Add panel" })).toBeTruthy();
    expect(draft().draft.panels).toHaveLength(1);
    expect(grid().textContent).toBe(JSON_FIRST);
    expect(document.activeElement).toBe(input());
  });
});
