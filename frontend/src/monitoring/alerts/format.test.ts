import { describe, expect, it } from "vitest";
import type { DryRunOut } from "./api";
import {
  STATE_LABEL, dryRunSentence, durationWords, seriesWord, sentence, sinceShort, stateTone, whereLabel,
} from "./format";

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;

const dry = (over: Partial<DryRunOut>): DryRunOut => ({
  start: 0, end: 0, step: 60, fired: 0, firing_now: false, periods: [], projects: [], candidates: [], took_ms: 1, ...over,
});

describe("alert words", () => {
  it("sentence reads like the prototype", () => {
    expect(sentence({ of: "each", op: "above", threshold: 0.3, for: "5m" }, { seriesWord: "route", unit: "s" })).toBe(
      "Alert when any route is above 0.3 s for 5 min",
    );
    expect(sentence({ of: "total", op: "below", threshold: 2, for: "1h" }, { seriesWord: "route", unit: "none" })).toBe(
      "Alert when the total is below 2 for 1 h",
    );
    expect(sentence({ of: "each", op: "above", threshold: 80, for: "0s" }, { seriesWord: "series", unit: "percent" })).toBe(
      "Alert when any series is above 80% right away",
    );
    expect(sentence({ of: "each", op: "above", threshold: 5, for: "30s" }, { seriesWord: "pod", unit: "reqps" })).toBe(
      "Alert when any pod is above 5 req/s for 30 s",
    );
  });

  it("names the series by the legend's first label", () => {
    expect(seriesWord("{{route}} {{code}}")).toBe("route");
    expect(seriesWord("total")).toBe("series");
    expect(seriesWord("")).toBe("series");
  });

  it("durations in words", () => {
    expect(durationWords(45)).toBe("45 s");
    expect(durationWords(12 * 60)).toBe("12 min");
    expect(durationWords(3 * 3600 + 5 * 60)).toBe("3 h 5 min");
    expect(durationWords(2 * 86400)).toBe("2 d");
    expect(durationWords(0)).toBe("0 s");
    expect(durationWords(90)).toBe("1 min 30 s");
  });

  it("short ages for a list", () => {
    expect([45, 12 * 60, 3 * 3600 + 50, 2 * 86400, 0].map(sinceShort)).toEqual(["45s", "12m", "3h", "2d", "0s"]);
  });

  it("states have words and tones", () => {
    expect(STATE_LABEL).toEqual({
      ok: "OK", pending: "Pending", firing: "Firing", no_data: "No data", unreachable: "Can't check", error: "Query error",
      paused: "Paused", waiting: "Loading", not_applied: "Not applied",
    });
    expect(stateTone("firing")).toBe("bad");
    expect(stateTone("ok")).toBe("ok");
    expect(stateTone("pending")).toBe("warn");
    expect(stateTone("paused")).toBe("muted");
  });

  it("says where a rule runs", () => {
    expect(whereLabel({ engine: "omnikrux", tool: null })).toBe("checked by OmniKrux");
    expect(whereLabel({ engine: "tool", tool: "prometheus_rule" })).toBe("in Prometheus");
    expect(whereLabel({ engine: "tool", tool: "loki_ruler" })).toBe("in Loki");
  });

  it("dry run sentence", () => {
    const now = at(2026, 3, 10, 9, 0);
    const yesterday = at(2026, 3, 9, 18, 42);
    expect(dryRunSentence(dry({ fired: 1, periods: [{ start: yesterday, end: yesterday + 540, ongoing: false }] }), now)).toBe(
      "Over the last 6 hours this would have fired once (yesterday 18:42, 9 min).",
    );
    expect(dryRunSentence(dry({}), now)).toBe("Over the last 6 hours this would not have fired.");
    const today = at(2026, 3, 10, 7, 5);
    const older = at(2026, 3, 1, 23, 0);
    expect(
      dryRunSentence(
        dry({ fired: 3, firing_now: true, periods: [{ start: older, end: older + 60, ongoing: false }, { start: today, end: today + 600, ongoing: true }] }),
        now,
        "24 hours",
      ),
    ).toBe("Over the last 24 hours this would have fired 3 times (last 07:05, still going). It is firing now.");
    expect(dryRunSentence(dry({ fired: 2, periods: [{ start: older, end: older + 3 * 3600, ongoing: false }] }), now)).toBe(
      "Over the last 6 hours this would have fired 2 times (last 1 Mar 23:00, 3 h).",
    );
  });
});
