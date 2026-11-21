import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COUNT_MS, easeOutCubic, FLASH_MS, MORPH_MS, mixColumns, tween, usePrefersReducedMotion } from "./motion";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("motion", () => {
  it("has the durations the design names", () => {
    expect([MORPH_MS, COUNT_MS, FLASH_MS]).toEqual([380, 380, 450]);
  });
  it("eases out", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
  it("mixes columns and lets gaps jump", () => {
    const from = Float32Array.of(0, 10, Number.NaN, 4);
    const to = Float32Array.of(10, 20, 6, Number.NaN);
    const half = mixColumns(from, to, 0.5);
    expect(half[0]).toBe(5);
    expect(half[1]).toBe(15);
    expect(half[2]).toBe(6);
    expect(Number.isNaN(half[3])).toBe(true);
    expect(Array.from(mixColumns(from, to, 1).slice(0, 2))).toEqual([10, 20]);
  });
  it("tweens over the duration and can be cancelled", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const frames: number[] = [];
    tween(100, (k) => frames.push(k));
    vi.advanceTimersByTime(500);
    expect(frames[frames.length - 1]).toBe(1);
    expect(frames.every((k) => k >= 0 && k <= 1)).toBe(true);
    const more: number[] = [];
    const stop = tween(100, (k) => more.push(k));
    stop();
    vi.advanceTimersByTime(500);
    expect(more).toEqual([]);
  });
  it("follows the reduced-motion preference live", () => {
    let listener: (() => void) | null = null;
    const mq = {
      matches: false,
      addEventListener: (_: string, l: () => void) => { listener = l; },
      removeEventListener: () => {},
    };
    vi.stubGlobal("matchMedia", () => mq);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    mq.matches = true;
    act(() => listener?.());
    expect(result.current).toBe(true);
  });
  it("reads as no preference where matchMedia is missing", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });
});
