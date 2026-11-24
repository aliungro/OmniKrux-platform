import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { useToolsProbe } from "./useToolsProbe";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const URLS = { prometheus: "http://h.example:9090", loki: "http://h.example:3100" } as const;
const probes = (api: ReturnType<typeof installFakeMonitoringApi>) => api.requests.filter((r) => r.url === "/api/monitoring/install/probe");
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** A fetch whose probes stay open until aborted, so what happens to the request in flight shows. */
function hanging() {
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    const signal = init?.signal as AbortSignal;
    signals.push(signal);
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })));
  return signals;
}

describe("useToolsProbe", () => {
  it("asks at once, then every 5 seconds, and none while nothing is to be asked", async () => {
    const api = installFakeMonitoringApi();
    const { result, rerender } = renderHook(({ urls }) => useToolsProbe(urls), { initialProps: { urls: null as Record<string, string> | null } });
    await tick(20000);
    expect(probes(api)).toHaveLength(0);
    expect(result.current.waiting).toBe(false);

    rerender({ urls: { ...URLS } });
    await tick(0);
    expect(probes(api)).toHaveLength(1);
    expect(result.current.waiting).toBe(true);
    await tick(5000);
    await tick(5000);
    expect(probes(api)).toHaveLength(3);
    expect(result.current.results.every((r) => !r.ok)).toBe(true);
  });

  it("stops when every tool answers, with what each said", async () => {
    const api = installFakeMonitoringApi({
      install: {
        probe: { [URLS.prometheus]: { ok: true, version: "3.1.0", message: null }, [URLS.loki]: { ok: true, version: "3.5.0", message: null } },
      },
    });
    const { result } = renderHook(() => useToolsProbe({ ...URLS }));
    await tick(0);
    expect(result.current.waiting).toBe(false);
    expect(result.current.gaveUp).toBe(false);
    expect(result.current.results.map((r) => r.version).sort()).toEqual(["3.1.0", "3.5.0"]);
    await tick(30000);
    expect(probes(api)).toHaveLength(1);
  });

  it("stop ends the wait and aborts the request in flight", async () => {
    const signals = hanging();
    const { result } = renderHook(() => useToolsProbe({ ...URLS }));
    await tick(0);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    act(() => result.current.stop());
    expect(signals[0].aborted).toBe(true);
    expect(result.current.waiting).toBe(false);
    expect(result.current.gaveUp).toBe(false);
    await tick(30000);
    expect(signals).toHaveLength(1);
  });

  it("closing the page aborts the request in flight and asks no more", async () => {
    const signals = hanging();
    const { unmount } = renderHook(() => useToolsProbe({ ...URLS }));
    await tick(0);
    unmount();
    expect(signals[0].aborted).toBe(true);
    await tick(60000);
    expect(signals).toHaveLength(1);
  });

  it("gives up after its time, and again starts a fresh wait", async () => {
    const api = installFakeMonitoringApi();
    const { result } = renderHook(() => useToolsProbe({ ...URLS }, { giveUpAfter: 12000 }));
    await tick(12000);
    expect(result.current.gaveUp).toBe(true);
    expect(result.current.waiting).toBe(false);
    const asked = probes(api).length;
    await tick(30000);
    expect(probes(api)).toHaveLength(asked);

    act(() => result.current.again());
    await tick(0);
    expect(result.current.waiting).toBe(true);
    expect(result.current.gaveUp).toBe(false);
    expect(probes(api).length).toBe(asked + 1);
  });
});
