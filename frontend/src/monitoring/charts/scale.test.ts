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
