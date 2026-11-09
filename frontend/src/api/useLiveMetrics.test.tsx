import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { MetricsOut } from "./types";
import { LIVE_FOR_MS, useLiveMetrics } from "./useMetrics";

const body = (message: string | null = null, state: "ok" | "unavailable" = "ok"): MetricsOut => ({
  kind: "pods",
  clusters: {
    c1: {
      state, message, fetched_at: null,
      nodes: { worker: { cpu_m: 2000, memory_b: 4096 } },
      items: state === "ok" ? { "demo/web": { cpu_m: 110, memory_b: 1, at: "2026-11-07T14:00:00Z", window_s: 15, stale: false } } : {},
    },
  },
});
const ok = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } }));

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const OUT_OF_DATE = /^Metrics are out of date, so they're hidden: /;

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe("useLiveMetrics", () => {
  it("node sizes come only from a live pods answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => ok(body())).mockImplementation(() => new Promise(() => {})));
    const { result } = renderHook(() => useLiveMetrics("pods", true), { wrapper });
    expect(result.current!.nodeSize("c1", "worker")).toBeNull();
    await settle();
    expect(result.current!.nodeSize("c1", "worker")).toEqual({ cpu_m: 2000, memory_b: 4096 });
    expect(result.current!.nodeSize("c1", "missing")).toBeNull();
    expect(result.current!.nodeSize("missing", "worker")).toBeNull();
    await advance(LIVE_FOR_MS + 100);
    expect(result.current!.nodeSize("c1", "worker")).toBeNull();
  });

  it("a nodes answer cannot supply pod node sizes", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok({ ...body(), kind: "nodes" })));
    const { result } = renderHook(() => useLiveMetrics("nodes", true), { wrapper });
    await settle();
    expect(result.current!.nodeSize("c1", "worker")).toBeNull();
  });

  it("numbers disappear 45 s after the last poll even when nothing else re-renders", async () => {
    // The first poll answers; every later one hangs, so no render comes from the network.
    const fetch = vi.fn().mockImplementationOnce(() => ok(body())).mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useLiveMetrics("pods", true), { wrapper });
    await settle();
    expect(result.current?.usage("c1", "demo/web").usage?.cpu_m).toBe(110);
    await advance(LIVE_FOR_MS - 1_000);
    expect(result.current?.usage("c1", "demo/web").usage?.cpu_m).toBe(110);
    await advance(1_100);
    const l = result.current!.usage("c1", "demo/web");
    expect(l.usage).toBeNull();
    expect(l.why).toMatch(OUT_OF_DATE);
  });

  it("a poll that fails hides the numbers, and a poll that recovers shows them again", async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => ok(body()))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ detail: "Bad gateway" }), { status: 502 })))
      .mockImplementation(() => ok(body()));
    vi.stubGlobal("fetch", fetch);
    const { result } = renderHook(() => useLiveMetrics("pods", true), { wrapper });
    await settle();
    expect(result.current?.usage("c1", "demo/web").usage).not.toBeNull();
    await advance(15_100);
    const failed = result.current!.usage("c1", "demo/web");
    expect(failed.usage).toBeNull();
    expect(result.current!.nodeSize("c1", "worker")).toBeNull();
    expect(failed.why).toBe("Metrics are out of date, so they're hidden: Bad gateway");
    await advance(15_100);
    const back = result.current!.usage("c1", "demo/web");
    expect(back.usage?.cpu_m).toBe(110);
    expect(result.current!.nodeSize("c1", "worker")).toEqual({ cpu_m: 2000, memory_b: 4096 });
    expect(back.why).toBeNull();
  });

  it("cached numbers older than 45 s are not judged while the refetch is on its way", async () => {
    client.setQueryData(["metrics", "pods"], body(), { updatedAt: Date.now() - 2 * LIVE_FOR_MS });
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { result } = renderHook(() => useLiveMetrics("pods", true), { wrapper });
    await settle();
    // Neither numbers nor an alarming notice: they are loading.
    expect(result.current!.usage("c1", "demo/web")).toEqual({ usage: null, why: null });
    expect(result.current!.why("c1")).toBeNull();
    expect(result.current!.nodeSize("c1", "worker")).toBeNull();
  });

  it("a cluster without a message still explains itself", async () => {
    vi.stubGlobal("fetch", vi.fn(() => ok(body(null, "unavailable"))));
    const { result } = renderHook(() => useLiveMetrics("pods", true), { wrapper });
    await settle();
    const why = result.current!.why("c1");
    expect(why).toMatch(/^Metrics not available on this cluster\. /);
    expect(why).toContain("metrics-server");
    expect(result.current!.nodeSize("c1", "worker")).toBeNull();
  });
});
