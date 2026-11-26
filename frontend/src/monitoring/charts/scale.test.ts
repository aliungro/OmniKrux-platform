import { describe, expect, it } from "vitest";
import { formatTimeTick, formatTooltipTime, niceTicks, timeTicks } from "./scale";

describe("niceTicks", () => {
  it("rounds to steps people read", () => {
    expect(niceTicks(0, 0.93, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(3, 97, 5)).toEqual([0, 20, 40, 60, 80, 100]);
  });
  it("gives a flat range some height", () => {
    const t = niceTicks(5, 5, 5);
    expect(t[0]).toBeLessThanOrEqual(5);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(5);
    expect(t.length).toBeGreaterThan(1);
  });
});

describe("niceTicks on awkward ranges", () => {
  const sane = (t: number[]) => {
    expect(t.length).toBeGreaterThanOrEqual(2);
    expect(t.every(Number.isFinite)).toBe(true);
    expect(t[t.length - 1]).toBeGreaterThan(t[0]);
  };
  it("falls back to two ticks", () => {
    sane(niceTicks(0, 5e-324, 5));
    sane(niceTicks(5e-324, 5e-324, 5));
    expect(niceTicks(-1e308, 1e308, 5)).toEqual([-1e308, 1e308]);
    sane(niceTicks(0, Number.MAX_VALUE, 5));
    sane(niceTicks(Number.NaN, 1, 5));
  });
});

describe("timeTicks", () => {
  const start = Date.UTC(2026, 10, 19, 10, 2, 0) / 1000;
  it("aligns to a clock interval and stays inside the range", () => {
    const ticks = timeTicks(start, start + 3600, 6);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(7);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(start);
      expect(t).toBeLessThanOrEqual(start + 3600);
      expect(new Date(t * 1000).getMinutes() % 5).toBe(0);
    }
    expect([60, 300, 900, 1800]).toContain(ticks[1] - ticks[0]);
  });
  it("uses whole days for long ranges", () => {
    const ticks = timeTicks(start, start + 14 * 86400, 6);
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect((ticks[1] - ticks[0]) % 86400).toBe(0);
  });
});

describe("time labels", () => {
  const t = new Date(2026, 10, 19, 9, 5, 7).getTime() / 1000;
  it("changes with the range", () => {
    expect(formatTimeTick(t, 3600)).toBe("09:05");
    expect(formatTimeTick(t, 3 * 86400)).toBe("19 Nov 09:05");
    expect(formatTimeTick(t, 30 * 86400)).toBe("19 Nov");
  });
  it("the tooltip adds seconds", () => {
    expect(formatTooltipTime(t)).toBe("19 Nov 09:05:07");
  });
});

describe("axes people read", () => {
  const MIB = 1024 ** 2;
  it("byte ticks are round", () => {
    expect(niceTicks(0, 1000 * MIB, 5, "bytes")).toEqual([0, 256 * MIB, 512 * MIB, 768 * MIB, 1024 * MIB]);
    const t = niceTicks(0, 3 * 1024 ** 3, 5, "bytes");
    expect(t.slice(0, 3)).toEqual([0, 1024 ** 3, 2 * 1024 ** 3]);
    // Other units keep 1-2-5 steps.
    expect(niceTicks(0, 100, 5, "short")).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("there are at least three time labels across any range", () => {
    for (const range of [45, 90, 150, 400, 4000, 90000, 2 * 86400, 3 * 86400 + 5000, 9 * 86400, 400 * 86400]) {
      for (const count of [2, 3, 6]) {
        const start = 1_700_000_123;
        expect(timeTicks(start, start + range, count).length, `${range}s / ${count}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
