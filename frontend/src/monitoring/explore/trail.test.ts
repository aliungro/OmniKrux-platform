import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTrail, pushTrail, readTrail, TRAIL_MAX, TRAIL_PREFIX, TRAIL_SHOWN } from "./trail";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("trail", () => {
  it("the trail keeps twenty, moves repeats to the end and survives blocked storage", () => {
    expect(TRAIL_MAX).toBe(20);
    expect(TRAIL_SHOWN).toBe(8);
    expect(TRAIL_PREFIX).toBe("omnikrux.monitoring.explore.trail.");
    for (let i = 0; i < 25; i++) pushTrail("p1", { expr: `q${i}`, sourceId: "s1", at: i });
    let trail = readTrail("p1");
    expect(trail).toHaveLength(20);
    expect(trail[0].expr).toBe("q5");
    expect(trail[19].expr).toBe("q24");

    // A repeat (same text and source) moves to the end; the same text on another source is its own entry.
    trail = pushTrail("p1", { expr: "q10", sourceId: "s1", at: 100 });
    expect(trail).toHaveLength(20);
    expect(trail.filter((e) => e.expr === "q10")).toHaveLength(1);
    expect(trail[19]).toEqual({ expr: "q10", sourceId: "s1", at: 100 });
    trail = pushTrail("p1", { expr: "q10", sourceId: "s2", at: 101 });
    expect(trail.filter((e) => e.expr === "q10").map((e) => e.sourceId)).toEqual(["s1", "s2"]);
    expect(readTrail("p1")).toEqual(trail);

    // Each project has its own trail.
    expect(readTrail("p2")).toEqual([]);

    // Damaged storage reads as nothing; entries that aren't entries are dropped.
    localStorage.setItem(`${TRAIL_PREFIX}p3`, "{not json");
    expect(readTrail("p3")).toEqual([]);
    localStorage.setItem(`${TRAIL_PREFIX}p4`, JSON.stringify([{ expr: "up", sourceId: "s1", at: 1 }, { expr: 3 }, null, "x"]));
    expect(readTrail("p4")).toEqual([{ expr: "up", sourceId: "s1", at: 1 }]);

    clearTrail("p1");
    expect(readTrail("p1")).toEqual([]);

    // Blocked storage: nothing throws, and a push still answers with the entry.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    expect(readTrail("p1")).toEqual([]);
    expect(pushTrail("p1", { expr: "up", sourceId: "s1", at: 5 })).toEqual([{ expr: "up", sourceId: "s1", at: 5 }]);
    expect(() => clearTrail("p1")).not.toThrow();
  });
});
