import { describe, expect, it } from "vitest";
import {
  alignRange,
  durationText,
  NICE_STEPS,
  parseTimeExpr,
  refreshMs,
  REFRESH_LABELS,
  resolveTime,
  stepFor,
  TIME_PRESETS,
  timeLabel,
  rangeWords,
  storedTime,
  LOCAL_TIME_COPY,
} from "./time";

describe("time", () => {
  it("steps aim at sixty points per column", () => {
    expect(stepFor(21600, 12)).toBe(30);
    expect(stepFor(3600, 24)).toBe(5);
    expect(stepFor(604800, 6)).toBe(1800);
    expect(alignRange(1000, 1095, 30)).toEqual({ start: 990, end: 1110 });
  });

  it("uses the binding step list", () => {
    expect(NICE_STEPS).toEqual([
      1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400,
    ]);
    expect(stepFor(2000, 24)).toBe(2);
    expect(stepFor(600000, 1)).toBe(21600);
  });

  it("steps stay inside the nice list, even for tiny or huge ranges", () => {
    expect(stepFor(1, 24)).toBe(NICE_STEPS[0]);
    expect(stepFor(1e12, 1)).toBe(NICE_STEPS[NICE_STEPS.length - 1]);
  });

  it("time expressions", () => {
    expect(parseTimeExpr("now-6h", 100000)).toBe(78400);
    expect(parseTimeExpr("now", 100000)).toBe(100000);
    expect(parseTimeExpr("2026-11-19T10:00:00Z", 0)).toBe(Date.UTC(2026, 10, 19, 10) / 1000);
    expect(parseTimeExpr("now-6x", 0)).toBeNull();
    expect(parseTimeExpr("2026-13-40T10:00:00Z", 0)).toBeNull();
    expect(parseTimeExpr("", 0)).toBeNull();
    expect(parseTimeExpr("now-" + "9".repeat(400) + "w", 0)).toBeNull();
    expect(parseTimeExpr("0050-01-01T00:00:00Z", 0)).toBe(-60589296000);
    expect(parseTimeExpr("0000-01-01T00:00:00Z", 0)).toBeNull();
    expect(timeLabel({ from: "now-6h", to: "now" })).toBe("Last 6 hours");
    expect(timeLabel({ from: "now-90m", to: "now-5m" })).toBe("now-90m to now-5m");
  });

  it("resolves a range and refuses a backwards one", () => {
    expect(resolveTime({ from: "now-1h", to: "now" }, 10000)).toEqual({
      start: 6400,
      end: 10000,
    });
    expect(resolveTime({ from: "now", to: "now-1h" }, 10000)).toBeNull();
    expect(resolveTime({ from: "now-1h", to: "2026-11-19T10:00:00Z" }, 2e9)).toBeNull();
    expect(resolveTime({ from: "bogus", to: "now" }, 10000)).toBeNull();
  });

  it("presets and refresh labels", () => {
    expect(TIME_PRESETS).toHaveLength(9);
    expect(TIME_PRESETS[0]).toEqual({
      from: "now-5m",
      label: "Last 5 minutes",
    });
    expect(TIME_PRESETS[8]).toEqual({ from: "now-7d", label: "Last 7 days" });
    expect(REFRESH_LABELS).toHaveLength(7);
    expect(refreshMs(null)).toBeNull();
    expect(refreshMs("10s")).toBe(10000);
    expect(refreshMs("1h")).toBe(3600000);
  });

  it("durations read compactly", () => {
    expect(durationText(30)).toBe("30s");
    expect(durationText(300)).toBe("5m");
    expect(durationText(7200)).toBe("2h");
    expect(durationText(90)).toBe("90s");
  });
});

describe("custom ranges in words", () => {
  const now = Math.floor(new Date(2026, 10, 25, 13, 0).getTime() / 1000);
  const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString().replace(/\.\d{3}Z$/, "Z");

  it("custom ranges read in local time", () => {
    expect(rangeWords({ from: "now-365d", to: "now" }, now)).toBe("Last 365 days");
    expect(rangeWords({ from: "now-1h", to: "now" }, now)).toBe("Last 1 hour");
    expect(rangeWords({ from: "now-90s", to: "now" }, now)).toBe("Last 90 seconds");
    expect(rangeWords({ from: local(2026, 11, 25, 10, 0), to: local(2026, 11, 25, 12, 0) }, now)).toBe("25 Nov 10:00 – 12:00");
    expect(rangeWords({ from: local(2026, 11, 24, 22, 0), to: local(2026, 11, 25, 2, 30) }, now)).toBe("24 Nov 22:00 – 25 Nov 02:30");
    expect(rangeWords({ from: local(2025, 3, 2, 9, 0), to: "now" }, now)).toBe("2 Mar 2025 09:00 – now");
  });

  it("local times are stored as UTC", () => {
    expect(storedTime("2026-11-25 10:00")).toBe(local(2026, 11, 25, 10, 0));
    expect(storedTime(" now-6h ")).toBe("now-6h");
    expect(storedTime("now")).toBe("now");
    expect(storedTime("2026-11-25T10:00:00Z")).toBe("2026-11-25T10:00:00Z");
    expect(storedTime("2026-13-25 10:00")).toBeNull();
    expect(storedTime("2026-02-30 10:00")).toBeNull();
    expect(storedTime("yesterday")).toBeNull();
    expect(LOCAL_TIME_COPY).toBe("Use now, now-6h, now-7d, or a local time like 2026-11-25 10:00.");
  });
});
