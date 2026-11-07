// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { LogLine } from "../../api/types";
import { LOG_CAPACITY, LogBuffer } from "./logBuffer";

const line = (i: number): LogLine => ({ pod: "p", container: "c", ts: null, text: `line ${i}` });
const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => line(from + k));
const text = (buf: LogBuffer, i: number) => {
  const it = buf.get(i);
  return it && "text" in it ? it.text : undefined;
};

describe("LogBuffer", () => {
  it("ring buffer keeps last 50000 and counts dropped", () => {
    expect(LOG_CAPACITY).toBe(50_000);
    const buf = new LogBuffer();
    const v0 = buf.version;
    for (let from = 0; from < 60_000; from += 500) buf.push(lines(from, from + 500));
    expect(buf.length).toBe(50_000);
    expect(text(buf, 0)).toBe("line 10000");
    expect(text(buf, 49_999)).toBe("line 59999");
    expect(buf.get(50_000)).toBeUndefined();
    expect(buf.dropped).toBe(10_000);
    expect(buf.evicted).toBe(10_000);
    expect(buf.version).toBeGreaterThan(v0);

    // Sequence numbers run on across evictions, one per item.
    expect(buf.get(0)!.seq).toBe(10_000);
    expect(buf.get(49_999)!.seq).toBe(59_999);

    // The server's own drops add to the count, but not to what the cap evicted.
    const v1 = buf.version;
    buf.addDropped(7);
    expect(buf.dropped).toBe(10_007);
    expect(buf.evicted).toBe(10_000);
    expect(buf.version).toBe(v1 + 1);
  });

  it("keeps markers in order with lines and clears back to empty", () => {
    const buf = new LogBuffer(3);
    buf.push([line(0), { marker: "Container restarted at 14:08:24, restart 14" }, line(1), line(2)]);
    expect(buf.length).toBe(3);
    expect(buf.get(0)).toEqual({ seq: 1, marker: "Container restarted at 14:08:24, restart 14" });
    expect(text(buf, 2)).toBe("line 2");

    const v = buf.version;
    buf.push([]);
    expect(buf.version).toBe(v);

    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.dropped).toBe(0);
    expect(buf.evicted).toBe(0);
    expect(buf.version).toBe(v + 1);
    buf.push([line(3)]);
    expect(buf.get(0)!.seq).toBe(4);
  });
});
