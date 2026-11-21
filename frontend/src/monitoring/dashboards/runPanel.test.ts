import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK_MESSAGE } from "../api/query";
import type { GroupOut, LinkOut, ProjectOut, QueryResponse, SourceType } from "../api/types";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import type { BatchItemOut } from "./api";
import {
  buildPanelRun, CUT_SHORT, mergePanelResults, panelRunKey, queryKindFor, runRequests, usePanelData,
  type DashboardOwner, type PanelRun,
} from "./runPanel";
import { newPanel, type PanelSpec, type PanelType, type QuerySpec } from "./schema";

afterEach(() => vi.unstubAllGlobals());

// --- fixtures ---------------------------------------------------------------------------------

const link = (id: string, type: SourceType): LinkOut => ({
  source_id: id, source_name: id, source_type: type, filter: "", filter_origin: "none", created_by_project: false,
});
const proj = (id: string, name: string, links: LinkOut[]): ProjectOut => ({
  id, name, kind: "custom", cluster_id: null, cluster_name: null, cluster_provider: null, links, group_ids: [],
  created_at: "", updated_at: "",
});
const projA = proj("a", "projA", [link("lokiA", "loki"), link("promA", "prometheus")]);
const projB = proj("b", "projB", [link("promB", "prometheus"), link("promB2", "prometheus"), link("lokiB", "loki")]);
const projNoProm = proj("n", "no-prom", [link("lokiN", "loki")]);
const projNothing = proj("z", "bare", []);

const group = (members: ProjectOut[]): DashboardOwner => {
  const g: GroupOut = { id: "g", name: "Prod", project_ids: members.map((m) => m.id), created_at: "", updated_at: "" };
  return { kind: "group", group: g, members };
};
const project = (p: ProjectOut): DashboardOwner => ({ kind: "project", project: p });

const q = (ref: string, expr: string, more: Partial<QuerySpec> = {}): QuerySpec => ({
  ref, source: { type: "prometheus", id: null }, expr, legend: "", hidden: false, ...more,
});
function panelOf(type: PanelType, queries: QuerySpec[], w = 12): PanelSpec {
  const p = newPanel(type, "p-1", { x: 0, y: 0, w, h: 8 });
  return { ...p, queries } as PanelSpec;
}
const ts = (expr: string) => panelOf("timeseries", [q("A", expr)]);

function response(more: Partial<QueryResponse> = {}): QueryResponse {
  return {
    result_type: "matrix", series: [], streams: [], warnings: [], truncated: false, source_id: "s", source_name: "s",
    source_type: "prometheus", project_id: null, applied_filter: "", query: "", took_ms: 3, ...more,
  };
}
const ok = (more: Partial<QueryResponse> = {}): BatchItemOut => ({ ok: true, response: response(more), error: null });
const fail = (code: string, message: string, status = 502): BatchItemOut =>
  ({ ok: false, response: null, error: { code, message, status } }) as BatchItemOut;
const seriesFor = (who: string) => ({ series: [{ labels: { __name__: "up", job: "x" }, points: [[0, 1], [5, 2]] as [number, number][] }], project_id: who });

const HOUR = { start: 0, end: 3600 };

// --- building runs ----------------------------------------------------------------------------

describe("buildPanelRun", () => {
  it("a group panel runs once per member project with its own source", () => {
    const run = buildPanelRun({ panel: ts("sum(up)"), owner: group([projA, projB, projNoProm]), vars: {}, range: HOUR, ownerName: "Prod" });
    expect(run.requests.map((r) => [r.project_id, r.source_id, r.step])).toEqual([["a", "promA", 5], ["b", "promB", 5]]);
    expect(run.skipped).toEqual([{ queryRef: "A", projectName: "no-prom", message: "no-prom has no Prometheus-compatible source.", state: "error" }]);
    expect(run.parts).toEqual([
      { queryRef: "A", projectId: "a", projectName: "projA", sourceName: "promA" },
      { queryRef: "A", projectId: "b", projectName: "projB", sourceName: "promB" },
    ]);
    expect(run.requests[0]).toEqual({ source_id: "promA", project_id: "a", kind: "range", query: "sum(up)", start: 0, end: 3600, step: 5 });
    expect(run.ownerKind).toBe("group");
  });

  it("a project panel uses the named source, else the project's first of the type", () => {
    const panel = panelOf("timeseries", [q("A", "up"), q("B", "up", { source: { type: "prometheus", id: "promB2" } })]);
    const run = buildPanelRun({ panel, owner: project(projB), vars: {}, range: HOUR, ownerName: "projB" });
    expect(run.requests.map((r) => [r.source_id, r.project_id])).toEqual([["promB", "b"], ["promB2", "b"]]);
    expect(run.skipped).toEqual([]);
  });

  it("an unlinked source id says how to fix it", () => {
    const panel = panelOf("timeseries", [q("A", "up", { source: { type: "prometheus", id: "gone" } }), q("B", "up")]);
    const run = buildPanelRun({ panel, owner: project(projA), vars: {}, range: HOUR, ownerName: "projA" });
    expect(run.requests.map((r) => r.source_id)).toEqual(["promA"]);
    expect(run.skipped).toEqual([{
      queryRef: "A", projectName: "projA", state: "error",
      message: "This panel's source isn't linked to projA any more. Pick another in the panel's Query tab.",
    }]);
  });

  it("a project without a source of the type says where to link one", () => {
    const prom = buildPanelRun({ panel: ts("up"), owner: project(projNothing), vars: {}, range: HOUR, ownerName: "bare" });
    expect(prom.requests).toEqual([]);
    expect(prom.skipped.map((s) => s.message)).toEqual(["bare has no Prometheus-compatible source. Link one on the project page."]);
    const logs = panelOf("logs", [q("A", '{app="x"}', { source: { type: "loki", id: null } })], 24);
    const loki = buildPanelRun({ panel: logs, owner: project(projNothing), vars: {}, range: HOUR, ownerName: "bare" });
    expect(loki.skipped.map((s) => s.message)).toEqual(["bare has no Loki source. Link one on the project page."]);
    const inGroup = buildPanelRun({ panel: logs, owner: group([projA, projNothing]), vars: {}, range: HOUR, ownerName: "Prod" });
    expect(inGroup.requests.map((r) => r.source_id)).toEqual(["lokiA"]);
    expect(inGroup.skipped.map((s) => s.message)).toEqual(["bare has no Loki source."]);
  });

  it("variables and builtins are substituted before sending", () => {
    const vars = { ns: { multi: true, value: ["a.b", "c"] } };
    const run = buildPanelRun({
      panel: ts('rate(x{ns=~"$ns"}[$__rate_interval]) / $__interval'), owner: project(projA), vars,
      range: { start: 1000, end: 22600 }, ownerName: "projA",
    });
    expect(run.requests).toEqual([{
      source_id: "promA", project_id: "a", kind: "range", query: 'rate(x{ns=~"a\\\\.b|c"}[2m]) / 30s',
      start: 990, end: 22620, step: 30,
    }]);
    expect(run.range).toEqual({ start: 990, end: 22620 });
  });

  it("a value that can't be placed safely fails only its own query", () => {
    const vars = { v: { multi: false, value: ['a"} or up{x="'] } };
    const panel = panelOf("timeseries", [q("A", "up{x=$v}"), q("B", "up")]);
    const run = buildPanelRun({ panel, owner: group([projA, projB]), vars, range: HOUR, ownerName: "Prod" });
    expect(run.requests.map((r) => [r.query, r.project_id])).toEqual([["up", "a"], ["up", "b"]]);
    expect(run.skipped).toEqual([{
      queryRef: "A", projectName: null, state: "error",
      message: "The value of $v can't be used here. Put $v inside double quotes in the query.",
    }]);
    expect(run.requests.some((r) => r.query.includes("$v") || r.query.includes("or up"))).toBe(false);
  });

  it("hidden and empty queries are not sent; nothing to send is noQuery", () => {
    const panel = panelOf("timeseries", [q("A", "up", { hidden: true }), q("B", "   ")]);
    const run = buildPanelRun({ panel, owner: project(projA), vars: {}, range: HOUR, ownerName: "projA" });
    expect(run.requests).toEqual([]);
    expect(run.skipped).toEqual([]);
    expect(mergePanelResults(panel, run, [], "project").state).toBe("noQuery");
  });

  it("bar and table run instant at the end; logs send a limit, a direction and a step", () => {
    expect(["timeseries", "stat", "gauge", "logs", "bar", "table"].map((t) => queryKindFor(t as PanelType)))
      .toEqual(["range", "range", "range", "range", "instant", "instant"]);
    const bar = buildPanelRun({ panel: panelOf("bar", [q("A", "up")]), owner: project(projA), vars: {}, range: { start: 7, end: 3607 }, ownerName: "projA" });
    expect(bar.requests).toEqual([{ source_id: "promA", project_id: "a", kind: "instant", query: "up", time: 3607 }]);
    const logs = panelOf("logs", [q("A", '{app="x"}', { source: { type: "loki", id: null } })], 24);
    const newest = buildPanelRun({ panel: logs, owner: project(projA), vars: {}, range: HOUR, ownerName: "projA" });
    expect(newest.requests).toEqual([{
      source_id: "lokiA", project_id: "a", kind: "range", query: '{app="x"}', start: 0, end: 3600, step: 5,
      limit: 100, direction: "backward",
    }]);
    const oldest = { ...logs, options: { limit: 50, wrap: true, order: "oldest" } } as PanelSpec;
    const run = buildPanelRun({ panel: oldest, owner: project(projA), vars: {}, range: HOUR, ownerName: "projA" });
    expect(run.requests[0]).toMatchObject({ limit: 50, direction: "forward" });
  });

  it("the run key is stable and changes with what is sent", () => {
    const one = buildPanelRun({ panel: ts("up"), owner: project(projA), vars: {}, range: HOUR, ownerName: "projA" });
    const same = buildPanelRun({ panel: ts("up"), owner: project(projA), vars: {}, range: HOUR, ownerName: "projA" });
    const later = buildPanelRun({ panel: ts("up"), owner: project(projA), vars: {}, range: { start: 60, end: 3660 }, ownerName: "projA" });
    expect(panelRunKey(one)).toBe(panelRunKey(same));
    expect(panelRunKey(one)).not.toBe(panelRunKey(later));
    expect(JSON.parse(panelRunKey(one))).toEqual(one.requests);
  });
});

// --- merging answers --------------------------------------------------------------------------

describe("mergePanelResults", () => {
  const panel = ts("up");
  const run = buildPanelRun({ panel, owner: group([projA, projB]), vars: {}, range: HOUR, ownerName: "Prod" });

  it("one project failing makes a group panel partial and names it", () => {
    const data = mergePanelResults(panel, run, [ok(seriesFor("a")), fail("unreachable", "Can't reach Prometheus · b: the connection was refused. Check the address and that the tool is running.")], "group");
    expect(data.state).toBe("partial");
    expect(data.series.map((s) => s.name)).toEqual(['projA · {job="x"}']);
    expect(data.series[0]).toMatchObject({ queryRef: "A", projectName: "projA", labels: { __name__: "up", job: "x" }, points: [[0, 1], [5, 2]] });
    expect(data.problems).toEqual(["projB: Can't reach Prometheus · b: the connection was refused. Check the address and that the tool is running."]);
    expect(data.summary).toEqual({ series: 1, points: 2, tookMs: 3 });
  });

  it("every part unreachable is unreachable; a bad query is an error", () => {
    const down = mergePanelResults(panel, run, [fail("timeout", "Prometheus took too long."), fail("unreachable", "Can't reach it.")], "group");
    expect(down.state).toBe("unreachable");
    expect(down.series).toEqual([]);
    expect(down.problems).toEqual(["projA: Prometheus took too long.", "projB: Can't reach it."]);
    const bad = mergePanelResults(panel, run, [fail("bad_query", "Unknown function.", 400), fail("bad_query", "Unknown function.", 400)], "group");
    expect(bad.state).toBe("error");
    expect(bad.problems).toEqual(["projA: Unknown function.", "projB: Unknown function."]);
    const single = buildPanelRun({ panel, owner: project(projA), vars: {}, range: HOUR, ownerName: "projA" });
    expect(mergePanelResults(panel, single, [fail("bad_query", "Unknown function.", 400)], "project").problems).toEqual(["Unknown function."]);
  });

  it("every project skipped is an error that says why", () => {
    const skipped = buildPanelRun({ panel, owner: group([projNoProm]), vars: {}, range: HOUR, ownerName: "Prod" });
    const data = mergePanelResults(panel, skipped, [], "group");
    expect(data.state).toBe("error");
    expect(data.problems).toEqual(["no-prom has no Prometheus-compatible source."]);
  });

  it("a source unlinked since the page loaded says how to fix it", () => {
    const data = mergePanelResults(panel, run, [ok(seriesFor("a")), fail("not_linked", "This source isn't linked to that project.", 404)], "group");
    expect(data.state).toBe("partial");
    expect(data.problems).toEqual(["This panel's source isn't linked to projB any more. Pick another in the panel's Query tab."]);
    const gone = mergePanelResults(panel, run, [fail("not_found", "That source no longer exists.", 404), ok()], "group");
    expect(gone.problems).toEqual(["This panel's source isn't linked to projA any more. Pick another in the panel's Query tab."]);
    expect(gone.state).toBe("partial");
  });

  it("truncated results are partial with the server's warning", () => {
    const warning = "Only the first 500 series are shown. Narrow the query to see the rest.";
    const data = mergePanelResults(panel, run, [ok({ ...seriesFor("a"), truncated: true, warnings: [warning] }), ok({ warnings: [warning] })], "group");
    expect(data.state).toBe("partial");
    expect(data.problems).toEqual([warning]);
  });

  it("an answer cut short without a warning still says so", () => {
    const data = mergePanelResults(panel, run, [ok({ ...seriesFor("a"), truncated: true }), ok()], "group");
    expect(data.state).toBe("partial");
    expect(data.problems).toEqual([CUT_SHORT]);
    expect(CUT_SHORT).toBe("Some results were cut short; narrow the query or the time range.");
  });

  it("empty answers are empty; answers with data are ready", () => {
    expect(mergePanelResults(panel, run, [ok(), ok()], "group").state).toBe("empty");
    const data = mergePanelResults(panel, run, [ok(seriesFor("a")), ok({ ...seriesFor("b"), took_ms: 9 })], "group");
    expect(data.state).toBe("ready");
    expect(data.series.map((s) => s.name)).toEqual(['projA · {job="x"}', 'projB · {job="x"}']);
    expect(new Set(data.series.map((s) => s.key)).size).toBe(2);
    expect(data.summary).toEqual({ series: 2, points: 4, tookMs: 9 });
  });

  it("series keys and names follow the query, the project and the labels", () => {
    const two = panelOf("timeseries", [q("A", "sum(up)", { legend: "{{job}}" }), q("B", "up")]);
    const r = buildPanelRun({ panel: two, owner: project(projA), vars: {}, range: HOUR, ownerName: "projA" });
    const labels = { job: "x", b: "1" };
    const first = mergePanelResults(two, r, [ok({ series: [{ labels, points: [] }] }), ok({ series: [{ labels: {}, points: [] }] })], "project");
    expect(first.series.map((s) => [s.name, s.queryRef, s.projectName])).toEqual([["x", "A", null], ["up", "B", null]]);
    const again = mergePanelResults(two, r, [ok({ series: [{ labels: { b: "1", job: "x" }, points: [] }] }), ok()], "project");
    expect(again.series[0].key).toBe(first.series[0].key);
    expect(first.series[0].key).not.toBe(first.series[1].key);
  });

  it("log lines from every stream merge newest first, keeping their labels", () => {
    const logs = panelOf("logs", [q("A", '{app="x"}', { source: { type: "loki", id: null } })], 24);
    const lr = buildPanelRun({ panel: logs, owner: group([projA, projB]), vars: {}, range: HOUR, ownerName: "Prod" });
    const a = ok({ result_type: "streams", streams: [{ labels: { app: "x", pod: "1" }, entries: [["3000000000", "a3"], ["1000000000", "a1"]] }] });
    const b = ok({ result_type: "streams", streams: [{ labels: { app: "x", pod: "2" }, entries: [["20000000000", "b20"], ["2000000000", "b2"]] }] });
    const data = mergePanelResults(logs, lr, [a, b], "group");
    expect(data.state).toBe("ready");
    expect(data.logs.map((l) => [l.line, l.projectName])).toEqual([["b20", "projB"], ["a3", "projA"], ["b2", "projB"], ["a1", "projA"]]);
    expect(data.logs[0]).toMatchObject({ ts: "20000000000", labels: { app: "x", pod: "2" } });
    expect(new Set(data.logs.map((l) => l.key)).size).toBe(4);
    const oldest = { ...logs, options: { limit: 100, wrap: true, order: "oldest" } } as PanelSpec;
    expect(mergePanelResults(oldest, lr, [a, b], "group").logs.map((l) => l.line)).toEqual(["a1", "b2", "a3", "b20"]);
  });
});

// --- running ----------------------------------------------------------------------------------

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}

describe("usePanelData", () => {
  const panel = ts("up");
  const at = (start: number) => buildPanelRun({ panel, owner: project(projA), vars: {}, range: { start, end: start + 3600 }, ownerName: "projA" });

  it("runs a panel's queries in one batch and merges the answer", async () => {
    const api = installFakeMonitoringApi({ projects: [projA], queryAnswers: { "a|up": { series: [{ labels: { job: "x" }, points: [[0, 1]] }] } } });
    const client = new QueryClient();
    const { result } = renderHook(() => usePanelData("d1", panel, at(0), null, true), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data?.state).toBe("ready"));
    expect(result.current.data?.series.map((s) => s.name)).toEqual(['{job="x"}']);
    expect(result.current.updatedAt).toEqual(expect.any(Number));
    expect(result.current.failedAt).toBeNull();
    expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /api/monitoring/query/batch"]);
    const keys = client.getQueryCache().getAll().map((c) => c.queryKey);
    expect(keys).toEqual([["monitoring", "panel", "d1", "p-1", panelRunKey(at(0))]]);
  });

  it("keeps the previous answer while a new window loads, then a refresh that fails returns no old series", async () => {
    installFakeMonitoringApi({ projects: [projA], queryAnswers: { "a|up": { series: [{ labels: { job: "x" }, points: [[0, 1]] }] } } });
    const client = new QueryClient();
    const { result, rerender } = renderHook(({ run }: { run: PanelRun }) => usePanelData("d1", panel, run, null, true), {
      wrapper: wrapper(client), initialProps: { run: at(0) },
    });
    await waitFor(() => expect(result.current.data?.state).toBe("ready"));
    const firstUpdate = result.current.updatedAt;

    let reject!: (e: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((_, no) => { reject = no; })));
    rerender({ run: at(60) });
    await waitFor(() => expect(result.current.fetching).toBe(true));
    expect(result.current.data?.series).toHaveLength(1); // the previous window stays shown while loading
    expect(result.current.updatedAt).toBe(firstUpdate);

    await act(async () => reject(new TypeError("Failed to fetch")));
    await waitFor(() => expect(result.current.data?.state).toBe("unreachable"));
    expect(result.current.data?.series).toEqual([]);
    expect(result.current.data?.problems).toEqual([NETWORK_MESSAGE]);
    expect(result.current.updatedAt).toBeNull();
    expect(result.current.failedAt).toEqual(expect.any(Number));
    expect(result.current.fetching).toBe(false);
  });

  it("a refetch of the same window that fails never shows the old series", async () => {
    installFakeMonitoringApi({ projects: [projA], queryAnswers: { "a|up": { series: [{ labels: { job: "x" }, points: [[0, 1]] }] } } });
    const client = new QueryClient();
    const { result } = renderHook(() => usePanelData("d1", panel, at(0), null, true), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data?.state).toBe("ready"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.data?.state).toBe("unreachable"));
    expect(result.current.data?.series).toEqual([]);
    expect(result.current.updatedAt).toBeNull();
  });

  it("a legend edit redraws from the same answer without a query", async () => {
    const api = installFakeMonitoringApi({ projects: [projA], queryAnswers: { "a|up": { series: [{ labels: { job: "x" }, points: [[0, 1]] }] } } });
    const client = new QueryClient();
    const run = at(0);
    const { result, rerender } = renderHook(({ p }: { p: PanelSpec }) => usePanelData("d1", p, run, null, true), {
      wrapper: wrapper(client), initialProps: { p: panel },
    });
    await waitFor(() => expect(result.current.data?.state).toBe("ready"));
    rerender({ p: { ...panel, queries: [{ ...panel.queries[0], legend: "job {{job}}" }] } as PanelSpec });
    expect(result.current.data?.series[0].name).toBe("job x");
    expect(api.requests).toHaveLength(1);
  });

  it("never shows another panel's data while its own first answer loads", async () => {
    installFakeMonitoringApi({ projects: [projA], queryAnswers: { "a|up": { series: [{ labels: { job: "x" }, points: [[0, 1]] }] } } });
    const client = new QueryClient();
    const { result, rerender } = renderHook(({ id }: { id: string }) => usePanelData(id, panel, at(0), null, true), {
      wrapper: wrapper(client), initialProps: { id: "d1" },
    });
    await waitFor(() => expect(result.current.data?.state).toBe("ready"));
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    rerender({ id: "d2" });
    await waitFor(() => expect(result.current.fetching).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.updatedAt).toBeNull();
  });

  it("tags each answer with the edit count when its fetch began; a refresh keeps the old tag", async () => {
    installFakeMonitoringApi({ projects: [projA], queryAnswers: { "a|up": { series: [{ labels: { job: "x" }, points: [[0, 1]] }] } } });
    const client = new QueryClient();
    const { result, rerender } = renderHook(
      ({ run, edit }: { run: PanelRun; edit: number }) => usePanelData("d1", panel, run, null, true, edit),
      { wrapper: wrapper(client), initialProps: { run: at(0), edit: 0 } },
    );
    await waitFor(() => expect(result.current.data?.editId).toBe(0));
    // An option-only edit: same key, newer count; the data keeps its tag.
    rerender({ run: at(0), edit: 1 });
    expect(result.current.data?.editId).toBe(0);
    // A refresh (a new window, same queries) after an option edit: still the old tag, so it jumps.
    rerender({ run: at(60), edit: 1 });
    await waitFor(() => expect(result.current.fetching).toBe(false));
    expect(result.current.data?.editId).toBe(0);
    rerender({ run: at(120), edit: 1 });
    await waitFor(() => expect(result.current.fetching).toBe(false));
    expect(result.current.data?.editId).toBe(0);
    // A query edit (the queries changed) takes the current count.
    const edited = buildPanelRun({ panel: ts("up2"), owner: project(projA), vars: {}, range: { start: 120, end: 3720 }, ownerName: "projA" });
    rerender({ run: edited, edit: 2 });
    await waitFor(() => expect(result.current.data?.editId).toBe(2));
  });

  it("a panel with nothing to send asks nothing", () => {
    const api = installFakeMonitoringApi();
    const client = new QueryClient();
    const none = buildPanelRun({ panel: ts(""), owner: project(projA), vars: {}, range: HOUR, ownerName: "projA" });
    const { result } = renderHook(() => usePanelData("d1", ts(""), none, null, true), { wrapper: wrapper(client) });
    expect(result.current.data?.state).toBe("noQuery");
    expect(api.requests).toEqual([]);
  });

  it("a whole batch refused by the server is an error in its words", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: { code: "bad_request", message: "Send 1 to 64 queries in one batch." } }, { status: 422 })));
    const client = new QueryClient();
    const { result } = renderHook(() => usePanelData("d1", panel, at(0), null, true), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data?.state).toBe("error"));
    expect(result.current.data?.problems).toEqual(["Send 1 to 64 queries in one batch."]);
  });
});

describe("runRequests", () => {
  it("sends more than 64 items as several batches and keeps their order", async () => {
    const projects = Array.from({ length: 70 }, (_, i) => proj(`p${i}`, `p${i}`, [link("s", "prometheus")]));
    const api = installFakeMonitoringApi({ projects, queryAnswers: { up: { series: [] } } });
    const requests = projects.map((p) => ({ source_id: "s", project_id: p.id, kind: "instant" as const, query: "up", time: 1 }));
    const results = await runRequests(requests);
    expect(results).toHaveLength(70);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[69].response?.project_id).toBe("p69");
    expect(api.requests.map((r) => (r.body as { queries: unknown[] }).queries.length)).toEqual([64, 6]);
  });
});
