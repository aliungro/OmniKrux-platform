import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager } from "@tanstack/react-query";
import type { QueryRequest } from "../../api/types";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { gate, intercept, linkedProject, panel, seedDashboard, serverFailure, spec, variable } from "../../test/dashboardSeeds";
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

  it("a variable whose project has no source says where to link one, without Try again", async () => {
    const user = userEvent.setup();
    const { api, view } = seed(undefined);
    api.state.projects[0].links = [];
    renderMonitoringApp({ tabs: tabsWith(view) });
    await user.click(await screen.findByRole("button", { name: "Namespace: couldn't load" }));
    const ns = screen.getByRole("group", { name: "Namespace" });
    expect(within(ns).getByText("Couldn't load values: Shop has no Prometheus-compatible source.")).toBeTruthy();
    expect(within(ns).queryByRole("button", { name: "Try again" })).toBeNull();
    // No request is made for it: the client knows there is nothing to read.
    expect(labelReads(api)).toEqual([]);
    await user.click(within(ns).getByRole("link", { name: "Link one on Shop's page" }));
    expect(await screen.findByRole("heading", { name: "Shop" })).toBeTruthy();
  });

  it("a value that can't be placed in a selector says so, without Try again", async () => {
    const user = userEvent.setup();
    const doc = spec("Pods", [panel("p-1", "Restarts", "up")], [
      variable("namespace", "Namespace", { multi: true, includeAll: true, default: "all" }),
      // Unquoted: a regex can't be placed there safely.
      variable("pod", "Pod", { match: "kube_pod_info{namespace=~$namespace}" }),
    ]);
    installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      dashboards: { d1: seedDashboard("d1", SHOP, doc) },
      labelValues: { "p1|namespace": ["api"] },
      queryAnswers: { up: ok },
    }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    await user.click(await screen.findByRole("button", { name: "Pod: couldn't load" }));
    const pod = screen.getByRole("group", { name: "Pod" });
    expect(within(pod).getByText(/^Couldn't load values: The value of \$namespace can't be used here\./)).toBeTruthy();
    expect(within(pod).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(pod).queryByRole("link")).toBeNull();
  });

  it("a failed read offers Try again, and after it the keyboard stays in the values", async () => {
    const user = userEvent.setup();
    const { view } = seed(undefined);
    let broken = true;
    intercept((url, pass) => (broken && url.includes("/label-values") && url.includes("label=namespace")
      ? serverFailure(502, "unreachable", "Can't reach Prometheus: the connection was refused.")
      : pass()));
    renderMonitoringApp({ tabs: tabsWith(view) });
    await user.click(await screen.findByRole("button", { name: "Namespace: couldn't load" }));
    const ns = screen.getByRole("group", { name: "Namespace" });
    expect(await within(ns).findByText("Couldn't load values: Can't reach Prometheus: the connection was refused.")).toBeTruthy();
    broken = false;
    await user.click(within(ns).getByRole("button", { name: "Try again" }));
    const api = await within(ns).findByRole("radio", { name: "api" });
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(ns.contains(document.activeElement)).toBe(true);
    expect((api as HTMLInputElement).checked).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Namespace" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Namespace: api" }));
  });

  it("a variable whose values can't be read stops its panels with its failure, not No data", async () => {
    const user = userEvent.setup();
    const { api, answer, view } = seed(undefined);
    answer['kube_pod_restarts{namespace=~"api", pod=~".+"}'] = ok;
    let broken = true;
    intercept((url, pass) => (broken && url.includes("/label-values") && url.includes("label=namespace")
      ? serverFailure(502, "unreachable", "Can't reach Prometheus: the connection was refused.")
      : pass()));
    renderMonitoringApp({ tabs: tabsWith(view) });
    const restarts = within(await screen.findByRole("region", { name: "Restarts" }));
    expect(await restarts.findByText("Query error")).toBeTruthy();
    expect(restarts.getByText("$namespace couldn't load its values. Its menu above says why.")).toBeTruthy();
    expect(restarts.queryByText("No data in this time range.")).toBeNull();
    // Nothing ran with an empty value: no panel query, and Pod (which needs it) wasn't read.
    await new Promise((r) => setTimeout(r, 30));
    expect(batches(api)).toEqual([]);
    expect(labelReads(api).some((p) => p.get("label") === "pod")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Pod: All" }));
    expect(within(screen.getByRole("group", { name: "Pod" })).getByText("Couldn't load values: It needs $namespace, which couldn't load its values.")).toBeTruthy();
    await user.keyboard("{Escape}");
    // Read again, it loads, and the panel runs with its value.
    broken = false;
    await user.click(screen.getByRole("button", { name: "Namespace: couldn't load" }));
    await user.click(within(screen.getByRole("group", { name: "Namespace" })).getByRole("button", { name: "Try again" }));
    expect(await restarts.findByText("chart 1")).toBeTruthy();
    expect(batches(api).every((b) => b.every((q) => q.query.includes('namespace=~"api"')))).toBe(true);
  });

  it("a panel using an unrelated variable keeps running when another variable reloads", async () => {
    const user = userEvent.setup();
    const doc = spec("Mixed", [
      panel("a", "Restarts", 'kube_pod_restarts{pod=~"$pod"}', { x: 0 }),
      panel("b", "Jobs", 'up{job=~"$job"}', { x: 12 }),
    ], [
      variable("namespace", "Namespace"),
      variable("pod", "Pod", { match: 'kube_pod_info{namespace="$namespace"}', multi: true, includeAll: true, default: "all" }),
      variable("job", "Job"),
    ]);
    const api = installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      dashboards: { d1: seedDashboard("d1", SHOP, doc) },
      labelValues: { "p1|namespace": ["api", "web"], "p1|pod": ["api-1"], "p1|job": ["node"] },
      queryAnswers: { 'kube_pod_restarts{pod=~".+"}': ok, 'up{job=~"node"}': ok },
    }, fallback);
    // The pods of "web" take their time.
    const slow = gate();
    intercept((url, pass) => (url.includes("label=pod") && decodeURIComponent(url).includes('"web"') ? slow.opened.then(pass) : null));
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    const jobs = within(await screen.findByRole("region", { name: "Jobs" }));
    expect(await jobs.findByText("chart 1")).toBeTruthy();
    await waitFor(() => expect(batches(api).length).toBe(2));
    const jobRuns = () => batches(api).filter((b) => b[0].query === 'up{job=~"node"}').length;

    await user.click(screen.getByRole("button", { name: "Namespace: api" }));
    await user.click(within(screen.getByRole("group", { name: "Namespace" })).getByRole("radio", { name: "web" }));
    // Pod is reloading: its panel waits, the Jobs panel doesn't.
    const restarts = within(screen.getByRole("region", { name: "Restarts" }));
    expect(await restarts.findByText("Loading…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Job: node" })).toBeTruthy();
    expect(jobs.queryByText("Loading…")).toBeNull();
    expect(jobs.getByText("chart 1")).toBeTruthy();
    expect(jobRuns()).toBe(1);
    slow.open();
    expect(await restarts.findByText("chart 1")).toBeTruthy();
    expect(jobRuns()).toBe(1);
  });

  it("a panel waits for its variables before running", async () => {
    const { api, answer, view } = seed(undefined);
    answer['kube_pod_restarts{namespace=~"api", pod=~".+"}'] = ok;
    renderMonitoringApp({ tabs: tabsWith(view) });
    expect(await screen.findByText("chart 1")).toBeTruthy();
    // Every batch sent carried the loaded values: none ran with an empty namespace.
    expect(batches(api).every((b) => b.every((q) => q.query.includes('namespace=~"api"')))).toBe(true);
  });

  it("focusing the window reads neither values nor panels again", async () => {
    const { api, answer, view } = seed(undefined);
    answer['kube_pod_restarts{namespace=~"api", pod=~".+"}'] = ok;
    renderMonitoringApp({ tabs: tabsWith(view) });
    expect(await screen.findByText("chart 1")).toBeTruthy();
    const reads = labelReads(api).length;
    const sent = batches(api).length;
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await new Promise((r) => setTimeout(r, 30));
    expect(labelReads(api).length).toBe(reads);
    expect(batches(api).length).toBe(sent);
    focusManager.setFocused(undefined);
  });

  it("a long value menu has a filter", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 12 }, (_, i) => `ns-${String(i).padStart(2, "0")}`);
    const doc = spec("Pods", [panel("p-1", "Restarts", "up")], [variable("namespace", "Namespace", { includeAll: true })]);
    installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      dashboards: { d1: seedDashboard("d1", SHOP, doc) },
      labelValues: { "p1|namespace": many },
      queryAnswers: {},
    }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard" as const, id: "d1" }) });
    await user.click(await screen.findByRole("button", { name: "Namespace: ns-00" }));
    const list = screen.getByRole("group", { name: "Namespace" });
    const filter = within(list).getByRole("textbox", { name: "Filter values" });
    expect(document.activeElement).toBe(filter);
    await user.type(filter, "ns-0");
    expect(within(list).getAllByRole("radio").map((r) => r.parentElement!.textContent)).toEqual(["All", ...many.slice(0, 10)]);
    // Down lands on the chosen value, not on All above it.
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(list).getByRole("radio", { name: "ns-00" }));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("opening a menu doesn't scroll the page", async () => {
    const user = userEvent.setup();
    const { answer, view } = seed(undefined);
    answer['kube_pod_restarts{namespace=~"api", pod=~".+"}'] = ok;
    renderMonitoringApp({ tabs: tabsWith(view) });
    const button = await screen.findByRole("button", { name: "Namespace: api" });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await user.click(button);
    const asked = focus.mock.calls.filter(([o]) => o !== undefined);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(([o]) => (o as FocusOptions).preventScroll === true)).toBe(true);
    focus.mockRestore();
  });

  it("panel titles show the chosen values", async () => {
    const doc = spec("Pods", [panel("p-1", "CPU in $namespace", "up")], [variable("namespace", "Namespace")]);
    installFakeMonitoringApi({
      projects: [linkedProject("p1", "Shop", "s1")],
      dashboards: { d1: seedDashboard("d1", SHOP, doc) },
      labelValues: { "p1|namespace": ["api", "web"] },
      queryAnswers: {},
    }, fallback);
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard" as const, id: "d1" }) });
    expect(await screen.findByRole("heading", { level: 2, name: "CPU in api" })).toBeTruthy();
  });
});
