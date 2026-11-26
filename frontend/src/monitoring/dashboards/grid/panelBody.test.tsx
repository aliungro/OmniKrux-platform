import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import type { GroupOut } from "../../api/types";
import { installFakeMonitoringApi, type FakeMonitoringApi, type FakeMonitoringState } from "../../test/fakeMonitoringApi";
import { gate, intercept, linkedProject, linkTo, panel, seedDashboard, serverFailure, spec, watchCalls } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import { editSessions } from "../editor/useDashboardEditor";
import type { DashboardSpec } from "../schema";

vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
});

beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };
const none = { result_type: "matrix" as const, series: [] };
const noRows = { result_type: "vector" as const, series: [] };
const GENERIC = "No data in this time range.";
const MISSING = "This Prometheus doesn't collect CPU throttling for this project: container_cpu_cfs_throttled_periods_total has no series.";
const NOTHING = "The query's metrics are collected for this project, but nothing matched in this time range. Try a longer range.";
const THROTTLE = "rate(container_cpu_cfs_throttled_periods_total[5m])";

const doc = (): DashboardSpec => spec("CPU", [
  panel("p-1", "Throttling", THROTTLE, { x: 0, y: 0, w: 12, h: 8 }),
  panel("p-2", "Requests", "up", { x: 12, y: 0, w: 12, h: 8 }),
]);

function shop(more: Partial<FakeMonitoringState> = {}): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: seedDashboard("d1", SHOP, doc()) },
    queryAnswers: { [THROTTLE]: none, up: ok },
    whyEmpty: { reason: "missing_metric", message: MISSING },
    ...more,
  }, async () => json([]));
}

const frame = (id: string) => document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)!;
const asked = (api: FakeMonitoringApi) => api.requests.filter((r) => r.url === "/api/monitoring/query/why-empty");

async function open() {
  renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
  const title = await screen.findByRole("heading", { level: 1 });
  await waitFor(() => expect(document.activeElement).toBe(title));
}

describe("Empty panels say why", () => {
  it("an empty panel says why once the reason arrives", async () => {
    const api = shop();
    const held = gate();
    let sent = 0;
    intercept((url, pass) => (url.endsWith("/query/why-empty") ? (sent++, held.opened.then(pass)) : null));
    await open();
    // The run came back empty: the generic words, never a "checking" line while the reason is on its way.
    expect(await within(frame("p-1")).findByText(GENERIC)).toBeTruthy();
    await waitFor(() => expect(sent).toBe(1));
    expect(within(frame("p-1")).queryByText(/check/i)).toBeNull();
    held.open();
    const reason = await within(frame("p-1")).findByText(MISSING);
    expect(sent).toBe(1);
    expect(reason.hasAttribute("data-empty-reason")).toBe(true);
    expect(within(frame("p-1")).queryByText(GENERIC)).toBeNull();
    // About the request that ran: its project, source, text, range and metric names; asked once, not per render.
    const body = asked(api)[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ source_id: "s1", project_id: "p1", query: THROTTLE, metrics: ["container_cpu_cfs_throttled_periods_total"] });
    expect(body.end as number).toBeGreaterThan(body.start as number);
    expect(asked(api)).toHaveLength(1);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("an unknown reason keeps the generic words", async () => {
    const api = shop({ whyEmpty: { reason: "unknown", message: null } });
    const calls = watchCalls("/query/why-empty");
    await open();
    expect(await within(frame("p-1")).findByText(GENERIC)).toBeTruthy();
    await waitFor(() => expect(calls.count).toBe(1));
    expect(asked(api)).toHaveLength(1);
    // The answer is in; still the generic words, nothing invented.
    await calls.settled();
    expect(within(frame("p-1")).getByText(GENERIC)).toBeTruthy();
    expect(frame("p-1").querySelector("[data-empty-reason]")).toBeNull();
    cleanup();

    // A check that failed says nothing new either.
    shop();
    let failed = 0;
    intercept((url) => (url.endsWith("/query/why-empty") ? (failed++, serverFailure(502, "unreachable", "The source didn't answer.")) : null));
    const failing = watchCalls("/query/why-empty");
    await open();
    expect(await within(frame("p-1")).findByText(GENERIC)).toBeTruthy();
    await waitFor(() => expect(failing.count).toBe(1));
    expect(failed).toBe(1);
    await failing.settled();
    expect(within(frame("p-1")).getByText(GENERIC)).toBeTruthy();
    expect(screen.queryByText("The source didn't answer.")).toBeNull();
  });

  it("no reason is asked for a panel that has data", async () => {
    const api = shop({ queryAnswers: { [THROTTLE]: ok, up: ok } });
    const batch = watchCalls("/query/batch");
    await open();
    await waitFor(() => expect(screen.getAllByText("chart 1")).toHaveLength(2));
    // Every run has answered and been drawn: nothing asked why.
    await batch.settled();
    expect(asked(api)).toHaveLength(0);
  });

  it("a group dashboard names the project the reason is about", async () => {
    const g: GroupOut = { id: "g1", name: "Everything", project_ids: ["p1", "p2"], created_at: "", updated_at: "" };
    const api = installFakeMonitoringApi({
      projects: [linkedProject("p1", "Dev", "s1"), linkedProject("p2", "Stage", "s2")],
      groups: [g],
      dashboards: { d1: seedDashboard("d1", { kind: "group", id: "g1", name: "Everything" }, spec("Fleet", [panel("p-1", "Throttling", THROTTLE)])) },
      queryAnswers: { [THROTTLE]: none },
      whyEmpty: { reason: "missing_metric", message: MISSING },
    }, async () => json([]));
    await open();
    expect(await within(frame("p-1")).findByText(`Dev: ${MISSING}`)).toBeTruthy();
    expect(asked(api)).toHaveLength(1);
    expect(asked(api)[0].body).toMatchObject({ project_id: "p1", source_id: "s1" });
  });

  it("an instant table that matched nothing keeps the generic words, a missing metric still says so", async () => {
    const table = (expr: string) => spec("Pods", [panel("p-1", "Pods not ready", expr, { x: 0, y: 0, w: 12, h: 8 }, "table")]);
    const api = shop({
      dashboards: { d1: seedDashboard("d1", SHOP, table("kube_pod_status_ready == 0")) },
      queryAnswers: { "kube_pod_status_ready == 0": noRows },
      whyEmpty: { reason: "nothing_matched", message: NOTHING },
    });
    const calls = watchCalls("/query/why-empty");
    await open();
    expect(await within(frame("p-1")).findByText(GENERIC)).toBeTruthy();
    await waitFor(() => expect(asked(api)).toHaveLength(1));
    // The run's range is sent for an instant panel (F1).
    const body = asked(api)[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ metrics: ["kube_pod_status_ready"] });
    expect(body.end as number).toBeGreaterThan(body.start as number);
    await calls.settled();
    expect(within(frame("p-1")).queryByText(NOTHING)).toBeNull();
    cleanup();

    shop({
      dashboards: { d1: seedDashboard("d1", SHOP, table("kube_pod_status_ready == 0")) },
      queryAnswers: { "kube_pod_status_ready == 0": noRows },
      whyEmpty: { reason: "missing_metric", message: "This Prometheus doesn't collect Kubernetes object states (kube-state-metrics) for this project: kube_pod_status_ready has no series." },
    });
    await open();
    expect(await within(frame("p-1")).findByText(/kube-state-metrics/)).toBeTruthy();
  });
});

describe("A year's empty panel", () => {
  const PLAIN = "The query's metrics are collected for this project, but nothing matched in this time range.";
  const RESTARTS = "sum by (namespace, pod) (kube_pod_container_status_restarts_total - kube_pod_container_status_restarts_total offset $__interval) > 0";

  it("asks about the whole year and says the server's words, with no advice to try a longer range", async () => {
    const year = { ...spec("Pods", [panel("p-1", "Restarts", RESTARTS, { x: 0, y: 0, w: 12, h: 8 })]), time: { from: "now-365d", to: "now" } };
    const api = shop({
      dashboards: { d1: seedDashboard("d1", SHOP, year) },
      queryAnswers: { [RESTARTS.replace("$__interval", "24h")]: none },
      whyEmpty: { reason: "nothing_matched", message: PLAIN },
    });
    await open();
    expect(await within(frame("p-1")).findByText(PLAIN)).toBeTruthy();
    const body = asked(api)[0].body as { start: number; end: number; metrics: string[] };
    expect(body.metrics).toEqual(["kube_pod_container_status_restarts_total"]);
    expect(body.end - body.start).toBeGreaterThanOrEqual(365 * 86400);
    expect(within(frame("p-1")).queryByText(/longer range/)).toBeNull();
  });
});

describe("A log query in a chart panel", () => {
  const LOGS = "{job=\"omnikrux-live-check\"}";
  const SAYS = "This is a log query: it lists lines, and a chart can't draw lines.";
  const lines = { result_type: "streams" as const, streams: [{ labels: { job: "omnikrux-live-check" }, entries: [["1700000000000000000", "hello"]] as [string, string][] }] };
  const logsDoc = () => {
    const p = panel("p-1", "Lines", LOGS, { x: 0, y: 0, w: 12, h: 8 });
    p.queries[0].source = { type: "loki", id: null };
    return spec("Logs", [p]);
  };

  it("the grid tile says a chart can't draw a log query", async () => {
    const api = shop({
      projects: [{ ...linkedProject("p1", "Shop"), links: [linkTo("l1", "loki")] }],
      dashboards: { d1: seedDashboard("d1", SHOP, logsDoc()) },
      queryAnswers: { [LOGS]: lines },
    });
    const calls = watchCalls("/query/why-empty");
    await open();
    expect(await within(frame("p-1")).findByText(SAYS)).toBeTruthy();
    expect(within(frame("p-1")).queryByText(GENERIC)).toBeNull();
    await calls.settled();
    expect(asked(api)).toHaveLength(0);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("an empty answer says it too, and asks nothing", async () => {
    const api = shop({
      projects: [{ ...linkedProject("p1", "Shop"), links: [linkTo("l1", "loki")] }],
      dashboards: { d1: seedDashboard("d1", SHOP, logsDoc()) },
      queryAnswers: { [LOGS]: { result_type: "streams" as const, streams: [] } },
    });
    await open();
    expect(await within(frame("p-1")).findByText(SAYS)).toBeTruthy();
    expect(asked(api)).toHaveLength(0);
  });
});

describe("the loading line under reduced motion", () => {
  it("reduced motion keeps the line still", () => {
    const css = readFileSync(resolve(process.cwd(), "src/monitoring/dashboards/grid/DashboardGrid.module.css"), "utf8");
    const block = /@media \(prefers-reduced-motion: reduce\) \{\s*\.progress::after \{([^}]*)\}/.exec(css);
    expect(block?.[1]).toMatch(/animation: none/);
  });
});
