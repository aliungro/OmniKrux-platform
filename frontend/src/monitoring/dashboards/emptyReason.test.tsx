import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryRequest } from "../api/types";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import { gate, intercept, linkedProject, linkTo, panel, seedDashboard, spec, watchCalls } from "../test/dashboardSeeds";
import { seedProject } from "../test/renderMonitoringApp";
import { renderMonitoringApp, tabsWith } from "../test/renderMonitoringApp";
import { editSessions } from "./editor/useDashboardEditor";
import { WINDOW_SHORTER, windowHint, emptyCheck, useEmptyReason, type EmptyAsk } from "./emptyReason";

vi.mock("../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
});

beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const range = (query: string, over: Partial<QueryRequest> = {}): QueryRequest =>
  ({ source_id: "s1", project_id: "p1", kind: "range", query, start: 1000, end: 4600, step: 15, ...over });

describe("emptyCheck", () => {
  it("metric names come from the query", () => {
    const query = 'sum by (pod) (rate(container_cpu_cfs_throttled_periods_total{namespace="api"}[5m])) / sum by (pod) (rate(container_cpu_cfs_periods_total[5m])) > bool 0.1';
    expect(emptyCheck("prometheus", range(query))).toEqual({
      source_id: "s1", project_id: "p1", query, start: 1000, end: 4600,
      metrics: ["container_cpu_cfs_throttled_periods_total", "container_cpu_cfs_periods_total"],
    });
    // Unique, at most five, in the order written.
    const many = "a + b + a + c + d + e + f + g";
    expect(emptyCheck("prometheus", range(many))?.metrics).toEqual(["a", "b", "c", "d", "e"]);
    // An instant request carries only its time: the run's range is what is checked (F1).
    const instant: QueryRequest = { source_id: "s1", project_id: "p1", kind: "instant", query: "kube_pod_info", time: 4600 };
    expect(emptyCheck("prometheus", instant, { start: 1000, end: 4600 })).toMatchObject({ start: 1000, end: 4600, metrics: ["kube_pod_info"] });
  });

  it("a log query sends its selector", () => {
    const query = 'sum(count_over_time({k8s_namespace_name="shop", level=~"error|warn"} |= "timeout" [5m]))';
    expect(emptyCheck("loki", range(query, { start: 50, end: 650 }))).toEqual({
      source_id: "s1", project_id: "p1", query, start: 50, end: 650, metrics: [], selector: '{k8s_namespace_name="shop", level=~"error|warn"}',
    });
    // A window chosen on a chart is the request's own start and end.
    expect(emptyCheck("loki", range('{app="shop"}', { start: 600, end: 1200 }))).toMatchObject({ start: 600, end: 1200, selector: '{app="shop"}' });
  });

  it("nothing to check is null", () => {
    // No metric name, no selector, no project, no range, a range the wrong way round, an empty or unreadable text.
    expect(emptyCheck("prometheus", range("vector(1) > 2"))).toBeNull();
    expect(emptyCheck("loki", range('count_over_time(foo[5m])'))).toBeNull();
    expect(emptyCheck("prometheus", range("up", { project_id: null }))).toBeNull();
    expect(emptyCheck("prometheus", { source_id: "s1", project_id: "p1", kind: "instant", query: "up", time: 5 })).toBeNull();
    expect(emptyCheck("prometheus", range("up", { start: 10, end: 10 }))).toBeNull();
    expect(emptyCheck("prometheus", range("   "))).toBeNull();
    expect(emptyCheck("prometheus", range("sum(up"))).toBeNull();
    // Past the server's limits: not sent (it would only be refused).
    expect(emptyCheck("prometheus", range(`up${" ".repeat(10_000)}`))).toBeNull();
    expect(emptyCheck("loki", range(`{app="${"x".repeat(2000)}"}`))).toBeNull();
  });
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };
const none = { result_type: "matrix" as const, series: [] };
const MISSING = "This Prometheus doesn't collect CPU throttling for this project: container_cpu_cfs_throttled_periods_total has no series.";

describe("The Query tab", () => {
  it("the Query tab shows the reason under the run line", async () => {
    const api: FakeMonitoringApi = installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      dashboards: { d1: seedDashboard("d1", SHOP, spec("CPU", [
        panel("p-1", "Throttling", "rate(container_cpu_cfs_throttled_periods_total[5m])", { x: 0, y: 0, w: 12, h: 8 }),
        panel("p-2", "Requests", "up", { x: 12, y: 0, w: 12, h: 8 }),
      ])) },
      queryAnswers: { "rate(container_cpu_cfs_throttled_periods_total[5m])": none, up: ok },
      whyEmpty: { reason: "missing_metric", message: MISSING },
    }, async () => json([]));
    const user = userEvent.setup();
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    const title = await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(title));
    await screen.findByText("chart 1");
    await user.keyboard("e");
    await screen.findByRole("button", { name: "Save dashboard" });
    await user.keyboard("{Enter}");
    const aside = await screen.findByRole("complementary", { name: "Panel settings" });
    expect(within(aside).getByRole("heading", { name: "Throttling" })).toBeTruthy();

    // The count stays as it was; the reason is its own line under it.
    const reason = await within(aside).findByText(MISSING);
    expect(reason.tagName).toBe("P");
    const line = within(aside).getByText(/^0 series · 0 points · \d+ ms$/);
    expect(line.nextElementSibling).toBe(reason);
    expect(document.activeElement).not.toBe(document.body);
    // The tile and the tab ask once between them, about the request that ran.
    const asked = api.requests.filter((r) => r.url === "/api/monitoring/query/why-empty");
    expect(asked).toHaveLength(1);
    expect(asked[0].body).toMatchObject({
      source_id: "s1", project_id: "p1", query: "rate(container_cpu_cfs_throttled_periods_total[5m])",
      metrics: ["container_cpu_cfs_throttled_periods_total"],
    });
  });
});

describe("A newer window of the same query", () => {
  const OLDER = "No lines in this time range. The newest matching line is 3 days old: try a longer range.";
  const FILTERED = 'Streams match {app="shop"}, but no line in this time range passes the rest of the query.';
  const NO_LABELS = 'This Loki has no streams with the label "app" for this project in the last 30 days, so nothing sends these logs to it now.';
  const HOUR = { start: 1_000_000, end: 1_003_600 };
  const WEEK = { start: 1_003_600 - 7 * 86_400, end: 1_003_600 };
  const LATER = { start: 1_007_200, end: 1_010_800 };
  const ask = (sourceType: EmptyAsk["sourceType"], query: string, range: { start: number; end: number }): EmptyAsk =>
    ({ sourceType, request: { source_id: sourceType === "loki" ? "l1" : "s1", project_id: "p1", kind: "range", query, ...range, step: 15 }, range });

  /** The fake with Shop's Prometheus s1 and Loki l1; checks after `hold.on` wait for `hold.release()`. */
  function setup() {
    const api = installFakeMonitoringApi({ projects: [{ ...seedProject("p1", "Shop"), links: [linkTo("s1"), linkTo("l1", "loki")] }] });
    const held = gate();
    const hold = { on: false, release: () => held.open() };
    intercept((url, pass) => (hold.on && url.endsWith("/query/why-empty") ? held.opened.then(pass) : null));
    const calls = watchCalls("/query/why-empty");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
    const hook = (first: EmptyAsk) =>
      renderHook(({ input }: { input: EmptyAsk | null }) => useEmptyReason(input), { wrapper, initialProps: { input: first } });
    return { api, hold, calls, hook };
  }

  it("a reason about the old window never shows on the new one", async () => {
    const { api, hold, calls, hook } = setup();
    api.state.whyEmpty = { reason: "older_lines", message: OLDER };
    const view = hook(ask("loki", '{app="shop"} |= "timeout"', HOUR));
    await waitFor(() => expect(view.result.current).toBe(OLDER));

    // The user follows the advice and picks a longer range: until its own check answers, no reason.
    api.state.whyEmpty = { reason: "filtered_out", message: FILTERED };
    hold.on = true;
    view.rerender({ input: ask("loki", '{app="shop"} |= "timeout"', WEEK) });
    expect(view.result.current).toBeNull();
    await waitFor(() => expect(calls.count).toBe(2));
    expect(view.result.current).toBeNull();
    hold.release();
    await waitFor(() => expect(view.result.current).toBe(FILTERED));
  });

  it("a reason that holds for any window stays while the new window is checked", async () => {
    const { api, hold, calls, hook } = setup();
    api.state.whyEmpty = { reason: "missing_metric", message: MISSING };
    const query = "rate(container_cpu_cfs_throttled_periods_total[5m])";
    const view = hook(ask("prometheus", query, HOUR));
    await waitFor(() => expect(view.result.current).toBe(MISSING));
    hold.on = true;
    view.rerender({ input: ask("prometheus", query, LATER) });
    expect(view.result.current).toBe(MISSING);
    await waitFor(() => expect(calls.count).toBe(2));
    expect(view.result.current).toBe(MISSING);
    // Another query never inherits it.
    view.rerender({ input: ask("prometheus", "up", LATER) });
    expect(view.result.current).toBeNull();
    hold.release();
    await calls.settled();
  });

  it("a failed check clears what was held", async () => {
    const { api, hold, calls, hook } = setup();
    api.state.whyEmpty = { reason: "missing_labels", message: NO_LABELS };
    const view = hook(ask("loki", '{app="shop"}', HOUR));
    await waitFor(() => expect(view.result.current).toBe(NO_LABELS));
    api.state.whyEmpty = { error: { code: "unreachable", message: "The source didn't answer." }, status: 502 };
    view.rerender({ input: ask("loki", '{app="shop"}', LATER) });
    await waitFor(() => expect(calls.count).toBe(2));
    await calls.settled();
    expect(view.result.current).toBeNull();
    // A third window, still being checked: the withdrawn words don't come back.
    hold.on = true;
    view.rerender({ input: ask("loki", '{app="shop"}', { start: LATER.start + 3600, end: LATER.end + 3600 }) });
    await waitFor(() => expect(calls.count).toBe(3));
    expect(view.result.current).toBeNull();
    hold.release();
    await calls.settled();
  });
});

describe("A window shorter than the step", () => {
  it("a window shorter than the step says so", async () => {
    // Only a fixed window counts: longer ones, variables and no step say nothing.
    expect(windowHint("rate(up[5s])", 60)).toBe(WINDOW_SHORTER.replace("{step}", "1m").replace("{window}", "5s"));
    expect(windowHint("sum(rate(a[5m])) / rate(b[30s])", 60)).toContain("[30s]");
    expect(windowHint("rate(up[5m])", 60)).toBeNull();
    expect(windowHint("rate(up[$__rate_interval])", 60)).toBeNull();
    expect(windowHint("rate(up[5s])", 0)).toBeNull();
    expect(windowHint("rate(up[5s]", 60)).toBeNull();

    const api: FakeMonitoringApi = installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      dashboards: { d1: seedDashboard("d1", SHOP, spec("CPU", [panel("p-1", "Rate", "rate(up[1s])", { x: 0, y: 0, w: 12, h: 8 })])) },
      queryAnswers: { "rate(up[1s])": none },
      whyEmpty: { reason: "missing_metric", message: MISSING },
    }, async () => json([]));
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    const note = await screen.findByText(/longer than the query's window \[1s\]/);
    expect(note.textContent).toMatch(/^This range's step is \d+[smh], longer than the query's window \[1s\], so most points are skipped\. Use \[\$__rate_interval\] instead\.$/);
    expect(screen.queryByText(MISSING)).toBeNull();
    // Said before any server check, and the check isn't asked.
    expect(api.requests.filter((r) => r.url === "/api/monitoring/query/why-empty")).toHaveLength(0);
  });

  it("a dimmed older result never wears the new run's hint", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      dashboards: { d1: seedDashboard("d1", SHOP, spec("CPU", [panel("p-1", "Rate", "rate(up[5m])", { x: 0, y: 0, w: 12, h: 8 })])) },
      queryAnswers: { "rate(up[5m])": none },
    }, async () => json([]));
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    await screen.findByText("No data in this time range.");
    expect(screen.queryByText(/longer than the query's window/)).toBeNull();
    const panelEl = () => document.querySelector<HTMLElement>('[data-panel-id="p-1"]')!;

    // A longer range has a step past the 5 minute window, but its answer is still on its way.
    const held = gate();
    intercept((url, pass) => (url === "/api/monitoring/query/batch" ? held.opened.then(pass) : null));
    await user.click(screen.getByRole("button", { name: "Last 6 hours" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Last 7 days" }));
    await waitFor(() => expect(panelEl().dataset.stale).toBe("true"));
    expect(screen.queryByText(/longer than the query's window/)).toBeNull();
    expect(within(panelEl()).getByText("No data in this time range.")).toBeTruthy();
    act(() => held.open());
    expect(await screen.findByText(/longer than the query's window \[5m\]/)).toBeTruthy();
    expect(panelEl().dataset.stale).toBeUndefined();
  });
});
