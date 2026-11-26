import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryResponse } from "../api/types";
import { catalogOf, metric, source } from "../catalog/fixtures";
import { recordRecent } from "../home/recent";
import { gate, intercept, linkedProject, linkTo, seedDashboard, spec } from "../test/dashboardSeeds";
import { installFakeMonitoringApi, type FakeMonitoringApi, type FakeQueryAnswer } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import type { ExploreView } from "../shell/tabState";
import { pushTrail, readTrail } from "./trailStore";

// The chart chunk as a stub: it prints how many series it was given.
vi.mock("../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", { "data-chart": "" }, `chart ${data.series.length}`) };
});

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const three: Partial<QueryResponse> = {
  result_type: "matrix",
  series: ["a", "b", "c"].map((job) => ({ labels: { job }, points: [[1, 1], [2, 2]] as [number, number][] })),
  took_ms: 41,
};

/** Shop (p1) with one Prometheus source; every query answers `answer` unless `answers` names it. */
function shop(answers: Record<string, FakeQueryAnswer> = {}, answer: FakeQueryAnswer = three, extra: Parameters<typeof installFakeMonitoringApi>[0] = {}): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    queryAnswers: new Proxy({} as Record<string, FakeQueryAnswer>, { get: (_, key) => answers[String(key).replace(/^p1\|/, "")] ?? answer }),
    ...extra,
  }, async () => json([]));
}

type Batch = { queries: { query: string; project_id: string }[] };
const batches = (api: FakeMonitoringApi) => api.requests.filter((r) => r.url === "/api/monitoring/query/batch").map((r) => r.body as Batch);
const query = () => screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement;
const meta = () => document.querySelector("[data-explore-meta]") as HTMLElement;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const one: Partial<QueryResponse> = { result_type: "matrix", series: [{ labels: { job: "a" }, points: [[1, 1], [2, 2]] }], took_ms: 7 };
/** Two projects (Alpha p1 on s1 and s3, Zoo p2 on s2); answers keyed "<project>|<text>". */
function twoProjects(answers: Record<string, FakeQueryAnswer>): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [linkedProject("p1", "Alpha", "s1", "s3"), linkedProject("p2", "Zoo", "s2")],
    queryAnswers: new Proxy({} as Record<string, FakeQueryAnswer>, { get: (_, key) => answers[String(key)] }),
  }, async () => json([]));
}
/** Holds every batch request while `hold.on`, until `hold.release()`. */
function holdBatches() {
  const held = gate();
  const hold = { on: false, release: () => held.open() };
  intercept((url, pass) => (hold.on && url.includes("/query/batch") ? held.opened.then(pass) : null));
  return hold;
}

async function openExplore(view: ExploreView = { page: "explore", project: "p1", expr: "up" }) {
  const result = renderMonitoringApp({ tabs: tabsWith(view) });
  const heading = await screen.findByRole("heading", { level: 1, name: "Explore" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  return { ...result, heading };
}

describe("Explore", () => {
  it("a second click on the time button closes the menu, and Esc and Tab away still do", async () => {
    installFakeMonitoringApi({ projects: [linkedProject("p1", "Alpha", "s1")] }, async () => json([]));
    const user = userEvent.setup();
    await openExplore({ page: "explore", project: "p1" });
    const button = await screen.findByRole("button", { name: /Last 1 hour/ });
    await user.click(button);
    expect(screen.getByRole("menu", { name: "Time range" })).toBeTruthy();
    await user.click(button);
    expect(screen.queryByRole("menu", { name: "Time range" })).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.click(button);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Time range" })).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.click(button);
    // Shift+Tab back to the button closes the menu as before.
    await user.tab({ shift: true });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Time range" })).toBeNull());
    await user.click(button);
    await user.tab();
    await user.tab();
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Time range" })).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("opens on the most recent project with focus on the heading", async () => {
    installFakeMonitoringApi({ projects: [linkedProject("p1", "Alpha", "s1"), linkedProject("p2", "Zoo", "s2")] }, async () => json([]));
    recordRecent({ kind: "project", id: "p1" }, 1);
    recordRecent({ kind: "project", id: "p2" }, 2);
    await openExplore({ page: "explore" });
    const project = await screen.findByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    await waitFor(() => expect(project.value).toBe("p2"));
    const source = await screen.findByRole("combobox", { name: "Source" }) as HTMLSelectElement;
    await waitFor(() => expect(within(source).getByRole("option", { name: "s2 name · Prometheus-compatible" })).toBeTruthy());
    expect(screen.getByRole("button", { name: /Last 1 hour/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to dashboard" }).getAttribute("aria-keyshortcuts")).toBe("a");
    expect(query().getAttribute("aria-keyshortcuts")).toBe("q");
    expect(query().getAttribute("spellcheck")).toBe("false");
    expect(meta().textContent).toBe("Pick a metric on the left, or type a query.");
  });

  it("an empty run has no green check", async () => {
    shop({}, { result_type: "matrix", series: [], took_ms: 5 });
    await openExplore();
    await waitFor(() => expect(meta().textContent).toContain("0 series · 5 ms"));
    expect(meta().textContent).not.toContain("✓");
    expect(meta().querySelector("span")?.className ?? "").not.toMatch(/metaOk/);
  });

  it("an unknown metric is named", async () => {
    const catalogs = (state: "ok" | "partial") => ({ p1: catalogOf("p1", source("s1", { state, metrics: [metric("http_requests_total", { type: "counter", labels: ["job"], series: 3 })] })) });
    shop({}, { result_type: "matrix", series: [], took_ms: 5 }, { catalogs: catalogs("ok") });
    await openExplore({ page: "explore", project: "p1", expr: "rate(nope_total[5m])" });
    await waitFor(() => expect(meta().textContent).toMatch(/0 series.*No metric named nope_total in .+ for this project\./));
    cleanup();
    // A name the catalog lists is never called missing.
    shop({}, { result_type: "matrix", series: [], took_ms: 5 }, { catalogs: catalogs("ok") });
    await openExplore({ page: "explore", project: "p1", expr: "http_requests_total" });
    await waitFor(() => expect(meta().textContent).toContain("0 series"));
    expect(meta().textContent).not.toContain("No metric named");
  });

  it("a partial catalog names no missing metric", async () => {
    shop({}, { result_type: "matrix", series: [], took_ms: 5 }, {
      catalogs: { p1: catalogOf("p1", source("s1", { state: "partial", metrics: [metric("http_requests_total", { series: 3 })] })) },
    });
    await openExplore({ page: "explore", project: "p1", expr: "rate(nope_total[5m])" });
    await waitFor(() => expect(meta().textContent).toContain("0 series"));
    await pause(50);
    expect(meta().textContent).not.toContain("No metric named");
  });

  it("meta line reads like the prototype", async () => {
    const api = shop();
    await openExplore();
    await waitFor(() => expect(meta().textContent).toContain("✓ 3 series · 41 ms"));
    expect(meta().getAttribute("aria-live")).toBe("polite");
    expect(meta().textContent).toContain("Last 1 hour");
    expect(meta().textContent).toMatch(/updated \d\d:\d\d:\d\d/);
    expect(await screen.findByText("chart 3")).toBeTruthy();
    expect(batches(api)).toHaveLength(1);
    expect(batches(api)[0].queries).toEqual([expect.objectContaining({ query: "up", project_id: "p1", source_id: "s1" })]);
  });

  it("an invalid query dims the last good chart and says so", async () => {
    const api = shop();
    await openExplore();
    await screen.findByText("chart 3");
    fireEvent.change(query(), { target: { value: "sum(up" } });
    await waitFor(() => expect(meta().textContent).toBe("✗ The query has an unclosed quote or bracket. · showing the last result"));
    const label = screen.getByText("Last good result");
    const chart = screen.getByText("chart 3");
    expect(chart.closest("[data-dim]")?.getAttribute("data-dim")).toBe("true");
    expect(within(label.closest("[data-last-good]") as HTMLElement).getByText("up")).toBeTruthy();
    expect(batches(api)).toHaveLength(1);
  });

  it("several queries say Explore runs one at a time", async () => {
    const ONE = "Explore runs one query at a time. Keep one query in the field, or run them one after another.";
    const api = shop();
    await openExplore({ page: "explore", project: "p1", expr: "up\nrate(x[5m])" });
    await waitFor(() => expect(meta().textContent).toBe(`✗ ${ONE}`));
    expect(batches(api)).toHaveLength(0);
    // A text to fix, not a failure: no failure panel and no Try again.
    expect(screen.queryByRole("heading", { name: /^(Query error|Source unreachable)$/ })).toBeNull();
    expect(document.querySelector("[aria-labelledby='explore-failure-title']")).toBeNull();
    expect(screen.getByRole("button", { name: "Add to dashboard" }).getAttribute("aria-disabled")).toBe("true");
    // After a good run the same refusal keeps the last good result, captioned with its own text.
    fireEvent.change(query(), { target: { value: "up" } });
    await screen.findByText("chart 3");
    fireEvent.change(query(), { target: { value: "up\nsum(up)" } });
    await waitFor(() => expect(meta().textContent).toBe(`✗ ${ONE} · showing the last result`));
    const label = screen.getByText("Last good result");
    expect((label.closest("[data-last-good]") as HTMLElement).querySelector("code")?.textContent).toBe("up");
    expect(batches(api)).toHaveLength(1);
    // One query over two lines is still one query.
    fireEvent.change(query(), { target: { value: "up\nor vector(0)" } });
    await waitFor(() => expect(batches(api)).toHaveLength(2));
    expect(batches(api)[1].queries[0].query).toBe("up\nor vector(0)");
  });

  it("an empty metric answer says why once the reason arrives", async () => {
    const MISSING = "This Prometheus doesn't collect node metrics (node-exporter) for this project: node_load1 has no series.";
    const api = shop({ node_load1: { result_type: "matrix", series: [] } }, three, { whyEmpty: { reason: "missing_metric", message: MISSING } });
    await openExplore({ page: "explore", project: "p1", expr: "node_load1" });
    const reason = await screen.findByText(MISSING);
    expect(reason.hasAttribute("data-empty-reason")).toBe(true);
    expect(screen.queryByText("No data in this time range.")).toBeNull();
    const why = api.requests.filter((r) => r.url === "/api/monitoring/query/why-empty");
    expect(why).toHaveLength(1);
    expect(why[0].body).toMatchObject({ source_id: "s1", project_id: "p1", query: "node_load1", metrics: ["node_load1"] });
    // A new text with data: the reason goes with the empty answer it was about.
    fireEvent.change(query(), { target: { value: "up" } });
    expect(await screen.findByText("chart 3")).toBeTruthy();
    expect(screen.queryByText(MISSING)).toBeNull();
    expect(api.requests.filter((r) => r.url === "/api/monitoring/query/why-empty")).toHaveLength(1);
  });

  it("a failed run shows Source unreachable with Try again", async () => {
    const api = shop({ up: { error: { code: "unreachable", message: "Prometheus didn't answer in time." }, status: 502 } });
    await openExplore();
    expect(await screen.findByRole("heading", { name: "Source unreachable" })).toBeTruthy();
    expect(screen.getByText("Prometheus didn't answer in time.")).toBeTruthy();
    expect(screen.queryByText(/^chart /)).toBeNull();
    expect(screen.queryByText("Last good result")).toBeNull();
    fireEvent.click(within(screen.getByRole("group", { name: "Source unreachable" })).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(batches(api)).toHaveLength(2));
  });

  it("the trail restores a query by keyboard", async () => {
    const api = shop();
    pushTrail("p1", { expr: "up", sourceId: "s1", at: 1 });
    pushTrail("p1", { expr: "rate(x[5m])", sourceId: "s1", at: 2 });
    const user = userEvent.setup();
    await openExplore({ page: "explore", project: "p1", expr: "rate(x[5m])" });
    await screen.findByText("chart 3");
    const trail = screen.getByRole("toolbar", { name: "Recent queries" });
    const current = within(trail).getByRole("button", { name: "rate(x[5m])" });
    expect(current.getAttribute("aria-current")).toBe("true");
    query().focus();
    for (let i = 0; i < 10 && !trail.contains(document.activeElement); i++) await user.tab();
    expect(document.activeElement).toBe(current);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(within(trail).getByRole("button", { name: "up" }));
    const before = batches(api).length;
    await user.keyboard("{Enter}");
    expect(query().value).toBe("up");
    await waitFor(() => expect(batches(api)).toHaveLength(before + 1));
    expect(batches(api)[before].queries[0].query).toBe("up");
    expect(document.activeElement).not.toBe(document.body);
  });

  it("the query survives a reload of the tab", async () => {
    let api = shop();
    const { current, unmount } = await openExplore({ page: "explore", project: "p1" });
    await screen.findByRole("textbox", { name: "Query" });
    fireEvent.change(query(), { target: { value: "up" } });
    await waitFor(() => expect((current().tabs[0].view as ExploreView).expr).toBe("up"));
    const saved = current().tabs[0].view as ExploreView;
    expect(saved).toMatchObject({ page: "explore", project: "p1", source: "s1", expr: "up", time: { from: "now-1h", to: "now" } });
    unmount();
    vi.unstubAllGlobals();
    api = shop();
    await openExplore(saved);
    expect((await screen.findByRole("textbox", { name: "Query" }) as HTMLTextAreaElement).value).toBe("up");
    await screen.findByText("chart 3");
    await pause(400);
    expect(batches(api)).toHaveLength(1);
  });

  it("q focuses the query, Esc leaves it to the chart", async () => {
    shop();
    const user = userEvent.setup();
    await openExplore();
    await screen.findByText("chart 3");
    await user.keyboard("q");
    expect(document.activeElement).toBe(query());
    expect(query().value).toBe("up");
    await user.keyboard("{Escape}");
    expect(document.activeElement?.closest("[data-explore-chart]")).toBeTruthy();
  });

  it("typing in Explore keeps focus in the query after its view is written", async () => {
    shop();
    const { current } = await openExplore();
    await screen.findByText("chart 3");
    query().focus();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(query(), { target: { value: "up2" } });
    act(() => { vi.advanceTimersByTime(350); });
    vi.useRealTimers();
    expect((current().tabs[0].view as ExploreView).expr).toBe("up2");
    expect(document.activeElement).toBe(query());
    // A view write records nothing: Back still leads where the tab came from (nowhere).
    expect(current().tabs[0].back).toHaveLength(0);
  });

  it("the Explore tab from the sidebar takes the current project", async () => {
    installFakeMonitoringApi({ projects: [linkedProject("p1", "Alpha", "s1"), linkedProject("p2", "Zoo", "s2")] }, async () => json([]));
    recordRecent({ kind: "project", id: "p1" }, 5);
    renderMonitoringApp({ tabs: tabsWith({ page: "project", id: "p2" }) });
    await screen.findByRole("heading", { level: 1, name: "Zoo" });
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    await screen.findByRole("heading", { level: 1, name: "Explore" });
    const project = await screen.findByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    await waitFor(() => expect(project.value).toBe("p2"));
    expect(screen.getByRole("button", { name: "Explore" }).getAttribute("aria-current")).toBe("page");
  });

  it("Apply on a recommendation rewrites the query, runs it and keeps the hand-written one", async () => {
    const api = shop();
    await openExplore({ page: "explore", project: "p1", expr: "http_requests_total" });
    await screen.findByText("chart 3");
    const bar = await screen.findByRole("region", { name: "Recommendation" });
    const before = batches(api).length;
    fireEvent.click(within(bar).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(query().value).toMatch(/^rate\(http_requests_total\[/));
    await waitFor(() => expect(batches(api)).toHaveLength(before + 1));
    expect(batches(api)[before].queries[0].query).toMatch(/^rate\(http_requests_total\[\d+[smh]\]\)$/);
    const trail = screen.getByRole("toolbar", { name: "Recent queries" });
    expect(within(trail).getByRole("button", { name: "http_requests_total" })).toBeTruthy();
    expect(document.activeElement).toBe(query());
  });

  it("the live meta line changes only when a run ends, and names the range that run read", async () => {
    shop({ up2: one });
    const hold = holdBatches();
    await openExplore();
    await waitFor(() => expect(meta().textContent).toContain("✓ 3 series · 41 ms"));
    const before = meta().textContent;
    const seen: string[] = [];
    const watch = new MutationObserver(() => seen.push(meta().textContent ?? ""));
    watch.observe(meta(), { childList: true, subtree: true, characterData: true });
    hold.on = true;
    fireEvent.change(query(), { target: { value: "up2" } });
    // Running… shows beside the live line, never inside it.
    await waitFor(() => expect(document.querySelector("[data-explore-running]")?.textContent).toBe("Running…"));
    expect(meta().contains(document.querySelector("[data-explore-running]"))).toBe(false);
    expect(meta().textContent).toBe(before);
    // The picker's new range isn't the finished run's: the line keeps the range that run read.
    fireEvent.click(screen.getByRole("button", { name: /Last 1 hour/ }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Last 6 hours/ }));
    expect(meta().textContent).toBe(before);
    expect(seen).toEqual([]);
    hold.release();
    await waitFor(() => expect(meta().textContent).toContain("✓ 1 series · 7 ms"));
    await waitFor(() => expect(meta().textContent).toContain("Last 6 hours"));
    expect(seen.every((t) => !t.includes("Running…"))).toBe(true);
    watch.disconnect();
  });

  it("a project switch never shows the old project's chart, last good included", async () => {
    twoProjects({ "p1|up": three, "p2|up": one });
    await openExplore({ page: "explore", project: "p1", expr: "up" });
    await screen.findByText("chart 3");
    fireEvent.change(query(), { target: { value: "sum(up" } });
    await screen.findByText("Last good result");
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "p2" } });
    expect(screen.queryByText("Last good result")).toBeNull();
    expect(screen.queryByText(/^chart /)).toBeNull();
    expect(meta()?.textContent ?? "").not.toMatch(/✓|showing the last result/);
    // Zoo reads the same text on its own: invalid, with nothing of Alpha's to show.
    await waitFor(() => expect(meta().textContent).toBe("✗ The query has an unclosed quote or bracket."));
    expect(screen.queryByText("Last good result")).toBeNull();
    expect(screen.queryByText(/^chart /)).toBeNull();
    // Back to Alpha (its project is cached): its earlier chart doesn't come back either.
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "p1" } });
    expect(screen.queryByText("Last good result")).toBeNull();
    expect(screen.queryByText(/^chart /)).toBeNull();
    expect(meta().textContent).not.toMatch(/✓|showing the last result/);
  });

  it("a source switch never shows the old source's chart", async () => {
    const api = twoProjects({ "p1|up": three });
    const hold = holdBatches();
    await openExplore({ page: "explore", project: "p1", source: "s1", expr: "up" });
    await screen.findByText("chart 3");
    hold.on = true;
    fireEvent.change(screen.getByRole("combobox", { name: "Source" }), { target: { value: "s3" } });
    // Through the pause and the run, nothing of s1's answer is drawn or reported as current.
    expect(screen.queryByText(/^chart /)).toBeNull();
    expect(meta().textContent).not.toContain("✓");
    await waitFor(() => expect(document.querySelector("[data-explore-running]")).toBeTruthy());
    expect(screen.queryByText(/^chart /)).toBeNull();
    expect(meta().textContent).not.toContain("✓");
    hold.release();
    await screen.findByText("chart 3");
    expect(batches(api).at(-1)?.queries[0]).toMatchObject({ source_id: "s3", project_id: "p1", query: "up" });
  });

  it("recommendations read only an answer about the text in the field", async () => {
    const noisy: Partial<QueryResponse> = {
      result_type: "matrix",
      series: [{ labels: { job: "api" }, points: Array.from({ length: 60 }, (_, i) => [1_000 + i * 15, i % 2 ? 10 : 0] as [number, number]) }],
    };
    shop({ "rate(x[1m])": noisy });
    await openExplore({ page: "explore", project: "p1", expr: "rate(x[1m])" });
    await screen.findByText("chart 1");
    expect(await screen.findByText(/The line is noisy at this window/)).toBeTruthy();
    // A new text: the noisy answer was about the old one, so nothing is suggested from it.
    fireEvent.change(query(), { target: { value: "rate(y[1m])" } });
    expect(screen.queryByText(/The line is noisy at this window/)).toBeNull();
    await screen.findByText("chart 3");
    expect(screen.queryByText(/The line is noisy at this window/)).toBeNull();
  });

  it("Ctrl+Enter keeps only a readable query in the trail", async () => {
    shop();
    await openExplore({ page: "explore", project: "p1" });
    await screen.findByRole("textbox", { name: "Query" });
    fireEvent.change(query(), { target: { value: "sum(up" } });
    fireEvent.keyDown(query(), { key: "Enter", ctrlKey: true });
    expect(readTrail("p1")).toEqual([]);
    fireEvent.change(query(), { target: { value: "sum(up)" } });
    fireEvent.keyDown(query(), { key: "Enter", ctrlKey: true });
    expect(readTrail("p1").map((e) => e.expr)).toEqual(["sum(up)"]);
  });

  it("typing just before switching tabs still lands in the Explore tab", async () => {
    shop();
    const { current } = renderMonitoringApp({ tabs: tabsWith({ page: "explore", project: "p1", expr: "up" }, { page: "home" }) });
    await screen.findByRole("textbox", { name: "Query" });
    fireEvent.change(query(), { target: { value: "up9" } });
    const strip = screen.getByRole("tablist", { name: "Monitoring tabs" });
    fireEvent.click(within(strip).getAllByRole("tab")[1]);
    await screen.findByRole("heading", { level: 1, name: "Monitoring" });
    expect((current().tabs[0].view as ExploreView).expr).toBe("up9");
    expect(current().tabs[1].view).toEqual({ page: "home" });
    fireEvent.click(within(strip).getAllByRole("tab")[0]);
    expect((await screen.findByRole("textbox", { name: "Query" }) as HTMLTextAreaElement).value).toBe("up9");
  });

  it("the sidebar's Explore from a project dashboard takes that dashboard's project", async () => {
    installFakeMonitoringApi({
      projects: [linkedProject("p1", "Alpha", "s1"), linkedProject("p2", "Zoo", "s2")],
      dashboards: { d1: seedDashboard("d1", { kind: "project", id: "p2", name: "Zoo" }, spec("Zoo board", [])) },
    }, async () => json([]));
    recordRecent({ kind: "project", id: "p1" }, 5);
    renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
    await screen.findByRole("heading", { level: 1, name: "Zoo board" });
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    await screen.findByRole("heading", { level: 1, name: "Explore" });
    const project = await screen.findByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    await waitFor(() => expect(project.value).toBe("p2"));
  });

  it("no projects points to setup", async () => {
    installFakeMonitoringApi({}, async () => json([]));
    await openExplore({ page: "explore" });
    expect(await screen.findByText("Explore reads the sources of a project. Set up a project first.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up a project" }));
    expect(await screen.findByRole("heading", { level: 1, name: "New project" })).toBeTruthy();
  });

  it("Explore never offers an Alertmanager", async () => {
    installFakeMonitoringApi({
      projects: [{ ...linkedProject("p1", "Shop", "s1"), links: [linkTo("am", "alertmanager"), linkTo("s1")] }],
    }, async () => json([]));
    await openExplore({ page: "explore", project: "p1", source: "am" });
    const source = await screen.findByRole("combobox", { name: "Source" }) as HTMLSelectElement;
    expect(within(source).queryByRole("option", { name: /Alertmanager/ })).toBeNull();
    expect(within(source).getAllByRole("option")).toHaveLength(1);
    expect(source.value).toBe("s1");
  });

  it("a project with only an Alertmanager has nothing to explore", async () => {
    installFakeMonitoringApi({ projects: [{ ...seedProject("p1", "Shop"), links: [linkTo("am", "alertmanager")] }] }, async () => json([]));
    await openExplore({ page: "explore", project: "p1" });
    expect(await screen.findByText("Shop has no source Explore can query. Add a Prometheus-compatible or Loki source on the project page.")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Source" })).toBeNull();
  });

  it("a project without sources says where to add one", async () => {
    installFakeMonitoringApi({ projects: [seedProject("p1", "Shop")] }, async () => json([]));
    await openExplore({ page: "explore", project: "p1" });
    expect(await screen.findByText("Shop has no sources yet. Add one on the project page.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Shop" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Shop" })).toBeTruthy();
  });
});
