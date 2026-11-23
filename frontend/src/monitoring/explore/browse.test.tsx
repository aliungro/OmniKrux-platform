import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryResponse } from "../api/types";
import type { CatalogOut } from "../catalog/api";
import { catalogOf, metric, source, stream } from "../catalog/fixtures";
import { fakeBox } from "../charts/panelFixtures";
import { intercept, linkedProject, linkTo, serverFailure } from "../test/dashboardSeeds";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import type { ExploreView } from "../shell/tabState";

vi.mock("../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", { "data-chart": "" }, `chart ${data.series.length}`) };
});

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const answer: Partial<QueryResponse> = { result_type: "matrix", series: [{ labels: { job: "a" }, points: [[1, 1], [2, 2]] }], took_ms: 5 };

const BUILT = new Date(Date.now() - 5 * 60_000).toISOString();
const histogram = ["_bucket", "_sum", "_count"].map((suffix) =>
  metric(`http_request_duration_seconds${suffix}`, { type: "histogram", family: "http_request_duration_seconds", labels: suffix === "_bucket" ? ["le", "route"] : ["route"] }));
const promCatalog = (): CatalogOut => catalogOf("p1", source("s1", {
  built_at: BUILT,
  metrics: [
    metric("http_requests_total", { type: "counter", labels: ["pod", "route", "status"] }),
    ...histogram,
    metric("container_memory_working_set_bytes", { type: "gauge", labels: ["namespace"] }),
    metric("up", { type: "gauge", labels: ["job"] }),
  ],
}));
const lokiCatalog = (): CatalogOut => catalogOf("p1", source("l1", {
  source_type: "loki", built_at: BUILT,
  streams: [stream("app", ["api", "web"]), stream("level", ["error", "info"])],
}));

type Batch = { queries: { query: string; project_id: string }[] };
const batches = (api: FakeMonitoringApi) => api.requests.filter((r) => r.url === "/api/monitoring/query/batch").map((r) => r.body as Batch);

function prom(catalog: CatalogOut = promCatalog(), extra: Partial<Parameters<typeof installFakeMonitoringApi>[0]> = {}) {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "prod-east", "s1")],
    catalogs: { p1: catalog },
    queryAnswers: new Proxy({} as never, { get: () => answer }),
    labelValues: { "p1|status": ["200", "404", "500"], "p1|pod": ["a", "b"], "p1|route": ["/x"] },
    ...extra,
  }, async () => json([]));
}
function loki() {
  return installFakeMonitoringApi({
    projects: [{ ...seedProject("p1", "prod-east"), links: [linkTo("l1", "loki")] }],
    catalogs: { p1: lokiCatalog() },
    queryAnswers: new Proxy({} as never, { get: () => answer }),
  }, async () => json([]));
}

async function openExplore(view: ExploreView = { page: "explore", project: "p1" }) {
  renderMonitoringApp({ tabs: tabsWith(view) });
  const heading = await screen.findByRole("heading", { level: 1, name: "Explore" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
}
const query = () => screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement;
const list = () => screen.findByRole("listbox", { name: /^(Metrics|Log streams)$/ });
const pickMetric = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  const box = await list();
  await user.click(await within(box).findByRole("option", { name: new RegExp(`^${name}\\b`) }));
};

describe("Browse metrics and log streams", () => {
  beforeEach(() => fakeBox());

  it("the list shows counts, names and types", async () => {
    prom();
    await openExplore();
    expect(await screen.findByRole("heading", { name: "Metrics in prod-east · 4" })).toBeTruthy();
    const box = await list();
    expect(box.getAttribute("aria-keyshortcuts")).toBe("b");
    const option = within(box).getByRole("option", { name: /http_requests_total/ });
    expect(within(option).getByText("counter")).toBeTruthy();
    // The histogram family is one line.
    expect(within(box).getAllByRole("option")).toHaveLength(4);
    expect(within(box).getByText("http_request_duration_seconds")).toBeTruthy();
    expect(await screen.findByText("Known metrics from 5 min ago")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh list" })).toBeTruthy();
  });

  it("picking a metric writes and runs its query", async () => {
    const api = prom();
    const user = userEvent.setup();
    await openExplore();
    await pickMetric(user, "http_requests_total");
    const text = "sum by (route) (rate(http_requests_total[$__rate_interval]))";
    expect(query().value).toBe(text);
    // The run reads the text with its variables filled in, on this project.
    await waitFor(() => expect(batches(api).at(-1)?.queries[0]).toMatchObject({ query: expect.stringMatching(/^sum by \(route\) \(rate\(http_requests_total\[\d+\w\]\)\)$/), project_id: "p1" }));
    // The keyboard stays in the list.
    expect(document.activeElement).toBe(await list());
    expect(screen.getByRole("option", { name: /http_requests_total/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("an Only chip narrows the query", async () => {
    const api = prom();
    const user = userEvent.setup();
    await openExplore();
    await pickMetric(user, "http_requests_total");
    const chip = await screen.findByRole("button", { name: "status=500" });
    await user.click(chip);
    expect(query().value).toBe('sum by (route) (rate(http_requests_total{status="500"}[$__rate_interval]))');
    expect(screen.getByRole("button", { name: "status=500" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "status=500" }));
    await waitFor(() => expect(batches(api).at(-1)?.queries[0].query).toContain('status="500"'));
    // The values were read for this project and the metric.
    const read = api.requests.find((r) => r.url.startsWith("/api/monitoring/label-values") && r.url.includes("label=status"));
    expect(read?.url).toContain("project_id=p1");
    expect(decodeURIComponent(read?.url ?? "")).toContain("match=http_requests_total");
    // Again: the chip toggles off.
    await user.click(screen.getByRole("button", { name: "status=500" }));
    expect(query().value).toBe("sum by (route) (rate(http_requests_total[$__rate_interval]))");
  });

  it("Only offers namespace, pod and container ahead of kube-state-metrics' chart labels", async () => {
    const ksm = [
      "app_kubernetes_io_component", "app_kubernetes_io_instance", "app_kubernetes_io_managed_by",
      "app_kubernetes_io_name", "app_kubernetes_io_part_of", "app_kubernetes_io_version",
      "container", "helm_sh_chart", "namespace", "pod", "uid",
    ];
    prom(catalogOf("p1", source("s1", {
      built_at: BUILT,
      metrics: [metric("kube_pod_container_status_restarts_total", { type: "counter", labels: ksm })],
    })), { labelValues: { "p1|namespace": ["demo", "kube-system"], "p1|pod": ["a"], "p1|container": ["c"] } });
    const user = userEvent.setup();
    await openExplore();
    await pickMetric(user, "kube_pod_container_status_restarts_total");
    const only = await screen.findByRole("group", { name: "Only" });
    const shown = [...only.querySelectorAll<HTMLElement>("[data-label]")].map((el) => el.dataset.label);
    expect(shown.slice(0, 3)).toEqual(["namespace", "pod", "container"]);
    expect(shown).toHaveLength(6);
    await user.click(await within(only).findByRole("button", { name: "namespace=demo" }));
    expect(query().value).toBe('sum(rate(kube_pod_container_status_restarts_total{namespace="demo"}[$__rate_interval]))');
  });

  it("Split by another label rewrites the query", async () => {
    prom();
    const user = userEvent.setup();
    await openExplore();
    await pickMetric(user, "http_requests_total");
    expect(await screen.findByRole("button", { name: "route" })).toHaveProperty("ariaPressed", "true");
    await user.click(screen.getByRole("button", { name: "pod" }));
    expect(query().value).toBe("sum by (pod) (rate(http_requests_total[$__rate_interval]))");
    expect(screen.getByRole("button", { name: "pod" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "pod" }));
    // The split label is no longer an Only chip.
    expect(screen.queryByRole("button", { name: "pod=a" })).toBeNull();
    expect(screen.getByRole("button", { name: "route=/x" })).toBeTruthy();
  });

  it("more… opens the other values and returns the keyboard to its chip", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `v${String(i).padStart(2, "0")}`);
    prom(promCatalog(), { labelValues: { "p1|status": many } });
    const user = userEvent.setup();
    await openExplore();
    await pickMetric(user, "http_requests_total");
    expect(await screen.findByRole("button", { name: "status=v07" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "status=v08" })).toBeNull();
    const more = screen.getByRole("button", { name: "status: more…" });
    await user.click(more);
    const field = screen.getByRole("combobox", { name: "Filter values" });
    expect(document.activeElement).toBe(field);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("combobox", { name: "Filter values" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "status: more…" }));
    await user.click(screen.getByRole("button", { name: "status: more…" }));
    await user.type(screen.getByRole("combobox", { name: "Filter values" }), "v10");
    await user.click(screen.getByRole("option", { name: "v10" }));
    expect(query().value).toContain('status="v10"');
    expect(screen.getByRole("button", { name: "status=v10" }).getAttribute("aria-pressed")).toBe("true");
    // Off again: its chip goes away, and the keyboard goes to the row's more….
    await user.click(screen.getByRole("button", { name: "status=v10" }));
    expect(screen.queryByRole("button", { name: "status=v10" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "status: more…" }));
  });

  it("editing by hand shows the detached line", async () => {
    prom();
    const user = userEvent.setup();
    await openExplore();
    await pickMetric(user, "http_requests_total");
    await screen.findByRole("button", { name: "route" });
    const line = "You edited the query by hand. Clicking a chip writes it again from the chips.";
    expect(screen.queryByText(line)).toBeNull();
    fireEvent.change(query(), { target: { value: "up" } });
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByRole("button", { name: "route" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "pod" }));
    expect(screen.queryByText(line)).toBeNull();
    expect(query().value).toBe("sum by (pod) (rate(http_requests_total[$__rate_interval]))");
  });

  it("the filter narrows the list and Esc clears it", async () => {
    prom();
    const user = userEvent.setup();
    await openExplore();
    const box = await list();
    const filter = screen.getByRole("textbox", { name: "Filter the list" });
    await user.type(filter, "mem");
    await waitFor(() => expect(within(box).getAllByRole("option")).toHaveLength(1));
    expect(within(box).getByText("container_memory_working_set_bytes")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect((filter as HTMLInputElement).value).toBe("");
    expect(within(box).getAllByRole("option")).toHaveLength(4);
    expect(document.activeElement).toBe(filter);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(box);
  });

  it("moves with the arrows and picks with Enter", async () => {
    prom();
    const user = userEvent.setup();
    await openExplore();
    const box = await list();
    box.focus();
    // Sorted: container_memory_working_set_bytes, http_request_duration_seconds, http_requests_total, up.
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(query().value).toBe("sum by (route) (rate(http_requests_total[$__rate_interval]))");
    expect(document.activeElement).toBe(box);
  });

  it("log streams are grouped by label", async () => {
    const api = loki();
    const user = userEvent.setup();
    await openExplore();
    expect(await screen.findByRole("heading", { name: "Log streams in prod-east · 4" })).toBeTruthy();
    const box = await list();
    expect(box.getAttribute("aria-label")).toBe("Log streams");
    const app = within(box).getByRole("group", { name: "app" });
    expect(within(app).getAllByRole("option").map((o) => o.textContent)).toEqual(["app = api", "app = web"]);
    expect(within(box).getByRole("group", { name: "level" })).toBeTruthy();
    await user.click(within(app).getByRole("option", { name: "app = api" }));
    expect(query().value).toBe('{app="api"}');
    await waitFor(() => expect(batches(api).at(-1)?.queries[0]).toMatchObject({ query: '{app="api"}', project_id: "p1" }));
    // Only chips use the stream values; Split by offers the stream labels.
    expect(await screen.findByRole("button", { name: "level=error" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "level=error" }));
    expect(query().value).toBe('{app="api",level="error"}');
    // The label picked from the list is the stream: it isn't offered as a split.
    expect(screen.queryByRole("button", { name: "app" })).toBeNull();
  });

  it("log stream chips keep the chosen stream and read nothing twice", async () => {
    const warned = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
    const api = loki();
    const user = userEvent.setup();
    await openExplore();
    const box = await list();
    await user.click(within(box).getByRole("option", { name: "app = api" }));
    // Logs mode charts the volume and lists the lines (Task 14): one read of the lines.
    const lineReads = () => batches(api).filter((b) => b.queries[0].query === '{app="api"}');
    await waitFor(() => expect(lineReads()).toHaveLength(1));
    const before = batches(api).length;
    await user.click(await screen.findByRole("button", { name: "level" }));
    expect(screen.getByRole("button", { name: "level" }).getAttribute("aria-pressed")).toBe("true");
    // The stream stays chosen and the text is the same: the lines aren't read again; only the
    // volume chart splits by the label.
    expect(query().value).toBe('{app="api"}');
    expect(screen.getByRole("button", { name: "app=api" }).getAttribute("aria-pressed")).toBe("true");
    await new Promise((r) => setTimeout(r, 450));
    expect(lineReads()).toHaveLength(1);
    expect(batches(api)).toHaveLength(before + 1);
    expect(batches(api).at(-1)?.queries[0].query).toMatch(/^sum by \(level\) \(count_over_time\(\{app="api"\}\[\d+[smh]\]\)\)$/);
    expect(api.requests.some((r) => r.url.startsWith("/api/monitoring/label-values"))).toBe(false);
    expect(warned.flatMap((w) => w.mock.calls).filter((c) => String(c[0]).includes("Duplicate"))).toEqual([]);
  });

  it("chips leave out le and quantile for any metric", async () => {
    prom(catalogOf("p1", source("s1", { built_at: BUILT, metrics: [metric("wait_total", { type: "counter", labels: ["le", "quantile", "route"] })] })));
    const user = userEvent.setup();
    await openExplore();
    await pickMetric(user, "wait_total");
    await screen.findByRole("button", { name: "route" });
    expect(screen.queryByRole("button", { name: "le" })).toBeNull();
    expect(screen.queryByRole("button", { name: "quantile" })).toBeNull();
  });

  it("values that can't be read say why and can be tried again", async () => {
    prom();
    intercept((url) => (url.includes("/label-values") ? serverFailure(502, "unreachable", "Prometheus didn't answer in time.") : null));
    const user = userEvent.setup();
    await openExplore();
    await pickMetric(user, "http_requests_total");
    expect(await screen.findByText(/status: couldn't read its values: Prometheus didn't answer in time\./)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Try again" }).length).toBeGreaterThan(0);
  });

  it("b focuses the list", async () => {
    prom();
    const user = userEvent.setup();
    await openExplore();
    const box = await list();
    await user.keyboard("b");
    expect(document.activeElement).toBe(box);
  });

  it("letters typed on the list go into its filter", async () => {
    prom();
    const user = userEvent.setup();
    await openExplore();
    const box = await list();
    await user.keyboard("b");
    expect(document.activeElement).toBe(box);
    await user.keyboard("up");
    const filter = screen.getByRole("textbox", { name: "Filter the list" }) as HTMLInputElement;
    expect(document.activeElement).toBe(filter);
    expect(filter.value).toBe("up");
    await waitFor(() => expect(within(box).getAllByRole("option").map((o) => o.textContent)).toEqual(["up gauge"]));
    // The query and the page's letters are left alone.
    expect(query().value).toBe("");
  });

  it("a catalog that can't be read says so and tries again", async () => {
    prom(promCatalog(), { catalogs: {} });
    const user = userEvent.setup();
    await openExplore();
    expect(await screen.findByText(/^Couldn't read the list: /)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
  });

  it("a list of 5000 metrics renders only the visible rows", async () => {
    const many = catalogOf("p1", source("s1", {
      built_at: BUILT,
      metrics: Array.from({ length: 5000 }, (_, i) => metric(`metric_${String(i).padStart(4, "0")}_total`, { type: "counter", labels: ["route"] })),
    }));
    prom(many);
    await openExplore();
    expect(await screen.findByRole("heading", { name: "Metrics in prod-east · 5000" })).toBeTruthy();
    const box = await list();
    await waitFor(() => expect(within(box).getAllByRole("option").length).toBeGreaterThan(0));
    expect(within(box).getAllByRole("option").length).toBeLessThan(60);
  });
});
