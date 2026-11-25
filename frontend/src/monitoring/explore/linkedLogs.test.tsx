import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryRequest, QueryResponse } from "../api/types";
import type { CatalogOut } from "../catalog/api";
import { catalogOf, metric, source, stream } from "../catalog/fixtures";
import { fakeBox } from "../charts/panelFixtures";
import type { BatchItemOut } from "../dashboards/api";
import { linkTo, watchCalls } from "../test/dashboardSeeds";
import { installFakeMonitoringApi, type FakeMonitoringApi, type FakeQueryAnswer } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import type { ExploreView } from "../shell/tabState";

type Range = { start: number; end: number };
/** The window the stub chart selects: 10 to 20 minutes into the range it was given. */
let lastRange: Range | null = null;
const windowOf = (r: Range): Range => ({ start: r.start + 600, end: r.start + 1200 });
/** Another window: 30 to 40 minutes in. */
const laterOf = (r: Range): Range => ({ start: r.start + 1800, end: r.start + 2400 });

// The chart chunk: log lines are the real logs chart (with its level column); the time series is a
// stub that prints its ticks and band and selects a window the way the real chart reports one.
vi.mock("../charts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../charts")>();
  const { createElement } = await import("react");
  type Props = import("../charts").ChartViewProps;
  const Stub = (props: Props) => {
    if (props.panel.type === "logs") return createElement(real.default, props);
    lastRange = props.range;
    const select = (how: "pointer" | "keyboard") => props.onSelect?.(windowOf(props.range), how);
    return createElement("div", { "data-chart": "" },
      createElement("div", {
        role: "img", tabIndex: 0, "aria-label": "Volume",
        onKeyDown: (e: { key: string }) => { if (e.key === "Escape" && props.selection) props.onSelect?.(null, "keyboard"); },
      }, `ticks ${props.marks?.length ?? 0}`),
      props.selection ? createElement("span", { "data-band": "" }, `band ${props.selection.start}-${props.selection.end}`) : null,
      props.onSelect ? createElement("button", { type: "button", onClick: () => select("pointer") }, "Drag a window") : null,
      props.onSelect ? createElement("button", { type: "button", onClick: () => select("keyboard") }, "Keys select a window") : null,
      props.onSelect ? createElement("button", { type: "button", onClick: () => props.onSelect?.(laterOf(props.range), "pointer") }, "Drag a later window") : null,
    );
  };
  return { ...real, default: Stub };
});

beforeEach(() => { localStorage.clear(); fakeBox(); lastRange = null; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const BUILT = new Date(Date.now() - 60_000).toISOString();
const nowNs = (minutesAgo: number) => `${Date.now() - minutesAgo * 60_000}000000`;

const metricAnswer: Partial<QueryResponse> = { result_type: "matrix", series: [{ labels: { route: "/a" }, points: [[1, 1], [2, 2]] }], took_ms: 5 };
const linesAnswer: Partial<QueryResponse> = {
  result_type: "streams",
  streams: [
    { labels: { namespace: "api", level: "error" }, entries: [[nowNs(3), "500 POST /orders: upstream timeout"]] },
    { labels: { namespace: "api" }, entries: [[nowNs(2), "slow query 1.8s, WARNING"], [nowNs(1), "GET /items 200 12ms"]] },
  ],
  took_ms: 4,
};

const catalog = (): CatalogOut => catalogOf("p1",
  source("s1", { built_at: BUILT, metrics: [metric("http_requests_total", { type: "counter", labels: ["namespace", "route"] })] }),
  source("l1", { source_type: "loki", source_name: "l1", built_at: BUILT, streams: [stream("namespace", ["api", "web"]), stream("app", ["shop"])] }),
);

/** Shop (p1) with Prometheus s1 and Loki l1; `answers` by query text, else lines for a selector, else a series. */
function shop(answers: Record<string, FakeQueryAnswer> = {}, links = [linkTo("s1"), linkTo("l1", "loki")]): FakeMonitoringApi {
  return installFakeMonitoringApi({
    projects: [{ ...seedProject("p1", "Shop"), links }],
    catalogs: { p1: catalog() },
    labelValues: { "p1|namespace": ["api", "web"], "p1|route": ["/a"] },
    queryAnswers: new Proxy({} as Record<string, FakeQueryAnswer>, {
      get: (_, key) => {
        const text = String(key).replace(/^p1\|/, "");
        return answers[text] ?? (text.startsWith("{") ? linesAnswer : metricAnswer);
      },
    }),
  }, async () => json([]));
}

/**
 * Every batch item sent; a rule may answer an item itself (after the fake has seen it), and `hold`
 * may keep an answer back until its promise settles (ignoring the abort, as a slow network would).
 */
function batchItems(
  rule: (q: QueryRequest) => BatchItemOut | null = () => null,
  hold: (q: QueryRequest) => Promise<void> | null = () => null,
) {
  const sent: QueryRequest[] = [];
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : null;
    const res = await inner(input, init);
    if (!url.includes("/query/batch") || body === null) return res;
    const items = (JSON.parse(body) as { queries: QueryRequest[] }).queries;
    sent.push(...items);
    await Promise.all(items.map(hold).filter((p) => p !== null));
    const own = items.map(rule);
    if (own.every((o) => o === null)) return res;
    const theirs = ((await res.json()) as { results: BatchItemOut[] }).results;
    return json({ results: own.map((o, i) => o ?? theirs[i]) });
  }));
  return sent;
}
const linesSent = (sent: QueryRequest[]) => sent.filter((q) => q.limit != null);
const noLines = (q: QueryRequest): BatchItemOut => ({
  ok: true, error: null,
  response: { ...linesAnswer, streams: [], series: [], warnings: [], truncated: false, source_id: q.source_id, source_name: q.source_id, source_type: "loki", project_id: q.project_id ?? null, applied_filter: "", query: q.query, took_ms: 1 } as QueryResponse,
});

async function openExplore(view: ExploreView = { page: "explore", project: "p1" }) {
  renderMonitoringApp({ tabs: tabsWith(view) });
  const heading = await screen.findByRole("heading", { level: 1, name: "Explore" });
  await waitFor(() => expect(document.activeElement).toBe(heading));
}
const section = () => screen.getByRole("region", { name: "Log lines" });
const two = (n: number) => String(n).padStart(2, "0");
const clock = (s: number) => { const d = new Date(s * 1000); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };

async function linkByChip(user: ReturnType<typeof userEvent.setup>) {
  const box = await screen.findByRole("listbox", { name: "Metrics" });
  await user.click(await within(box).findByRole("option", { name: /^http_requests_total\b/ }));
  await user.click(await screen.findByRole("button", { name: "namespace=api" }));
}

describe("Metrics and logs on one timeline", () => {
  it("Only chips link the logs and draw ticks", async () => {
    shop();
    const sent = batchItems();
    const user = userEvent.setup();
    await openExplore();
    const region = await screen.findByRole("region", { name: "Log lines" });
    expect(within(region).getByRole("heading", { name: "Log lines" })).toBeTruthy();
    expect(within(region).getByText("Pick values under Only, or write a LogQL selector, to see matching log lines here.")).toBeTruthy();
    await linkByChip(user);
    const field = within(region).getByRole("textbox", { name: "Logs query" }) as HTMLTextAreaElement;
    expect(field.value).toBe('{namespace="api"}');
    await waitFor(() => expect(linesSent(sent).at(-1)).toMatchObject({ query: '{namespace="api"}', limit: 1000, project_id: "p1", source_id: "l1", direction: "backward" }));
    expect(await within(region).findByText((_, el) => el?.tagName === "P" && el.textContent === 'Logs from {namespace="api"} · l1 name')).toBeTruthy();
    expect(await within(region).findByText("Last 1 hour · 3 log lines")).toBeTruthy();
    const list = await within(region).findByRole("list", { name: "Log lines" });
    expect(list.getAttribute("aria-keyshortcuts")).toBe("l");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.querySelector("[data-tone]")?.getAttribute("data-tone"))).toEqual(["info", "warn", "error"]);
    expect(await screen.findByText("ticks 3")).toBeTruthy();
  });

  it("a hand-written logs query stays and goes into the view", async () => {
    shop();
    const sent = batchItems();
    const user = userEvent.setup();
    await openExplore();
    await linkByChip(user);
    const field = within(section()).getByRole("textbox", { name: "Logs query" }) as HTMLTextAreaElement;
    await user.type(field, '{{app="shop"}', { initialSelectionStart: 0, initialSelectionEnd: field.value.length });
    expect(field.value).toBe('{app="shop"}');
    await waitFor(() => expect(linesSent(sent).at(-1)?.query).toBe('{app="shop"}'));
    // A chip no longer rewrites it.
    await user.click(screen.getByRole("button", { name: "namespace=web" }));
    expect(field.value).toBe('{app="shop"}');
  });

  it("an emptied logs query follows the chips again", async () => {
    shop();
    batchItems();
    const user = userEvent.setup();
    await openExplore();
    await linkByChip(user);
    const field = within(section()).getByRole("textbox", { name: "Logs query" }) as HTMLTextAreaElement;
    await user.type(field, "{{app=\"shop\"}", { initialSelectionStart: 0, initialSelectionEnd: field.value.length });
    await user.clear(field);
    expect(field.value).toBe('{namespace="api"}');
    await user.click(screen.getByRole("button", { name: "namespace=web" }));
    expect(field.value).toBe('{namespace="web"}');
  });

  it("a logs query of only spaces follows the chips too", async () => {
    shop();
    batchItems();
    const user = userEvent.setup();
    await openExplore();
    await linkByChip(user);
    const field = within(section()).getByRole("textbox", { name: "Logs query" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "   " } });
    expect(field.value).toBe('{namespace="api"}');
    await user.click(screen.getByRole("button", { name: "namespace=web" }));
    expect(field.value).toBe('{namespace="web"}');
  });

  it("the lines follow the time they show", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    shop();
    const sent = batchItems();
    const user = userEvent.setup();
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: '{app="shop"}' });
    await waitFor(() => expect(linesSent(sent).at(-1)?.query).toBe('{app="shop"}'));
    const first = linesSent(sent).at(-1) as QueryRequest;
    // Five minutes later, a new LogQL query: its lines end at the new "now", not the old one.
    now += 5 * 60_000;
    await user.type(screen.getByRole("textbox", { name: "Query" }), ' |= "boom"');
    await waitFor(() => expect(linesSent(sent).at(-1)?.query).toBe('{app="shop"} |= "boom"'));
    const later = linesSent(sent).at(-1) as QueryRequest;
    expect(later.end! - first.end!).toBe(300);
    expect(later.end! - later.start!).toBe(first.end! - first.start!);
  });

  it("an older window's late answer is dropped", async () => {
    shop();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let holding = false;
    const isWindow = (q: QueryRequest, of: (r: Range) => Range) => q.limit != null && lastRange !== null && q.start === of(lastRange).start;
    const sent = batchItems(
      (q) => (isWindow(q, laterOf) ? noLines(q) : null),
      (q) => (holding && isWindow(q, windowOf) ? held : null),
    );
    const user = userEvent.setup();
    await openExplore();
    await linkByChip(user);
    await within(section()).findByText("Last 1 hour · 3 log lines");
    holding = true;
    await user.click(screen.getByRole("button", { name: "Drag a window" }));
    await waitFor(() => expect(sent.some((q) => isWindow(q, windowOf))).toBe(true));
    await user.click(screen.getByRole("button", { name: "Drag a later window" }));
    const later = laterOf(lastRange as Range);
    const label = `${clock(later.start)} – ${clock(later.end)} · 0 log lines`;
    expect(await within(section()).findByText(label)).toBeTruthy();
    // The first window's three lines arrive late: they never replace the later window's answer.
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(within(section()).getByText(label)).toBeTruthy();
    expect(within(section()).getByText("No log lines in this window.")).toBeTruthy();
    expect(within(section()).queryByRole("list", { name: "Log lines" })).toBeNull();
    expect(screen.getByText(`band ${later.start}-${later.end}`)).toBeTruthy();
  });

  it("dragging a window re-queries the lines for it", async () => {
    shop();
    const sent = batchItems();
    const user = userEvent.setup();
    await openExplore();
    await linkByChip(user);
    await within(section()).findByText("Last 1 hour · 3 log lines");
    const before = linesSent(sent).length;
    await user.click(screen.getByRole("button", { name: "Drag a window" }));
    const win = windowOf(lastRange as Range);
    await waitFor(() => expect(linesSent(sent).length).toBe(before + 1));
    expect(linesSent(sent).at(-1)).toMatchObject({ query: '{namespace="api"}', start: win.start, end: win.end, limit: 1000 });
    expect(await within(section()).findByText(`${clock(win.start)} – ${clock(win.end)} · 3 log lines`)).toBeTruthy();
    expect(within(section()).getByRole("button", { name: "Show all" })).toBeTruthy();
    // The chart keeps its full range, with the band drawn.
    expect(screen.getByText(`band ${win.start}-${win.end}`)).toBeTruthy();
    expect(lastRange).not.toEqual(win);
  });

  it("Show all goes back to the whole range", async () => {
    shop();
    const sent = batchItems();
    const user = userEvent.setup();
    await openExplore();
    await linkByChip(user);
    await within(section()).findByText("Last 1 hour · 3 log lines");
    const full = linesSent(sent).at(-1) as QueryRequest;
    await user.click(screen.getByRole("button", { name: "Keys select a window" }));
    const showAll = await within(section()).findByRole("button", { name: "Show all" });
    const count = linesSent(sent).length;
    await user.click(showAll);
    await waitFor(() => expect(linesSent(sent).length).toBe(count + 1));
    const last = linesSent(sent).at(-1) as QueryRequest;
    expect(last.end! - last.start!).toBe(full.end! - full.start!);
    expect(await within(section()).findByText("Last 1 hour · 3 log lines")).toBeTruthy();
    expect(within(section()).queryByRole("button", { name: "Show all" })).toBeNull();
    expect(screen.queryByText(/^band /)).toBeNull();
    // The keyboard goes to the chart, never the page.
    expect(document.activeElement).toBe(screen.getByRole("img", { name: "Volume" }));
  });

  it("Esc on the chart shows all again", async () => {
    shop();
    const sent = batchItems();
    const user = userEvent.setup();
    await openExplore();
    await linkByChip(user);
    await within(section()).findByText("Last 1 hour · 3 log lines");
    await user.click(screen.getByRole("button", { name: "Drag a window" }));
    await within(section()).findByRole("button", { name: "Show all" });
    const count = linesSent(sent).length;
    fireEvent.keyDown(screen.getByRole("img", { name: "Volume" }), { key: "Escape" });
    await waitFor(() => expect(linesSent(sent).length).toBe(count + 1));
    expect(await within(section()).findByText("Last 1 hour · 3 log lines")).toBeTruthy();
  });

  it("a window chosen with the keys keeps the keyboard on the chart, where Esc shows all again", async () => {
    shop();
    const sent = batchItems();
    await openExplore();
    await linkByChip(userEvent.setup());
    await within(section()).findByText("Last 1 hour · 3 log lines");
    const chart = screen.getByRole("img", { name: "Volume" });
    chart.focus();
    // Shift+arrows on the chart: the window comes from the keyboard, and the keyboard stays put.
    fireEvent.click(screen.getByRole("button", { name: "Keys select a window" }));
    const win = windowOf(lastRange as Range);
    expect(await within(section()).findByText(`${clock(win.start)} – ${clock(win.end)} · 3 log lines`)).toBeTruthy();
    expect(within(section()).getByRole("button", { name: "Show all" })).toBeTruthy();
    expect(document.activeElement).toBe(chart);
    const count = linesSent(sent).length;
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(linesSent(sent).length).toBe(count + 1));
    expect(await within(section()).findByText("Last 1 hour · 3 log lines")).toBeTruthy();
    expect(within(section()).queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("an empty window says so", async () => {
    shop();
    let windowed = false;
    batchItems((q) => (windowed && q.limit != null ? noLines(q) : null));
    const user = userEvent.setup();
    await openExplore();
    await linkByChip(user);
    await within(section()).findByText("Last 1 hour · 3 log lines");
    windowed = true;
    await user.click(screen.getByRole("button", { name: "Drag a window" }));
    expect(await within(section()).findByText("No log lines in this window.")).toBeTruthy();
    const win = windowOf(lastRange as Range);
    expect(within(section()).getByText(`${clock(win.start)} – ${clock(win.end)} · 0 log lines`)).toBeTruthy();
    expect(within(section()).queryByRole("list", { name: "Log lines" })).toBeNull();
    expect(within(section()).getByRole("button", { name: "Show all" })).toBeTruthy();
  });

  it("a failed lines run stays in its section", async () => {
    shop();
    let fail = true;
    batchItems((q) => (fail && q.limit != null
      ? { ok: false, response: null, error: { code: "unreachable", message: "Loki didn't answer in time.", status: 502 } }
      : null));
    const user = userEvent.setup();
    await openExplore();
    await linkByChip(user);
    expect(await within(section()).findByText("Loki didn't answer in time.")).toBeTruthy();
    expect(within(section()).queryByRole("list", { name: "Log lines" })).toBeNull();
    // The metric chart is unaffected, and has no ticks.
    expect(screen.getByText("ticks 0")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
    fail = false;
    await user.click(within(section()).getByRole("button", { name: "Try again" }));
    expect(await within(section()).findByText("Last 1 hour · 3 log lines")).toBeTruthy();
    expect(await screen.findByText("ticks 3")).toBeTruthy();
  });

  it("logs mode lists lines without a chart", async () => {
    shop();
    const sent = batchItems();
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: '{app="shop"}' });
    await waitFor(() => expect(linesSent(sent).at(-1)).toMatchObject({ query: '{app="shop"}', limit: 1000, source_id: "l1", project_id: "p1" }));
    const region = section();
    // The query bar is the logs query: no second field.
    expect(within(region).queryByRole("textbox", { name: "Logs query" })).toBeNull();
    expect(await within(region).findByText("Last 1 hour · 3 log lines")).toBeTruthy();
    expect(within(region).getAllByRole("listitem")).toHaveLength(3);
    // Task 8: no volume read, no chart, so no ticks and no window to drag.
    expect(sent.some((q) => /count_over_time/.test(q.query))).toBe(false);
    expect(screen.queryByText(/^ticks /)).toBeNull();
    expect(screen.queryByRole("button", { name: "Drag a window" })).toBeNull();
  });

  it("a LogQL metric query says there are no lines", async () => {
    shop();
    const sent = batchItems();
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: 'sum(rate({app="shop"}[5m]))' });
    const region = await screen.findByRole("region", { name: "Log lines" });
    expect(await within(region).findByText("This is a metric query, so there are no lines to list.")).toBeTruthy();
    await waitFor(() => expect(sent.some((q) => q.query === 'sum(rate({app="shop"}[5m]))')).toBe(true));
    expect(linesSent(sent)).toEqual([]);
    expect(screen.queryByRole("button", { name: "Drag a window" })).toBeNull();
  });

  it("no Loki in the project: no section and no ticks", async () => {
    shop({}, [linkTo("s1")]);
    batchItems();
    const user = userEvent.setup();
    await openExplore();
    const box = await screen.findByRole("listbox", { name: "Metrics" });
    await user.click(await within(box).findByRole("option", { name: /^http_requests_total\b/ }));
    expect(await screen.findByText("ticks 0")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Log lines" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Drag a window" })).toBeNull();
  });

  it("another project never shows the old lines or ticks", async () => {
    installFakeMonitoringApi({
      projects: [
        { ...seedProject("p1", "Shop"), links: [linkTo("s1"), linkTo("l1", "loki")] },
        { ...seedProject("p2", "Zoo"), links: [linkTo("s2"), linkTo("l2", "loki")] },
      ],
      catalogs: { p1: catalog(), p2: catalogOf("p2", source("s2", { built_at: BUILT }), source("l2", { source_type: "loki", built_at: BUILT })) },
      labelValues: { "p1|namespace": ["api", "web"] },
      queryAnswers: new Proxy({} as Record<string, FakeQueryAnswer>, {
        get: (_, key) => (String(key).replace(/^p\d\|/, "").startsWith("{") ? linesAnswer : metricAnswer),
      }),
    }, async () => json([]));
    const sent = batchItems();
    const user = userEvent.setup();
    await openExplore({ page: "explore", project: "p1", expr: "up" });
    await linkByChip(user);
    await within(section()).findByText("Last 1 hour · 3 log lines");
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "p2");
    await waitFor(() => expect(screen.queryByText("Last 1 hour · 3 log lines")).toBeNull());
    expect(within(section()).queryByRole("list", { name: "Log lines" })).toBeNull();
    expect(screen.queryByText("ticks 3")).toBeNull();
    // Every lines read carried its own project.
    for (const q of linesSent(sent)) expect(q.project_id).toBe(q.source_id === "l1" ? "p1" : "p2");
  });

  it("Explore's empty lines say the newest line is older", async () => {
    const api = shop();
    const OLDER = "No lines in this time range. The newest matching line is 3 days old: try a longer range.";
    api.state.whyEmpty = { reason: "older_lines", message: OLDER };
    const sent = batchItems((q) => (q.limit != null ? noLines(q) : null));
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: '{app="shop"}' });
    const reason = await within(await screen.findByRole("region", { name: "Log lines" })).findByText(OLDER);
    expect(reason.hasAttribute("data-empty-reason")).toBe(true);
    expect(within(section()).queryByText("No log lines in this time range.")).toBeNull();
    const why = () => api.requests.filter((r) => r.url === "/api/monitoring/query/why-empty").map((r) => r.body as Record<string, unknown>);
    // About the lines request that ran: its project, source, text, range and selector.
    const ran = linesSent(sent).at(-1) as QueryRequest;
    expect(why()).toEqual([{
      source_id: "l1", project_id: "p1", query: '{app="shop"}', start: ran.start, end: ran.end, metrics: [], selector: '{app="shop"}',
    }]);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("empty lines in a window chosen on the chart ask about that window", async () => {
    const api = shop();
    const OLDER = "No lines in this time range. The newest matching line is 3 days old: try a longer range.";
    api.state.whyEmpty = { reason: "older_lines", message: OLDER };
    batchItems((q) => (q.limit != null ? noLines(q) : null));
    const user = userEvent.setup();
    await openExplore({ page: "explore", project: "p1", expr: "up" });
    await linkByChip(user);
    expect(await within(section()).findByText(OLDER)).toBeTruthy();
    const why = () => api.requests.filter((r) => r.url === "/api/monitoring/query/why-empty").map((r) => r.body as Record<string, unknown>);
    await user.click(screen.getByRole("button", { name: "Drag a window" }));
    const win = windowOf(lastRange as Range);
    await waitFor(() => expect(why().at(-1)).toMatchObject({ start: win.start, end: win.end, selector: '{namespace="api"}' }));
    expect(await within(section()).findByText(OLDER)).toBeTruthy();
    expect(within(section()).queryByText("No log lines in this window.")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("an unknown reason keeps the plain empty lines note", async () => {
    const api = shop();
    batchItems((q) => (q.limit != null ? noLines(q) : null));
    const calls = watchCalls("/query/why-empty");
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: '{app="shop"}' });
    expect(await within(await screen.findByRole("region", { name: "Log lines" })).findByText("No log lines in this time range.")).toBeTruthy();
    await waitFor(() => expect(calls.count).toBe(1));
    expect(api.requests.some((r) => r.url === "/api/monitoring/query/why-empty")).toBe(true);
    await calls.settled();
    expect(within(section()).getByText("No log lines in this time range.")).toBeTruthy();
    expect(section().querySelector("[data-empty-reason]")).toBeNull();
  });

  it("l focuses the log lines", async () => {
    shop();
    batchItems();
    const user = userEvent.setup();
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: '{app="shop"}' });
    const region = await screen.findByRole("region", { name: "Log lines" });
    const list = await within(region).findByRole("list", { name: "Log lines" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    await user.keyboard("l");
    expect(list.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("role")).toBe("listitem");
  });
});

describe("Explore with Loki: one query, one result", () => {
  const ONE = "Explore runs one query at a time. Keep one query in the field, or run them one after another.";
  const FIX = "Fix the query to run it again.";
  const PARSE = "parse error at line 2, col 1: syntax error: unexpected {";
  /** Sent to Loki as one query (the first line ends with an operator), refused as a syntax error. */
  const BAD = '{app="shop"} |=\n{app="web"}';
  const refusedBad: FakeQueryAnswer = { error: { code: "bad_query", message: PARSE }, status: 400 };
  const oneLine: Partial<QueryResponse> = {
    result_type: "streams", streams: [{ labels: { app: "one" }, entries: [[nowNs(1), "only line"]] }], took_ms: 2,
  };
  const meta = () => document.querySelector("[data-explore-meta]") as HTMLElement;
  const query = () => screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement;
  const invalidNote = () => section().querySelector("[data-lines-invalid]");
  const add = () => screen.getByRole("button", { name: "Add to dashboard" });
  const notBody = () => expect(document.activeElement).not.toBe(document.body);

  it("a log query shows only the log lines", async () => {
    shop({ '{app="one"}': oneLine });
    const sent = batchItems();
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: '{app="shop"}' });
    const region = await screen.findByRole("region", { name: "Log lines" });
    expect(await within(region).findByText("Last 1 hour · 3 log lines")).toBeTruthy();
    await waitFor(() => expect(meta().textContent).toMatch(/^✓ 3 lines·Last 1 hour·updated \d\d:\d\d:\d\d$/));
    // No chart, no last good result, no volume read: the lines are the only read.
    expect(document.querySelector("[data-chart]")).toBeNull();
    expect(document.querySelector("[data-explore-chart]")).toBeNull();
    expect(screen.queryByText("Last good result")).toBeNull();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((q) => q.limit != null)).toBe(true);
    // The section sits under the meta line, and the query can be added.
    expect(meta().compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(add().getAttribute("aria-disabled")).toBeNull();
    // A run whose lines answered, left alone for two seconds, goes into the trail.
    const trail = await screen.findByRole("toolbar", { name: "Recent queries" }, { timeout: 4000 });
    expect(within(trail).getByRole("button", { name: '{app="shop"}' }).getAttribute("aria-current")).toBe("true");
    // One line is one line.
    fireEvent.change(query(), { target: { value: '{app="one"}' } });
    await waitFor(() => expect(meta().textContent).toMatch(/^✓ 1 line·Last 1 hour·updated /));
    expect(document.querySelector("[data-chart]")).toBeNull();
  });

  it("a LogQL metric query keeps the chart", async () => {
    shop();
    const sent = batchItems();
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: 'sum(rate({app="shop"}[5m]))' });
    expect(await screen.findByText("ticks 0")).toBeTruthy();
    await waitFor(() => expect(meta().textContent).toContain("✓ 1 series"));
    expect(sent.map((q) => q.query)).toEqual(['sum(rate({app="shop"}[5m]))']);
    expect(within(section()).getByText("This is a metric query, so there are no lines to list.")).toBeTruthy();
  });

  it("several queries say Explore runs one at a time", async () => {
    shop();
    const sent = batchItems();
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: '{app="shop"}\n{app="web"}' });
    await waitFor(() => expect(invalidNote()?.textContent).toBe(`✗ ${ONE} ${FIX}`));
    expect(meta().textContent).toBe(`✗ ${ONE}`);
    // Nothing was sent, nothing can be tried again, and no selector is named.
    expect(sent).toEqual([]);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(section()).queryByText(/Logs from/)).toBeNull();
    expect(add().getAttribute("aria-disabled")).toBe("true");
  });

  it("a syntax error offers no Try again", async () => {
    shop({ [BAD]: refusedBad });
    const sent = batchItems();
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: BAD });
    await waitFor(() => expect(invalidNote()?.textContent).toBe(`✗ ${PARSE} ${FIX}`));
    expect(linesSent(sent).map((q) => q.query)).toEqual([BAD]);
    expect(meta().textContent).toBe(`✗ ${PARSE}`);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(section()).queryByRole("list", { name: "Log lines" })).toBeNull();
    expect(add().getAttribute("aria-disabled")).toBe("true");
  });

  it("an unreachable Loki still offers Try again", async () => {
    shop();
    let fail = true;
    batchItems((q) => (fail && q.limit != null
      ? { ok: false, response: null, error: { code: "unreachable", message: "Loki didn't answer in time.", status: 502 } }
      : null));
    const user = userEvent.setup();
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: '{app="shop"}' });
    const retry = await within(await screen.findByRole("region", { name: "Log lines" })).findByRole("button", { name: "Try again" });
    expect(within(section()).getByText("Loki didn't answer in time.")).toBeTruthy();
    expect(meta().textContent).toBe("✗ Loki didn't answer in time.");
    expect(invalidNote()).toBeNull();
    fail = false;
    await user.click(retry);
    expect(await within(section()).findByText("Last 1 hour · 3 log lines")).toBeTruthy();
    await waitFor(() => expect(meta().textContent).toMatch(/^✓ 3 lines/));
    notBody();
  });

  it("an invalid log query clears the lines and names only itself", async () => {
    shop({ [BAD]: refusedBad });
    batchItems();
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: '{app="shop"}' });
    expect(await within(await screen.findByRole("region", { name: "Log lines" })).findByText("Last 1 hour · 3 log lines")).toBeTruthy();
    expect(within(section()).getByText((_, el) => el?.tagName === "P" && el.textContent === 'Logs from {app="shop"} · l1 name')).toBeTruthy();
    fireEvent.change(query(), { target: { value: BAD } });
    await waitFor(() => expect(invalidNote()?.textContent).toBe(`✗ ${PARSE} ${FIX}`));
    // Nothing of the query before it is left: no lines, no selector, no last good result.
    expect(within(section()).queryByRole("list", { name: "Log lines" })).toBeNull();
    expect(within(section()).queryByText(/Logs from/)).toBeNull();
    expect(within(section()).queryByText("Last 1 hour · 3 log lines")).toBeNull();
    expect(section().textContent).not.toContain('{app="shop"} ·');
    expect(screen.queryByText("Last good result")).toBeNull();
    expect(document.querySelector("[data-chart]")).toBeNull();
    expect(meta().textContent).toBe(`✗ ${PARSE}`);
  });

  it("a broken metric query keeps its own caption and the lines never name it", async () => {
    shop();
    batchItems();
    const user = userEvent.setup();
    await openExplore();
    await linkByChip(user);
    await within(section()).findByText("Last 1 hour · 3 log lines");
    const good = query().value;
    const broken = `${good}\n)`;
    fireEvent.change(query(), { target: { value: broken } });
    const label = await screen.findByText("Last good result");
    expect((label.closest("[data-last-good]") as HTMLElement).querySelector("code")?.textContent).toBe(good);
    expect(section().textContent).not.toContain(broken);
    expect(within(section()).getByText((_, el) => el?.tagName === "P" && el.textContent === 'Logs from {namespace="api"} · l1 name')).toBeTruthy();
  });

  it("a late answer for an older text never shows", async () => {
    shop({ '{app="one"}': oneLine });
    let releaseOld!: () => void;
    const old = new Promise<void>((r) => { releaseOld = r; });
    let releaseMetric!: () => void;
    const metricHeld = new Promise<void>((r) => { releaseMetric = r; });
    const METRIC = 'sum(rate({app="shop"}[5m]))';
    const sent = batchItems(() => null, (q) => (q.query === '{app="shop"}' ? old : q.query === METRIC ? metricHeld : null));
    await openExplore({ page: "explore", project: "p1", source: "l1", expr: '{app="shop"}' });
    await waitFor(() => expect(linesSent(sent).map((q) => q.query)).toEqual(['{app="shop"}']));
    // Log, then metric, then another log query, while the first two answers are still on their way.
    fireEvent.change(query(), { target: { value: METRIC } });
    await waitFor(() => expect(sent.some((q) => q.query === METRIC)).toBe(true));
    fireEvent.change(query(), { target: { value: '{app="one"}' } });
    await waitFor(() => expect(meta().textContent).toMatch(/^✓ 1 line·/));
    expect(within(section()).getAllByRole("listitem")).toHaveLength(1);
    // The older answers arrive last and are dropped.
    releaseOld();
    releaseMetric();
    await act(async () => { await old; await metricHeld; await new Promise((r) => setTimeout(r, 50)); });
    expect(meta().textContent).toMatch(/^✓ 1 line·/);
    expect(within(section()).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText("500 POST /orders: upstream timeout")).toBeNull();
    expect(document.querySelector("[data-chart]")).toBeNull();
    expect(screen.queryByText("Last good result")).toBeNull();
  });

  it("the logs flow works from the keyboard", async () => {
    shop();
    batchItems();
    const user = userEvent.setup();
    await openExplore({ page: "explore", project: "p1", source: "l1" });
    const heading = screen.getByRole("heading", { level: 1, name: "Explore" });
    await user.keyboard("q");
    expect(document.activeElement).toBe(query());
    await user.paste('{app="shop"}');
    notBody();
    await user.keyboard("{Control>}{Enter}{/Control}");
    notBody();
    const list = await within(section()).findByRole("list", { name: "Log lines" });
    await waitFor(() => expect(meta().textContent).toMatch(/^✓ 3 lines/));
    // Esc leaves the field to the heading (there is no chart), and l goes to the lines.
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(heading);
    await user.keyboard("l");
    expect(list.contains(document.activeElement)).toBe(true);
    // Back to the query: two queries on two lines are refused before anything is sent.
    await user.keyboard("q");
    expect(document.activeElement).toBe(query());
    await user.keyboard("{Control>}a{/Control}");
    notBody();
    await user.paste('{app="shop"}\n{app="web"}');
    notBody();
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(invalidNote()?.textContent).toBe(`✗ ${ONE} ${FIX}`));
    expect(document.activeElement).toBe(query());
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(heading);
    // No lines to go to: l lands on the section's heading, and a can't add a query that can't run.
    await user.keyboard("l");
    expect(document.activeElement).toBe(within(section()).getByRole("heading", { name: "Log lines" }));
    await user.keyboard("a");
    expect(screen.queryByRole("dialog")).toBeNull();
    notBody();
  });
});
