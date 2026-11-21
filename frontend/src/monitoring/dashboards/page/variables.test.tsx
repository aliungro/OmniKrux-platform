import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryRequest } from "../../api/types";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec, variable } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";

vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("p", null, `chart ${data.series.length}`) };
});

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fallback = async () => json([]);
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };

const batches = (api: FakeMonitoringApi) =>
  api.requests.filter((r) => r.url === "/api/monitoring/query/batch").map((r) => (r.body as { queries: QueryRequest[] }).queries);
const labelReads = (api: FakeMonitoringApi) =>
  api.requests.filter((r) => r.url.startsWith("/api/monitoring/label-values")).map((r) => new URL(r.url, "http://x").searchParams);

function seed(vars: Record<string, string[] | "all"> | undefined) {
  const doc = spec("Pods", [panel("p-1", "Restarts", 'kube_pod_restarts{namespace=~"$namespace", pod=~"$pod"}')], [
    variable("namespace", "Namespace"),
    variable("pod", "Pod", { match: 'kube_pod_info{namespace="$namespace"}', multi: true, includeAll: true, default: "all" }),
  ]);
  const api = installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: seedDashboard("d1", SHOP, doc) },
    labelValues: { "p1|namespace": ["api", "web"], "p1|pod": ["api-1", "api-2"] },
    queryAnswers: {},
  }, fallback);
  const answer = api.state.queryAnswers;
  return { api, answer, view: { page: "dashboard" as const, id: "d1", ...(vars ? { vars } : {}) } };
}

describe("Dashboard variables", () => {
  it("variables load in order and feed the queries", async () => {
    const { api, answer, view } = seed(undefined);
    answer['kube_pod_restarts{namespace=~"api", pod=~".+"}'] = ok;
    renderMonitoringApp({ tabs: tabsWith(view) });
    expect(await screen.findByRole("button", { name: "Namespace: api" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Pod: All" })).toBeTruthy();
    await waitFor(() => expect(labelReads(api).map((p) => p.get("label"))).toEqual(["namespace", "pod"]));
    const pod = labelReads(api)[1];
    expect(pod.get("match")).toBe('kube_pod_info{namespace="api"}');
    expect(pod.get("project_id")).toBe("p1");
    // The client never sends a raw $name.
    expect(api.requests.some((r) => decodeURIComponent(r.url).includes("$") || JSON.stringify(r.body ?? "").includes("$"))).toBe(false);
    await waitFor(() => expect(batches(api).length).toBe(1));
    expect(batches(api)[0][0].query).toBe('kube_pod_restarts{namespace=~"api", pod=~".+"}');
    expect(await screen.findByText("chart 1")).toBeTruthy();
  });

  it("changing a variable replaces the view and re-runs its panels", async () => {
    const user = userEvent.setup();
    const { api, answer, view } = seed(undefined);
    answer['kube_pod_restarts{namespace=~"api", pod=~".+"}'] = ok;
    answer['kube_pod_restarts{namespace=~"web", pod=~".+"}'] = { result_type: "matrix", series: [] };
    const { current } = renderMonitoringApp({ tabs: tabsWith(view) });
    expect(await screen.findByText("chart 1")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Namespace: api" }));
    const list = screen.getByRole("group", { name: "Namespace" });
    expect((within(list).getByRole("radio", { name: "api" }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(list).getByRole("radio", { name: "web" }));
    expect(current().tabs[0].view).toMatchObject({ vars: { namespace: ["web"] } });
    expect(current().tabs[0].back).toEqual([]);
    expect(await screen.findByText("No data in this time range.")).toBeTruthy();
    expect(batches(api).at(-1)![0].query).toBe('kube_pod_restarts{namespace=~"web", pod=~".+"}');
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Namespace: web" }));
  });

  it("a value that disappeared stays selected and says so", async () => {
    const user = userEvent.setup();
    const { api, answer, view } = seed({ namespace: ["gone"], pod: ["api-1", "api-9"] });
    answer['kube_pod_restarts{namespace=~"gone", pod=~"api-1|api-9"}'] = ok;
    renderMonitoringApp({ tabs: tabsWith(view) });
    expect(await screen.findByRole("button", { name: "Namespace: gone" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Pod: api-1 + 1" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Namespace: gone" }));
    const ns = screen.getByRole("group", { name: "Namespace" });
    expect((within(ns).getByRole("radio", { name: "gone (not found)" }) as HTMLInputElement).checked).toBe(true);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Namespace: gone" }));
    await user.click(screen.getByRole("button", { name: "Pod: api-1 + 1" }));
    const pods = screen.getByRole("group", { name: "Pod" });
    expect((within(pods).getByRole("checkbox", { name: "api-9 (not found)" }) as HTMLInputElement).checked).toBe(true);
    expect((within(pods).getByRole("checkbox", { name: "api-1" }) as HTMLInputElement).checked).toBe(true);
    expect((within(pods).getByRole("checkbox", { name: "All" }) as HTMLInputElement).checked).toBe(false);
    await waitFor(() => expect(batches(api).length).toBe(1));
    expect(batches(api)[0][0].query).toBe('kube_pod_restarts{namespace=~"gone", pod=~"api-1|api-9"}');
  });

  it("a variable that can't load says why and offers Try again", async () => {
    const user = userEvent.setup();
    const { api, view } = seed(undefined);
    // The source isn't linked any more: label values are refused.
    api.state.projects[0].links = [];
    renderMonitoringApp({ tabs: tabsWith(view) });
    await user.click(await screen.findByRole("button", { name: /^Namespace:/ }));
    const ns = screen.getByRole("group", { name: "Namespace" });
    expect(await within(ns).findByText(/^Couldn't load values: /)).toBeTruthy();
    expect(within(ns).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("a panel waits for its variables before running", async () => {
    const { api, answer, view } = seed(undefined);
    answer['kube_pod_restarts{namespace=~"api", pod=~".+"}'] = ok;
    renderMonitoringApp({ tabs: tabsWith(view) });
    expect(await screen.findByText("chart 1")).toBeTruthy();
    // Every batch sent carried the loaded values: none ran with an empty namespace.
    expect(batches(api).every((b) => b.every((q) => q.query.includes('namespace=~"api"')))).toBe(true);
  });
});
