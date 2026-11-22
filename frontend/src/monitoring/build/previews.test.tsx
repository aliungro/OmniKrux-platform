import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkOut, ProjectOut, QueryRequest, QueryResponse } from "../api/types";
import { DashboardRequestError, type BatchItemOut } from "../dashboards/api";
import type { DashboardOwner } from "../dashboards/runPanel";
import { durationText, stepFor } from "../dashboards/time";
import type { Candidate } from "./candidates";
import PreviewCard from "./PreviewCard";
import { MAX_PREVIEWS, PREVIEW_DEBOUNCE_MS, PREVIEW_LOG_LINES, PREVIEW_WIDTH, usePreviews } from "./usePreviews";

const runBatch = vi.fn<(q: QueryRequest[], s?: AbortSignal) => Promise<BatchItemOut[]>>();
vi.mock("../dashboards/api", async (orig) => ({
  ...(await orig<typeof import("../dashboards/api")>()),
  runBatch: (q: QueryRequest[], s?: AbortSignal) => runBatch(q, s),
}));

const link = (id: string, type: "prometheus" | "loki"): LinkOut => ({
  source_id: id, source_name: id, source_type: type, filter: "", filter_origin: "none", created_by_project: false,
});
const proj: ProjectOut = {
  id: "p1", name: "Shop", kind: "custom", cluster_id: null, cluster_name: null, cluster_provider: null,
  links: [link("prom", "prometheus"), link("loki", "loki")], group_ids: [], created_at: "", updated_at: "",
};
const owner: DashboardOwner = { kind: "project", project: proj };
const range = { start: 0, end: 3600 };
const ctx = { owner, ownerName: "Shop", vars: {}, range };

const cand = (key: string, over: Partial<Candidate> = {}): Candidate => ({
  key, title: key, subtitle: "", panelType: "timeseries", expr: `rate(${key}[$__rate_interval])`,
  sourceType: "prometheus", sourceId: "prom", unit: "none", legend: "", ...over,
});
const response = (v: number, over: Partial<QueryResponse> = {}): BatchItemOut => ({
  ok: true, error: null,
  response: {
    result_type: "matrix", series: [{ labels: { job: "x" }, points: [[0, v], [60, v]] }], streams: [], warnings: [],
    truncated: false, source_id: "prom", source_name: "prom", source_type: "prometheus", project_id: "p1", applied_filter: "",
    query: "", took_ms: 1, ...over,
  } as QueryResponse,
});

beforeEach(() => { vi.useFakeTimers(); runBatch.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const flush = async (ms = PREVIEW_DEBOUNCE_MS) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("previews", () => {
  it("run in one batch after the debounce", async () => {
    runBatch.mockResolvedValue([response(1), response(2), response(3)]);
    const list = [cand("a"), cand("b"), cand("c")];
    const { result } = renderHook(() => usePreviews(list, ctx));
    expect(result.current.a).toEqual({ status: "loading" });
    await flush(PREVIEW_DEBOUNCE_MS - 1);
    expect(runBatch).not.toHaveBeenCalled();
    await flush(1);
    expect(runBatch).toHaveBeenCalledTimes(1);
    const queries = runBatch.mock.calls[0][0];
    expect(queries).toHaveLength(3);
    const step = stepFor(3600, PREVIEW_WIDTH);
    expect(queries[0]).toMatchObject({ project_id: "p1", kind: "range", step });
    expect(queries[0].query).toBe(`rate(a[${durationText(Math.max(4 * step, 60))}])`);
    expect(result.current.a.status).toBe("done");
    expect(MAX_PREVIEWS).toBe(3);
  });

  it("only the first three candidates are previewed", async () => {
    runBatch.mockResolvedValue([response(1), response(2), response(3)]);
    const list = ["a", "b", "c", "d"].map((k) => cand(k));
    const { result } = renderHook(() => usePreviews(list, ctx));
    await flush();
    expect(runBatch.mock.calls[0][0]).toHaveLength(3);
    expect(result.current.d).toBeUndefined();
  });

  it("a late preview answer is ignored", async () => {
    let first!: (r: BatchItemOut[]) => void;
    runBatch.mockImplementationOnce(() => new Promise((res) => { first = res; }));
    runBatch.mockResolvedValueOnce([response(2)]);
    const { result, rerender } = renderHook(({ list }) => usePreviews(list, ctx), { initialProps: { list: [cand("a")] } });
    await flush();
    rerender({ list: [cand("b")] });
    await flush();
    expect(result.current.b.status).toBe("done");
    await act(async () => { first([response(1)]); });
    expect(result.current.a).toBeUndefined();
    const b = result.current.b;
    expect(b.status === "done" && b.data.series[0].points[0][1]).toBe(2);
  });

  it("changing the text aborts the batch in flight", async () => {
    runBatch.mockImplementation(() => new Promise(() => {}));
    const { rerender } = renderHook(({ list }) => usePreviews(list, ctx), { initialProps: { list: [cand("a")] } });
    await flush();
    const signal = runBatch.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    rerender({ list: [cand("b")] });
    expect(signal.aborted).toBe(true);
  });

  it("a failed preview says why and never shows an old chart", async () => {
    runBatch.mockResolvedValueOnce([response(1)]);
    runBatch.mockRejectedValueOnce(new DashboardRequestError(400, "bad_request", "The query was refused: bad syntax."));
    const { result, rerender } = renderHook(({ list }) => usePreviews(list, ctx), { initialProps: { list: [cand("a")] } });
    await flush();
    expect(result.current.a.status).toBe("done");
    rerender({ list: [cand("a"), cand("b")] });
    expect(result.current.a).toEqual({ status: "loading" });
    await flush();
    expect(result.current.a).toEqual({ status: "failed", message: "The query was refused: bad syntax." });
    render(<PreviewCard candidate={cand("a")} preview={result.current.a} active={false} onPick={() => {}} />);
    expect(screen.getByText("Can't preview: The query was refused: bad syntax.")).toBeTruthy();
  });

  it("logs previews ask for three lines", async () => {
    runBatch.mockResolvedValue([response(1)]);
    renderHook(() => usePreviews([cand("l", { panelType: "logs", sourceType: "loki", sourceId: "loki", expr: "{app=\"x\"}" })], ctx));
    await flush();
    expect(runBatch.mock.calls[0][0][0]).toMatchObject({ kind: "range", limit: PREVIEW_LOG_LINES });
  });

  it("a group with more than 64 requests limits the rest", async () => {
    const members = Array.from({ length: 40 }, (_, i) => ({ ...proj, id: `m${i}`, name: `M${i}` }));
    const group: DashboardOwner = {
      kind: "group", group: { id: "g", name: "G", project_ids: [], created_at: "", updated_at: "" }, members,
    };
    runBatch.mockImplementation(async (q) => q.map(() => response(1)));
    const { result } = renderHook(() => usePreviews([cand("a"), cand("b")], { ...ctx, owner: group }));
    await flush();
    expect(runBatch.mock.calls[0][0]).toHaveLength(40);
    expect(result.current.b).toEqual({ status: "failed", message: "Preview limited to the first projects." });
  });
});

describe("preview card", () => {
  const card = (preview: Parameters<typeof PreviewCard>[0]["preview"], more = {}) =>
    render(<PreviewCard candidate={cand("a")} preview={preview} active={false} onPick={() => {}} {...more} />);

  it("says loading, empty, active and added", () => {
    card({ status: "loading" });
    expect(screen.getByText("Loading…")).toBeTruthy();
    cleanup();
    card(
      { status: "done", data: { state: "empty", series: [], logs: [], problems: [], summary: { series: 0, points: 0, tookMs: 0 }, editId: 0 } },
      { active: true },
    );
    expect(screen.getByText("No data in this time range.")).toBeTruthy();
    expect(screen.getByText("Enter to add")).toBeTruthy();
    cleanup();
    card(undefined, { added: true });
    expect(screen.getByText("Added")).toBeTruthy();
  });
});
