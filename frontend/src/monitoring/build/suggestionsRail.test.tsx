import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { metric, source, stream, catalogOf } from "../catalog/fixtures";
import type { CatalogOut } from "../catalog/api";
import { JSON_FIRST, type EditingState } from "../dashboards/editor/editorState";
import { editSessions } from "../dashboards/editor/useDashboardEditor";
import type { DashboardSpec } from "../dashboards/schema";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import { linkedProject, linkTo, panel, seedDashboard, spec } from "../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../test/renderMonitoringApp";
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

const shopCatalog = (projectId: string, metrics = CAT.metrics, streams = CAT.streams): CatalogOut => catalogOf(
  projectId,
  source("s1", {
    built_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    metrics: metrics.map((m) => metric(m.name, { type: m.type, labels: m.labels, series: m.series, family: m.family })),
  }),
  source("s2", {
    source_type: "loki", built_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    streams: streams.map((s) => stream(s.name, s.values)),
  }),
);

const HEADING = "Suggested for Shop · from what Prometheus and Loki have";

function shop(panels: DashboardSpec["panels"] = [], catalog: CatalogOut = shopCatalog("p1")) {
  return installFakeMonitoringApi({
    projects: [{ ...linkedProject("p1", "Shop", "s1"), links: [linkTo("s1"), linkTo("s2", "loki")] }],
    catalogs: { p1: catalog },
    dashboards: { d1: seedDashboard("d1", { kind: "project", id: "p1", name: "Shop" }, spec("API latency", panels)) },
    queryAnswers: { up: ok },
  }, async () => json([]));
}

const rail = () => screen.getByRole("complementary", { name: "Suggestions" });
const cards = () => within(within(rail()).getByRole("list", { name: "Suggested panels" })).getAllByRole("button");
const hide = () => within(rail()).getByRole("button", { name: "Hide suggestions" });
const addTile = () => screen.getByRole("button", { name: "Add panel" });
const live = () => within(rail()).getByRole("status");
const draft = (): EditingState => {
  const s = [...editSessions.values()].find((x) => x.mode === "edit");
  if (!s || s.mode !== "edit") throw new Error("not editing");
  return s;
};
const notBody = () => expect(document.activeElement).not.toBe(document.body);

async function editing(api: FakeMonitoringApi = shop()) {
  const user = userEvent.setup();
  renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
  const title = await screen.findByRole("heading", { level: 1, name: "API latency" });
  await waitFor(() => expect(document.activeElement).toBe(title));
  await user.keyboard("e");
  await screen.findByRole("button", { name: "Save dashboard" });
  return { user, api };
}

/** A new empty dashboard in edit mode with its suggestions loaded. */
async function loaded(api?: FakeMonitoringApi) {
  const ctx = await editing(api);
  await within(rail()).findByText(HEADING);
  await waitFor(() => expect(cards().length).toBeGreaterThan(1));
  return ctx;
}

describe("Suggestions rail", () => {
  it("a new empty dashboard opens with the suggestions rail", async () => {
    await loaded();
    expect(await within(rail()).findByRole("heading", { name: HEADING })).toBeTruthy();
    expect(cards()).toHaveLength(7);
    // The dashed board says what to do, with Add panel inside it.
    expect(screen.getByText("Your new dashboard")).toBeTruthy();
    expect(screen.getByText("Click a suggestion on the left; it flies into place.")).toBeTruthy();
    expect(addTile()).toBeTruthy();
    // Every card previews live, in one batch with each project.
    await waitFor(() => expect(within(rail()).queryAllByText("Loading�")).toHaveLength(0));
  });

  it("previews run as one batch with project ids", async () => {
    const api = await loaded().then((c) => c.api);
    await waitFor(() => expect(api.requests.some((r) => r.url === "/api/monitoring/query/batch")).toBe(true));
    const batches = api.requests.filter((r) => r.url === "/api/monitoring/query/batch");
    const items = batches.flatMap((r) => (r.body as { queries: { project_id: string }[] }).queries);
    expect(items.length).toBeGreaterThanOrEqual(7);
    expect(items.every((q) => q.project_id === "p1")).toBe(true);
    expect(batches).toHaveLength(1);
  });

  it("a dashboard with panels opens without the rail", async () => {
    await editing(shop([panel("p-1", "Requests", "up", { x: 0, y: 0, w: 12, h: 8 })]));
    expect(screen.queryByRole("complementary", { name: "Suggestions" })).toBeNull();
    expect(screen.queryByText("Your new dashboard")).toBeNull();
  });

  it("Enter on a suggestion adds it and moves to the next one", async () => {
    const { user } = await loaded();
    const [first, second] = cards();
    const title = first.querySelector("span")!.textContent!;
    first.focus();
    await user.keyboard("{Enter}");
    expect(draft().draft.panels).toHaveLength(1);
    expect(draft().draft.panels[0].title).toBe(title);
    expect(draft().selected).toBeNull();
    expect(first.getAttribute("aria-disabled")).toBe("true");
    expect(first.textContent).toContain("Added");
    expect(document.activeElement).toBe(second);
    expect(live().textContent).toBe(`Added "${title}" to the dashboard.`);
    // The board's words go once the dashboard has a panel.
    expect(screen.queryByText("Your new dashboard")).toBeNull();
    // An added card does nothing more.
    first.focus();
    await user.keyboard("{Enter}");
    expect(draft().draft.panels).toHaveLength(1);
  });

  it("clicking a suggestion adds it", async () => {
    const { user } = await loaded();
    const second = cards()[1];
    await user.click(second);
    expect(draft().draft.panels).toHaveLength(1);
    expect(second.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(cards()[2]);
    // The new tile is in the grid, found by its id.
    expect(document.querySelector(`[data-tile-id="${draft().draft.panels[0].id}"]`)).toBeTruthy();
  });

  it("an add flies a ghost to the tile", async () => {
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: () => {} }));
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    try {
      const { user } = await loaded();
      await user.click(cards()[0]);
      await waitFor(() => expect(animate).toHaveBeenCalled());
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate;
    }
  });

  it("reduced motion adds it without a ghost", async () => {
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: () => {} }));
    Element.prototype.animate = animate as unknown as typeof Element.prototype.animate;
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("prefers-reduced-motion"), media: q, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
    }));
    try {
      const { user } = await loaded();
      await user.click(cards()[0]);
      expect(draft().draft.panels).toHaveLength(1);
      expect(animate).not.toHaveBeenCalled();
      expect(document.body.querySelector("[class*='ghost']")).toBeNull();
      expect(document.activeElement).toBe(cards()[1]);
    } finally {
      delete (Element.prototype as { animate?: unknown }).animate;
    }
  });

  it("the last add moves focus to Hide suggestions", async () => {
    const { user } = await loaded();
    const all = cards();
    for (let i = 0; i < all.length; i++) await user.click(all[i]);
    expect(draft().draft.panels).toHaveLength(7);
    expect(document.activeElement).toBe(hide());
    notBody();
  });

  it("Hide suggestions closes the rail and returns focus to Add panel", async () => {
    const { user } = await loaded();
    await user.click(hide());
    expect(screen.queryByRole("complementary", { name: "Suggestions" })).toBeNull();
    expect(document.activeElement).toBe(addTile());
    expect(draft().suggestions).toBe("closed");
    expect(screen.queryByText("Your new dashboard")).toBeNull();
  });

  it("Esc on a suggestion returns focus to Add panel", async () => {
    const { user } = await loaded();
    cards()[2].focus();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(addTile());
    expect(screen.getByRole("complementary", { name: "Suggestions" })).toBeTruthy();
  });

  it("s goes to the first unused suggestion", async () => {
    const { user } = await loaded();
    await user.click(cards()[0]);
    addTile().focus();
    await user.keyboard("s");
    expect(document.activeElement).toBe(cards()[1]);
    // Never from a field.
    await user.click(screen.getByRole("tab", { name: "JSON" }));
    const area = await screen.findByRole("textbox", { name: "Dashboard JSON" }) as HTMLTextAreaElement;
    area.focus();
    await user.keyboard("s");
    expect(document.activeElement).toBe(area);
  });

  it("no suggestions says what to do instead", async () => {
    await editing(shop([], shopCatalog("p1", [], [])));
    expect(await within(rail()).findByText("No ready suggestions for what Shop's sources have. Use + Add panel to search, or write a query.")).toBeTruthy();
    expect(within(rail()).queryByRole("list", { name: "Suggested panels" })).toBeNull();
    expect(hide()).toBeTruthy();
  });

  it("says it is loading while the catalog loads", async () => {
    const api = shop();
    const { intercept, gate } = await import("../test/dashboardSeeds");
    const held = gate();
    intercept((url, pass) => (url.includes("/catalog") ? held.opened.then(pass) : null));
    await editing(api);
    expect(within(rail()).getByText("Loading suggestions…")).toBeTruthy();
    held.open();
    expect(await within(rail()).findByText(HEADING)).toBeTruthy();
  });

  it("a catalog that can't be read says why and Try again reads it", async () => {
    const api = shop();
    delete api.state.catalogs.p1;
    const { user } = await editing(api);
    expect((await within(rail()).findByText(/^Couldn't read the metrics: /)).textContent)
      .toBe("Couldn't read the metrics: That project no longer exists.");
    api.state.catalogs.p1 = shopCatalog("p1");
    await user.click(within(rail()).getByRole("button", { name: "Try again" }));
    expect(await within(rail()).findByText(HEADING)).toBeTruthy();
  });

  it("a rail add is refused while the JSON text doesn't apply", async () => {
    const { user } = await loaded();
    await user.click(screen.getByRole("tab", { name: "JSON" }));
    const area = await screen.findByRole("textbox", { name: "Dashboard JSON" }) as HTMLTextAreaElement;
    fireEvent.input(area, { target: { value: "{ nope" } });
    await waitFor(() => expect(screen.getByTestId("json-state").textContent).toMatch(/^✗/));
    await user.click(screen.getByRole("tab", { name: "Dashboard" }));
    const first = cards()[0];
    await user.click(first);
    expect(draft().draft.panels).toHaveLength(0);
    expect(first.getAttribute("aria-disabled")).toBeNull();
    expect(first.textContent).not.toContain("Added");
    expect(live().textContent).toBe(JSON_FIRST);
    const said = live().firstElementChild;
    await user.click(first);
    expect(live().textContent).toBe(JSON_FIRST);
    expect(live().firstElementChild).not.toBe(said);
    expect(draft().draft.panels).toHaveLength(0);
    // Closing the rail isn't a draft edit: it works while the JSON text is bad.
    await user.click(hide());
    expect(draft().suggestions).toBe("closed");
  });

  it("discard brings the cards back", async () => {
    const { user } = await loaded();
    await user.click(cards()[0]);
    expect(cards()[0].textContent).toContain("Added");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    const confirm = screen.queryByRole("button", { name: "Discard changes" });
    if (confirm) await user.click(confirm);
    await screen.findByRole("button", { name: "Edit" });
    await user.keyboard("e");
    await screen.findByRole("button", { name: "Save dashboard" });
    await within(rail()).findByText(HEADING);
    await waitFor(() => expect(cards().length).toBeGreaterThan(1));
    expect(cards().some((c) => c.textContent?.includes("Added"))).toBe(false);
    expect(draft().draft.panels).toHaveLength(0);
  });
});
