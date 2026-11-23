import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { catalogOf, metric, source } from "../catalog/fixtures";
import { JSON_FIRST } from "../dashboards/editor/editorState";
import { editSessions } from "../dashboards/editor/useDashboardEditor";
import type { ChartSeries, PanelData } from "../dashboards/runPanel";
import { newPanel, type PanelSpec } from "../dashboards/schema";
import { RATE_INTERVAL_FLOOR } from "../dashboards/interpolate";
import { durationText } from "../dashboards/time";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import { gate, intercept, linkedProject, panel, seedDashboard, spec } from "../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../test/renderMonitoringApp";
import { DISMISSED_KEY } from "./dismissals";
import { QUERY_CHANGED, RecommendationBar } from "./RecommendationBar";
import { registerRecommendationRule } from "./recommend";

// The chart chunk as a stub.
vi.mock("../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
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

// An empty stored list, so dismissals kept in memory by an earlier test are not read back.
beforeEach(() => { localStorage.clear(); localStorage.setItem(DISMISSED_KEY, "[]"); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };
const noisy = {
  result_type: "matrix" as const,
  series: [{ labels: { job: "api" }, points: Array.from({ length: 60 }, (_, i) => [1_000 + i * 15, i % 2 ? 10 : 0] as [number, number]) }],
};
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };

function shop(expr: string, answer: typeof ok = ok): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    catalogs: {
      p1: catalogOf("p1", source("s1", {
        built_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        metrics: [metric("http_requests_total", { type: "counter", labels: ["job"], series: 3 })],
      })),
    },
    dashboards: { d1: seedDashboard("d1", SHOP, spec("API latency", [panel("p-1", "Requests", expr, { x: 0, y: 0, w: 8, h: 8 })])) },
    queryAnswers: new Proxy({} as Record<string, typeof ok>, { get: () => answer }),
  }, async () => json([]));
}

type Batch = { queries: { query: string; step?: number | null }[] };
const batches = (api: FakeMonitoringApi) => api.requests.filter((r) => r.url === "/api/monitoring/query/batch").map((r) => r.body as Batch);
const settings = () => screen.getByRole("complementary", { name: "Panel settings" });
const bar = () => within(settings()).queryByRole("region", { name: "Recommendation" });
const tabNamed = (name: string) => within(settings()).getByRole("tab", { name });
const draftPanel = (): PanelSpec => {
  const s = editSessions.get("start0");
  if (s?.mode !== "edit") throw new Error("not editing");
  return s.draft.panels[0];
};

async function openSettings(api: FakeMonitoringApi, refresh?: "10s") {
  const user = userEvent.setup();
  renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1", ...(refresh ? { refresh } : {}) }) });
  const title = await screen.findByRole("heading", { level: 1 });
  await waitFor(() => expect(document.activeElement).toBe(title));
  await screen.findAllByText(/^chart /);
  await user.keyboard("e");
  await screen.findByRole("button", { name: "Save dashboard" });
  await user.keyboard("{Enter}");
  await screen.findByRole("complementary", { name: "Panel settings" });
  return { user, api };
}

const PER_SECOND = "http_requests_total is a counter, so its raw value only goes up. Show it per second?";

describe("Recommendation bar", () => {
  it("a raw counter shows the per-second recommendation", async () => {
    await openSettings(shop("http_requests_total"));
    const region = await waitFor(() => bar()!);
    expect(region.textContent).toContain(PER_SECOND);
    expect(within(region).getByText("http_requests_total").tagName).toBe("STRONG");
    expect(within(region).getByRole("button", { name: "Apply" })).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Dismiss this recommendation" })).toBeTruthy();
    expect(region.querySelector('[aria-hidden="true"]')?.textContent).toBe("💡");
    // The bar sits above the tabs.
    expect(region.compareDocumentPosition(within(settings()).getByRole("tablist")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("Apply rewrites the query in the draft and the run uses it", async () => {
    const api = shop("http_requests_total");
    const { user } = await openSettings(api);
    await waitFor(() => expect(bar()).not.toBeNull());
    const step = batches(api).at(-1)!.queries[0].step as number;
    await user.click(within(bar()!).getByRole("button", { name: "Apply" }));
    expect(draftPanel().queries[0].expr).toBe("rate(http_requests_total[$__rate_interval])");
    expect(within(settings()).getByRole("textbox", { name: "Query A" })).toHaveProperty("value", "rate(http_requests_total[$__rate_interval])");
    expect(document.activeElement).toBe(tabNamed("Query"));
    // The batch carries the substituted duration, not the builtin.
    const sent = `rate(http_requests_total[${durationText(Math.max(4 * step, RATE_INTERVAL_FLOOR))}])`;
    await waitFor(() => expect(batches(api).some((b) => b.queries.some((q) => q.query === sent))).toBe(true));
    expect(bar()).toBeNull();
  });

  it("Apply is refused while the JSON text is invalid, and the bar stays", async () => {
    const { user } = await openSettings(shop("http_requests_total"));
    await waitFor(() => expect(bar()).not.toBeNull());
    await user.click(screen.getByRole("tab", { name: "JSON" }));
    const area = await screen.findByRole("textbox", { name: "Dashboard JSON" });
    fireEvent.input(area, { target: { value: "{ nope" } });
    await waitFor(() => expect(screen.getByTestId("json-state").textContent).toMatch(/^✗/));
    await user.click(screen.getByRole("tab", { name: "Dashboard" }));
    if (!screen.queryByRole("complementary", { name: "Panel settings" })) {
      screen.getByRole("group", { name: "Panels" }).querySelector<HTMLElement>("[data-tile-id]")!.focus();
      await user.keyboard("{Enter}");
      await screen.findByRole("complementary", { name: "Panel settings" });
    }
    await user.click(within(bar()!).getByRole("button", { name: "Apply" }));
    expect(within(bar()!).getByRole("status").textContent).toBe(JSON_FIRST);
    expect(draftPanel().queries[0].expr).toBe("http_requests_total");
    expect(bar()!.textContent).toContain(PER_SECOND);
  });

  it("Dismiss hides it for good on this dashboard", async () => {
    const api = shop("http_requests_total");
    const { user } = await openSettings(api);
    await waitFor(() => expect(bar()).not.toBeNull());
    await user.click(within(bar()!).getByRole("button", { name: "Dismiss this recommendation" }));
    expect(bar()).toBeNull();
    expect(document.activeElement).toBe(tabNamed("Query"));
    expect(JSON.parse(localStorage.getItem(DISMISSED_KEY)!)).toEqual(["d1|perSecond:p-1:A"]);
    // Close and reopen the side panel: it stays away.
    await user.click(within(settings()).getByRole("button", { name: "Close panel settings" }));
    await user.keyboard("{Enter}");
    await screen.findByRole("complementary", { name: "Panel settings" });
    expect(bar()).toBeNull();
  });

  it("Apply from another tab lands on the Query tab", async () => {
    const { user } = await openSettings(shop("http_requests_total"));
    await waitFor(() => expect(bar()).not.toBeNull());
    await user.click(tabNamed("Chart"));
    await user.click(within(bar()!).getByRole("button", { name: "Apply" }));
    expect(draftPanel().queries[0].expr).toBe("rate(http_requests_total[$__rate_interval])");
    expect(document.activeElement).toBe(tabNamed("Query"));
    expect(tabNamed("Query").getAttribute("aria-selected")).toBe("true");
  });

  it("no data-based recommendation while the old data is shown for a new query", async () => {
    const api = shop("rate(http_requests_total[1m])", noisy);
    const { user } = await openSettings(api);
    await waitFor(() => expect(bar()?.textContent).toContain("is smoother"));
    const held = gate();
    intercept((url, pass) => (url === "/api/monitoring/query/batch" ? held.opened.then(pass) : null));
    fireEvent.change(within(settings()).getByRole("textbox", { name: "Query A" }), { target: { value: "rate(http_requests_total[1m]) + 0" } });
    await waitFor(() => expect(bar()).toBeNull());
    // The debounce has ended and the new run is in flight: the old series still show, the bar stays away.
    await new Promise((r) => setTimeout(r, 450));
    expect(bar()).toBeNull();
    held.open();
    await waitFor(() => expect(bar()?.textContent).toContain("is smoother"));
    expect(user).toBeTruthy();
  });

  it("an auto-refresh tick keeps the recommendation and the keyboard on its button", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const api = shop("rate(http_requests_total[1m])", noisy);
      const { user } = await openSettings(api, "10s");
      await waitFor(() => expect(bar()?.textContent).toContain("is smoother"));
      const apply = within(bar()!).getByRole("button", { name: "Apply" });
      apply.focus();
      // The tick's run is held, so the panel is refetching for the whole check.
      const held = gate();
      let asked = 0;
      intercept((url, pass) => (url === "/api/monitoring/query/batch" ? (asked++, held.opened.then(pass)) : null));
      act(() => { vi.advanceTimersByTime(10_000); });
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(asked).toBeGreaterThan(0);
      expect(bar()?.textContent).toContain("is smoother");
      expect(document.activeElement).toBe(apply);
      held.open();
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(bar()?.textContent).toContain("is smoother");
      expect(document.activeElement).toBe(apply);
      expect(user).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an option-only edit keeps a data-based recommendation", async () => {
    const { user } = await openSettings(shop("rate(http_requests_total[1m])", noisy));
    await waitFor(() => expect(bar()?.textContent).toContain("is smoother"));
    await user.click(tabNamed("Options"));
    await user.clear(within(settings()).getByRole("textbox", { name: "Title" }));
    await user.type(within(settings()).getByRole("textbox", { name: "Title" }), "Renamed");
    expect(draftPanel().title).toBe("Renamed");
    await new Promise((r) => setTimeout(r, 450));
    expect(bar()?.textContent).toContain("is smoother");
  });

  it("widerWindow appears in the side panel once the panel has run (it has a step)", async () => {
    await openSettings(shop("rate(http_requests_total[1m])", noisy));
    const region = await waitFor(() => bar()!);
    expect(region.textContent).toContain("is smoother and still shows spikes.");
  });
});

const series = (): ChartSeries => ({
  key: "s", name: "s", labels: {}, queryRef: "A", projectName: null,
  points: Array.from({ length: 60 }, (_, i) => [i * 15, i % 2 ? 10 : 0] as [number, number]),
});
const data: PanelData = {
  state: "ready", series: [series()], logs: [], problems: [], summary: { series: 1, points: 60, tookMs: 1 }, editId: 0,
};
const timeseries = (expr: string): PanelSpec => {
  const p = newPanel("timeseries", "p-1", { x: 0, y: 0, w: 12, h: 8 });
  return { ...p, queries: [{ ref: "A", source: { type: "prometheus", id: null }, expr, legend: "", hidden: false }] } as PanelSpec;
};

describe("Recommendation bar on its own", () => {
  it("widerWindow appears only when the panel has a step", () => {
    const p = timeseries("rate(x[1m])");
    const { rerender } = render(<RecommendationBar context={{ panel: p, data, catalog: null, stepSeconds: 0 }} scope="d1" onApply={() => {}} />);
    expect(screen.queryByRole("region", { name: "Recommendation" })).toBeNull();
    rerender(<RecommendationBar context={{ panel: p, data, catalog: null, stepSeconds: 60 }} scope="d1" onApply={() => {}} />);
    expect(screen.getByRole("region", { name: "Recommendation" }).textContent).toContain("5 minutes");
  });

  it("a dismissed rule lets the next one show", async () => {
    const user = userEvent.setup();
    const p = timeseries("rate(x[1m])");
    const off = registerRecommendationRule({
      id: "extra",
      evaluate: (c) => ({ id: "extra", key: `extra:${c.panel.id}:-`, text: ["Try the extra thing."], apply: (x) => x }),
    });
    try {
      render(<RecommendationBar context={{ panel: p, data, catalog: null, stepSeconds: 60 }} scope="next" onApply={() => {}} />);
      expect(screen.getByRole("region").textContent).toContain("5 minutes");
      await user.click(screen.getByRole("button", { name: "Dismiss this recommendation" }));
      expect(screen.queryByText(/5 minutes/)).toBeNull();
      expect(screen.getByRole("region").textContent).toContain("Try the extra thing.");
    } finally { off(); }
  });

  it("an edit made after render isn't lost when Apply runs", async () => {
    const user = userEvent.setup();
    const p = timeseries("rate(x[1m])");
    let applied: PanelSpec | null = null;
    render(<RecommendationBar context={{ panel: p, data, catalog: null, stepSeconds: 60 }} scope="late" onApply={(fn) => { applied = fn({ ...p, title: "Edited since" }); }} />);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(applied!.title).toBe("Edited since");
    expect(applied!.queries[0].expr).toBe("rate(x[5m])");
    // Against a panel whose query moved on, it changes nothing (and nothing is overwritten).
    const moved = timeseries("rate(y[1m])");
    let result: PanelSpec | null = null;
    cleanup();
    render(<RecommendationBar context={{ panel: p, data, catalog: null, stepSeconds: 60 }} scope="late2" onApply={(fn) => { result = fn(moved); }} />);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(result).toBe(moved);
  });

  it("the unchanged check refuses in the bar's live region and keeps the bar and focus", async () => {
    const user = userEvent.setup();
    const off = registerRecommendationRule({
      id: "noop",
      evaluate: (c) => (c.panel.queries[0].expr === "up" ? { id: "noop", key: "noop:p-1:A", text: ["Do nothing."], apply: (x) => x } : null),
    });
    try {
      const onApply = vi.fn();
      render(<RecommendationBar context={{ panel: timeseries("up"), data: null, catalog: null, stepSeconds: 0 }} scope="noop" onApply={onApply} />);
      const apply = screen.getByRole("button", { name: "Apply" });
      await user.click(apply);
      expect(onApply).not.toHaveBeenCalled();
      expect(within(screen.getByRole("region")).getByRole("status").textContent).toBe(QUERY_CHANGED);
      expect(document.activeElement).toBe(apply);
      expect(screen.getByRole("region").textContent).toContain("Do nothing.");
    } finally { off(); }
  });

  it("no recommendation, no region content", () => {
    render(<RecommendationBar context={{ panel: timeseries("up"), data: null, catalog: null, stepSeconds: 60 }} scope="d1" onApply={() => {}} />);
    expect(screen.queryByRole("region", { name: "Recommendation" })).toBeNull();
  });

  it("dismissals are kept per scope", async () => {
    const user = userEvent.setup();
    const ctx = { panel: timeseries("rate(x[1m])"), data, catalog: null, stepSeconds: 60 };
    const { unmount } = render(<RecommendationBar context={ctx} scope="one" onApply={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Dismiss this recommendation" }));
    unmount();
    render(<RecommendationBar context={ctx} scope="two" onApply={() => {}} />);
    expect(screen.getByRole("region").textContent).toContain("5 minutes");
  });
});
