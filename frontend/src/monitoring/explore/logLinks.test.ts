import { describe, expect, it } from "vitest";
import type { ChartLogLine } from "../dashboards/runPanel";
import { LINES_LIMIT, linkedLogSelector, lineTone, logMarks, windowLabel } from "./logLinks";

const line = (text: string, labels: Record<string, string> = {}, ts = "1700000000123000000"): ChartLogLine => ({
  key: text, ts, line: text, labels, projectName: null,
});

describe("logLinks", () => {
  it("linked selectors use only labels Loki has", () => {
    expect(linkedLogSelector({ namespace: "api", route: "/a" }, ["namespace", "app"])).toBe('{namespace="api"}');
    expect(linkedLogSelector({ route: "/a" }, ["namespace", "app"])).toBeNull();
    expect(linkedLogSelector({}, ["namespace"])).toBeNull();
    // Sorted, and values escaped by the writer.
    expect(linkedLogSelector({ namespace: 'a"b', app: "x\\y" }, ["namespace", "app"])).toBe('{app="x\\\\y",namespace="a\\"b"}');
    expect(LINES_LIMIT).toBe(1000);
  });

  it("tones come from labels, then words", () => {
    expect(lineTone(line("all good", { level: "warn" }))).toBe("warn");
    expect(lineTone(line("500 POST: upstream timeout ERROR"))).toBe("error");
    expect(lineTone(line("cache refresh done"))).toBe("info");
    // The label wins over the words.
    expect(lineTone(line("error budget report", { detected_level: "info" }))).toBe("info");
    expect(lineTone(line("x", { severity: "CRITICAL" }))).toBe("error");
    expect(lineTone(line("retrying: Warning, slow disk"))).toBe("warn");
    // A word inside another word is not a level.
    expect(lineTone(line("terrors and warnings-free"))).toBe("info");
  });

  it("marks carry each line's time in seconds and its tone", () => {
    expect(logMarks([line("fatal: out of memory"), line("ok")])).toEqual([
      { t: 1700000000.123, tone: "error" },
      { t: 1700000000.123, tone: "info" },
    ]);
  });

  it("window label reads like the prototype", () => {
    const at = (h: number, m: number) => new Date(2026, 10, 19, h, m, 0).getTime() / 1000;
    expect(windowLabel({ start: at(13, 41), end: at(13, 49) }, 14)).toBe("13:41:00 – 13:49:00 · 14 log lines");
    expect(windowLabel({ start: at(13, 41), end: at(13, 49) }, 1)).toBe("13:41:00 – 13:49:00 · 1 log line");
  });
});
