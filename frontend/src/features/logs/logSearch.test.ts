// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LogBuffer } from "./logBuffer";
import { searchLines, splitMatches, stepMatch } from "./logSearch";

function buffer(texts: (string | { marker: string })[], capacity?: number) {
  const buf = new LogBuffer(capacity);
  buf.push(texts.map((t) => (typeof t === "string" ? { pod: "p", container: "c", ts: null, text: t } : t)));
  return buf;
}

describe("log search", () => {
  it("search finds matches and wraps next/prev", () => {
    const buf = buffer([
      "Starting payments-api",
      "java.lang.OutOfMemoryError: Java heap space",
      { marker: "Container restarted after OutOfMemory" },
      "outofmemory again, lower case",
      "Shutdown hook",
      "OutOfMemoryError: heap",
    ]);
    // Matched on text only: the marker never matches.
    expect(searchLines(buf, "OutOfMemory", { caseSensitive: false })).toEqual([1, 3, 5]);
    expect(searchLines(buf, "OutOfMemory", { caseSensitive: true })).toEqual([1, 5]);
    expect(searchLines(buf, "", { caseSensitive: false })).toEqual([]);
    expect(searchLines(buf, "nothing like this", { caseSensitive: false })).toEqual([]);
    // Regex characters are plain text.
    expect(searchLines(buffer(["a.b", "axb", "(x)"]), ".", { caseSensitive: false })).toEqual([0]);
    expect(searchLines(buffer(["a.b", "axb", "(x)"]), "(x", { caseSensitive: false })).toEqual([2]);
    // From an index, for the lines that arrived since the last search.
    expect(searchLines(buf, "OutOfMemory", { caseSensitive: false }, 2)).toEqual([3, 5]);

    const matches = [1, 3, 5];
    // Next: the first match after the position, wrapping to the first.
    expect(stepMatch(matches, 1, 1)).toBe(1);
    expect(stepMatch(matches, 3, 1)).toBe(2);
    expect(stepMatch(matches, 5, 1)).toBe(0);
    expect(stepMatch(matches, -1, 1)).toBe(0);
    // Previous: the last match before the position, wrapping to the last.
    expect(stepMatch(matches, 5, -1)).toBe(1);
    expect(stepMatch(matches, 1, -1)).toBe(2);
    expect(stepMatch(matches, 4, -1)).toBe(1);
    expect(stepMatch(matches, 99, -1)).toBe(2);
    expect(stepMatch([], 0, 1)).toBe(-1);
  });

  it("splits a line into plain and matched parts", () => {
    expect(splitMatches("OOM then oom", "oom", false)).toEqual(["", "OOM", " then ", "oom", ""]);
    expect(splitMatches("OOM then oom", "oom", true)).toEqual(["OOM then ", "oom", ""]);
    expect(splitMatches("no hit", "x", false)).toEqual(["no hit"]);
  });
});
