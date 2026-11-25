import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryRequest } from "../api/types";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec } from "../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../test/renderMonitoringApp";
import { editSessions } from "./editor/useDashboardEditor";
import { emptyCheck } from "./emptyReason";

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
