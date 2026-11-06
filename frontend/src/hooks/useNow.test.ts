// frontend/src/hooks/useNow.test.ts
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNow } from "./useNow";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T23:59:30"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useNow", () => {
  it("refreshes the current time on each interval", () => {
    const { result, unmount } = renderHook(() => useNow(60_000));
    expect(result.current.toISOString()).toBe(new Date("2026-11-06T23:59:30").toISOString());
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.getDate()).toBe(7);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
