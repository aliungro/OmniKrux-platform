import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkOut, ProjectOut, QueryRequest, QueryResponse } from "../api/types";
import { ONE_QUERY, UNREADABLE } from "../build/promql";
import { DashboardRequestError, type BatchItemOut } from "../dashboards/api";
import { stepFor } from "../dashboards/time";
import { EXPLORE_DEBOUNCE_MS, useExploreRun, useLinesRun } from "./useExploreRun";

const runBatch = vi.fn<(q: QueryRequest[], s?: AbortSignal) => Promise<BatchItemOut[]>>();
vi.mock("../dashboards/api", async (orig) => ({
  ...(await orig<typeof import("../dashboards/api")>()),
  runBatch: (q: QueryRequest[], s?: AbortSignal) => runBatch(q, s),
}));

const link = (id: string, type: "prometheus" | "loki"): LinkOut => ({
  source_id: id, source_name: id, source_type: type, filter: "", filter_origin: "none", created_by_project: false,
});
const project: ProjectOut = {
  id: "p1", name: "Shop", kind: "custom", cluster_id: null, cluster_name: null, cluster_provider: null,
  links: [link("prom", "prometheus"), link("loki", "loki")], group_ids: [], created_at: "", updated_at: "",
};
const source = project.links[0];
const range = { start: 3600, end: 7200 };
const input = (expr: string) => ({ project, source, expr, range, kind: "metrics" as const });

const ok = (v: number, series = 1): BatchItemOut => ({
  ok: true, error: null,
  response: {
    result_type: "matrix", series: Array.from({ length: series }, (_, i) => ({ labels: { job: `j${i}` }, points: [[3600, v], [3660, v]] })),
    streams: [], warnings: [], truncated: false, source_id: "prom", source_name: "prom", source_type: "prometheus",
    project_id: "p1", applied_filter: "", query: "", took_ms: 41,
  } as QueryResponse,
});
const refused = (code: "bad_query" | "unreachable", message: string): BatchItemOut => ({
  ok: false, response: null, error: { code, message, status: code === "bad_query" ? 400 : 502 },
});

beforeEach(() => { vi.useFakeTimers(); runBatch.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const flush = async (ms = EXPLORE_DEBOUNCE_MS) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("useExploreRun", () => {
  it("typing runs once 300 ms after the last keystroke", async () => {
    runBatch.mockResolvedValue([ok(1, 3)]);
    const { result, rerender } = renderHook(({ expr }) => useExploreRun(input(expr)), { initialProps: { expr: "rate(up" } });
    expect(EXPLORE_DEBOUNCE_MS).toBe(300);
    await flush(100);
    rerender({ expr: "rate(up[$__rate_interval]" });
    await flush(100);
    rerender({ expr: "rate(up[$__rate_interval])" });
    expect(result.current.state.status).toBe("waiting");
    await flush(299);
    expect(runBatch).not.toHaveBeenCalled();
    await flush(1);
    expect(runBatch).toHaveBeenCalledTimes(1);
    const [req] = runBatch.mock.calls[0][0];
    const step = stepFor(3600, 24);
    // The batch carries the substituted window, never `$__rate_interval`; and always the project.
    expect(req).toMatchObject({ project_id: "p1", source_id: "prom", kind: "range", step });
    // An hour at full width has a small step: the four-minute floor holds.
    expect(req.query).toBe("rate(up[4m])");
    expect(result.current.state.status).toBe("done");
    expect(result.current.state.data?.series).toHaveLength(3);
    expect(result.current.state.tookMs).toBe(41);
    await flush(1000);
    expect(runBatch).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+Enter runs at once", async () => {
    runBatch.mockResolvedValue([ok(1)]);
    const { result, rerender } = renderHook(({ expr }) => useExploreRun(input(expr)), { initialProps: { expr: "" } });
    rerender({ expr: "up" });
    await act(async () => { result.current.run(true); });
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(runBatch.mock.calls[0][0][0].query).toBe("up");
    await flush(1000);
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe("done");
  });

  it("an older answer never replaces a newer one", async () => {
    let first!: (r: BatchItemOut[]) => void;
    runBatch.mockImplementationOnce(() => new Promise((res) => { first = res; }));
    runBatch.mockResolvedValueOnce([ok(2)]);
    const { result, rerender } = renderHook(({ expr }) => useExploreRun(input(expr)), { initialProps: { expr: "up" } });
    await flush();
    const signal = runBatch.mock.calls[0][1] as AbortSignal;
    rerender({ expr: "up2" });
    expect(signal.aborted).toBe(true);
    await flush();
    expect(result.current.state.status).toBe("done");
    const runId = result.current.state.runId;
    await act(async () => { first([ok(1)]); });
    expect(result.current.state.runId).toBe(runId);
    expect(result.current.state.data?.series[0].points[0][1]).toBe(2);
    expect(result.current.state.lastGood?.expr).toBe("up2");
  });

  it("an unbalanced query is invalid without a request", async () => {
    runBatch.mockResolvedValue([ok(1)]);
    const { result, rerender } = renderHook(({ expr }) => useExploreRun(input(expr)), { initialProps: { expr: "up" } });
    await flush();
    expect(runBatch).toHaveBeenCalledTimes(1);
    rerender({ expr: 'sum(up{job="api}' });
    await flush();
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe("invalid");
    expect(result.current.state.message).toBe("The query has an unclosed quote or bracket.");
    expect(result.current.state.message).toBe(UNREADABLE);
    expect(result.current.state.lastGood?.expr).toBe("up");
  });

  it("a bad query keeps the last good result", async () => {
    runBatch.mockResolvedValueOnce([ok(1)]);
    runBatch.mockResolvedValueOnce([refused("bad_query", "parse error: unexpected identifier")]);
    const { result, rerender } = renderHook(({ expr }) => useExploreRun(input(expr)), { initialProps: { expr: "up" } });
    await flush();
    rerender({ expr: "up up" });
    await flush();
    expect(result.current.state.status).toBe("invalid");
    expect(result.current.state.message).toBe("parse error: unexpected identifier");
    expect(result.current.state.data).toBeNull();
    expect(result.current.state.lastGood?.expr).toBe("up");
    expect(result.current.state.lastGood?.range).toEqual({ start: 3600, end: 7200 });
    expect(result.current.state.lastGood?.step).toBe(stepFor(3600, 24));
  });

  it("a source failure replaces the last good chart", async () => {
    runBatch.mockResolvedValueOnce([ok(1)]);
    runBatch.mockResolvedValueOnce([refused("unreachable", "Prometheus didn't answer.")]);
    runBatch.mockRejectedValueOnce(new DashboardRequestError(0, "network", "Can't reach the console's server."));
    const { result, rerender } = renderHook(({ expr }) => useExploreRun(input(expr)), { initialProps: { expr: "up" } });
    await flush();
    expect(result.current.state.data).not.toBeNull();
    rerender({ expr: "up2" });
    await flush();
    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.data).toBeNull();
    expect(result.current.state.message).toBe("Prometheus didn't answer.");
    expect(result.current.state.failure).toBe("unreachable");
    // A whole batch that didn't answer fails the same way.
    rerender({ expr: "up3" });
    await flush();
    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.data).toBeNull();
    expect(result.current.state.message).toBe("Can't reach the console's server.");
    // A typo after a failure never brings back the chart from before it.
    expect(result.current.state.lastGood).toBeNull();
    rerender({ expr: "sum(up" });
    await flush();
    expect(result.current.state.status).toBe("invalid");
    expect(result.current.state.lastGood).toBeNull();
  });

  it("several queries are invalid without a request", async () => {
    runBatch.mockResolvedValue([ok(1)]);
    const { result, rerender } = renderHook(({ expr }) => useExploreRun(input(expr)), { initialProps: { expr: "up" } });
    await flush();
    rerender({ expr: "up\nrate(x[5m])" });
    await flush();
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({ status: "invalid", message: ONE_QUERY, failure: null });
    expect(result.current.state.lastGood?.expr).toBe("up");
  });

  it("a whole batch refused as a bad request is invalid, not a failure", async () => {
    runBatch.mockResolvedValueOnce([ok(1)]);
    runBatch.mockRejectedValueOnce(new DashboardRequestError(400, "bad_request", "The query isn't valid LogQL."));
    const { result, rerender } = renderHook(({ expr }) => useExploreRun(input(expr)), { initialProps: { expr: "up" } });
    await flush();
    rerender({ expr: "up2" });
    await flush();
    expect(result.current.state).toMatchObject({ status: "invalid", shown: "invalid", message: "The query isn't valid LogQL.", failure: null });
    expect(result.current.state.lastGood?.expr).toBe("up");
  });

  it("a run that is off sends nothing and stays idle", async () => {
    let first!: (r: BatchItemOut[]) => void;
    runBatch.mockImplementationOnce(() => new Promise((res) => { first = res; }));
    runBatch.mockResolvedValue([ok(1)]);
    const { result, rerender } = renderHook(
      ({ expr, enabled }) => useExploreRun({ ...input(expr), enabled }),
      { initialProps: { expr: "up", enabled: true } },
    );
    await flush();
    expect(runBatch).toHaveBeenCalledTimes(1);
    // Turned off while its answer is on its way: the answer is dropped, nothing is kept.
    rerender({ expr: '{app="x"}', enabled: false });
    await act(async () => { result.current.run(true); });
    await flush(1000);
    await act(async () => { first([ok(1)]); });
    expect(runBatch).toHaveBeenCalledTimes(1);
    expect(result.current.state).toMatchObject({ status: "idle", shown: "idle", data: null, lastGood: null, request: null });
    // On again: it runs as before.
    rerender({ expr: "up", enabled: true });
    await flush();
    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe("done");
  });

  it("log lines: a refused text is invalid, an unreachable Loki failed, several queries send nothing", async () => {
    const lokiSource = project.links[1];
    runBatch.mockResolvedValueOnce([refused("bad_query", "parse error at line 2, col 1: syntax error: unexpected {")]);
    runBatch.mockResolvedValueOnce([refused("unreachable", "Loki didn't answer in time.")]);
    const lines = (query: string) => ({ project, source: lokiSource, query, range, window: null, timeText: "Last 1 hour" });
    const { result, rerender } = renderHook(({ query }) => useLinesRun(lines(query)), { initialProps: { query: '{a="b"} |=\n{c="d"}' } });
    await flush();
    expect(result.current.state).toMatchObject({ status: "invalid", shown: "invalid", lines: [], request: null });
    expect(result.current.state.message).toBe("parse error at line 2, col 1: syntax error: unexpected {");
    rerender({ query: '{a="b"}' });
    await flush();
    expect(result.current.state).toMatchObject({ status: "failed", shown: "failed", message: "Loki didn't answer in time.", lines: [] });
    rerender({ query: '{a="b"}\n{c="d"}' });
    await flush();
    expect(runBatch).toHaveBeenCalledTimes(2);
    expect(result.current.state).toMatchObject({ status: "invalid", shown: "invalid", message: ONE_QUERY });
    expect(result.current.state.at).not.toBeNull();
  });

  it("another project or source starts over, the last good result included", async () => {
    runBatch.mockResolvedValue([ok(1)]);
    const other: ProjectOut = { ...project, id: "p2", name: "Zoo" };
    const { result, rerender } = renderHook(({ p, s, expr }) => useExploreRun({ project: p, source: s, expr, range, kind: "metrics" }), {
      initialProps: { p: project, s: source, expr: "up" },
    });
    await flush();
    rerender({ p: project, s: source, expr: "sum(up" });
    await flush();
    expect(result.current.state.lastGood?.expr).toBe("up");
    // Another source of the same project: nothing from the first is kept, not even for a frame.
    rerender({ p: project, s: project.links[1], expr: "sum(up" });
    expect(result.current.state).toMatchObject({ status: "waiting", shown: "idle", data: null, lastGood: null });
    await flush();
    expect(result.current.state).toMatchObject({ status: "invalid", lastGood: null });
    // Another project: the same.
    rerender({ p: project, s: source, expr: "up" });
    await flush();
    expect(result.current.state.status).toBe("done");
    rerender({ p: other, s: other.links[0], expr: "up" });
    expect(result.current.state).toMatchObject({ shown: "idle", data: null, lastGood: null });
    await flush();
    expect(result.current.state).toMatchObject({ status: "done", projectId: "p2", sourceId: "prom" });
  });
});
