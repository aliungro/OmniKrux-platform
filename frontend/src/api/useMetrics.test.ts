import { describe, expect, it } from "vitest";
import type { MetricsOut, Usage } from "./types";
import { LIVE_FOR_MS, liveUsage, type MetricsSnapshot } from "./useMetrics";

const usage = (over: Partial<Usage> = {}): Usage => ({ cpu_m: 110, memory_b: 301 * 1024 ** 2, at: "2026-11-07T14:00:00Z", window_s: 15, stale: false, ...over });
const data = (over: Partial<MetricsOut["clusters"][string]> = {}): MetricsOut => ({
  kind: "pods",
  clusters: { c1: { state: "ok", message: null, fetched_at: null, items: { "demo/web": usage() }, ...over } },
});
const snap = (over: Partial<MetricsSnapshot> = {}): MetricsSnapshot => ({ data: data(), isError: false, dataUpdatedAt: 1_000_000, ...over });

describe("liveUsage", () => {
  it("returns the item while the last poll is fresh", () => {
    const l = liveUsage(snap(), "c1", "demo/web", 1_000_000 + LIVE_FOR_MS);
    expect(l.usage?.cpu_m).toBe(110);
    expect(l.why).toBeNull();
  });

  it("metrics older than 45 s are not shown as live", () => {
    const l = liveUsage(snap(), "c1", "demo/web", 1_000_000 + LIVE_FOR_MS + 1);
    expect(l.usage).toBeNull();
    expect(l.why).toMatch(/^Metrics are out of date, so they're hidden: /);
  });

  it("failed poll hides numbers", () => {
    // The query keeps the last good data after a failed poll; it must not be shown.
    const l = liveUsage(snap({ isError: true, error: new Error("Bad gateway") }), "c1", "demo/web", 1_000_001);
    expect(l.usage).toBeNull();
    expect(l.why).toBe("Metrics are out of date, so they're hidden: Bad gateway");
  });

  it("an unreachable server says what to check", () => {
    const l = liveUsage(snap({ isError: true, error: new TypeError("fetch failed") }), "c1", "demo/web", 1_000_001);
    expect(l.why).toContain("Can't reach the console's server");
  });

  it("a cluster that is not ok shows its own message and no numbers", () => {
    const message = "Metrics not available on this cluster: metrics-server isn't installed.";
    const l = liveUsage(snap({ data: data({ state: "unavailable", message, items: {} }) }), "c1", "demo/web", 1_000_001);
    expect(l).toEqual({ usage: null, why: message });
  });

  it("an unmeasured item or cluster has no numbers and nothing to explain", () => {
    expect(liveUsage(snap(), "c1", "demo/other", 1_000_001)).toEqual({ usage: null, why: null });
    expect(liveUsage(snap(), "c9", "demo/web", 1_000_001)).toEqual({ usage: null, why: null });
    expect(liveUsage({ data: undefined, isError: false, dataUpdatedAt: 0 }, "c1", "demo/web", 5)).toEqual({ usage: null, why: null });
  });
});
