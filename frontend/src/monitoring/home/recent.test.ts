import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECENT_KEY, readRecent, recordRecent } from "./recent";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("recent", () => {
  it("recent keeps eight newest without duplicates", () => {
    for (let i = 0; i < 10; i++) recordRecent({ kind: "project", id: `p${i}` }, 1000 + i);
    recordRecent({ kind: "project", id: "p5" }, 2000);
    recordRecent({ kind: "group", id: "p5" }, 2001);
    const items = readRecent();
    expect(items).toHaveLength(8);
    expect(items[0]).toEqual({ kind: "group", id: "p5", at: 2001 });
    expect(items[1]).toEqual({ kind: "project", id: "p5", at: 2000 });
    expect(items.filter((i) => i.kind === "project" && i.id === "p5")).toHaveLength(1);
    expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort((a, b) => b - a));
  });

  it("recent survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readRecent()).toEqual([]);
    expect(() => recordRecent({ kind: "project", id: "p1" })).not.toThrow();
  });

  it("ignores damaged storage", () => {
    localStorage.setItem(RECENT_KEY, "{not json");
    expect(readRecent()).toEqual([]);
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ kind: "nope", id: 1 }, { kind: "project", id: "ok", at: 5 }]));
    expect(readRecent()).toEqual([{ kind: "project", id: "ok", at: 5 }]);
  });
});
