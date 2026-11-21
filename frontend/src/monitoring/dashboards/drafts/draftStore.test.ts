import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panel, spec } from "../../test/dashboardSeeds";
import { DRAFT_PREFIX, draftsWork, readDraft, removeDraft, writeDraft, type StoredDraft } from "./draftStore";
import { settle, type DraftClaim } from "./useDraft";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const stored = (over: Partial<StoredDraft> = {}): StoredDraft => ({
  v: 1, dashboardId: "d1", baseVersion: 3, savedAt: 1_700_000_000_000,
  draft: spec("API latency", [panel("p-1", "Requests", "up")]), jsonText: null, writer: "w1", ...over,
});

describe("draft store", () => {
  it("drafts round-trip under the omnikrux key", () => {
    expect(DRAFT_PREFIX).toBe("omnikrux.monitoring.draft.");
    const d = stored({ jsonText: "{ not json" });
    expect(writeDraft(d)).toBe(true);
    expect(localStorage.getItem("omnikrux.monitoring.draft.d1")).not.toBeNull();
    expect(readDraft("d1")).toEqual(d);
    expect(readDraft("d2")).toBeNull();
    removeDraft("d1");
    expect(localStorage.getItem("omnikrux.monitoring.draft.d1")).toBeNull();
    expect(readDraft("d1")).toBeNull();
    // The probe leaves nothing behind.
    expect(draftsWork()).toBe(true);
    expect(localStorage.length).toBe(0);
  });

  it("blocked storage writes nothing and says so", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    expect(() => writeDraft(stored())).not.toThrow();
    expect(writeDraft(stored())).toBe(false);
    expect(draftsWork()).toBe(false);
    expect(localStorage.length).toBe(0);
    // Reading and removing are caught too.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    expect(readDraft("d1")).toBeNull();
    expect(() => removeDraft("d1")).not.toThrow();
  });

  it("a session removes only a draft it wrote; one without a writer is nobody's", () => {
    writeDraft(stored());
    removeDraft("d1", "w2");
    expect(readDraft("d1")?.writer).toBe("w1");
    removeDraft("d1", "w1");
    expect(readDraft("d1")).toBeNull();
    const { writer: _, ...old } = stored();
    localStorage.setItem("omnikrux.monitoring.draft.d1", JSON.stringify(old));
    expect(readDraft("d1")?.writer).toBe("");
    removeDraft("d1", "w1");
    expect(readDraft("d1")).not.toBeNull();
    // Without a writer (Discard draft on the offer), it goes.
    removeDraft("d1");
    expect(readDraft("d1")).toBeNull();
  });

  it("three windows settle on the newest draft without a write loop", () => {
    // Each window's session, the one stored entry, and storage events delivered one at a time.
    const windows: Record<string, DraftClaim> = {
      a: { writer: "a", changedAt: 10, lost: false },
      b: { writer: "b", changedAt: 20, lost: false },
      c: { writer: "c", changedAt: 30, lost: false },
    };
    let entry: { writer: string; savedAt: number } | null = null;
    let writes = 0;
    const queue: string[] = [];
    const write = (w: string) => {
      entry = { writer: w, savedAt: windows[w].changedAt };
      windows[w].lost = false;
      writes++;
      queue.push(...Object.keys(windows).filter((x) => x !== w));
    };
    const settleAll = () => {
      for (let steps = 0; queue.length > 0; steps++) {
        if (steps > 100) throw new Error("no end");
        const w = queue.shift()!;
        const how = settle(windows[w], entry);
        if (how === "write") write(w);
        else if (how === "yield") windows[w].lost = true;
      }
    };
    // Stale handlers: the newest writes first, then two older ones each write before seeing it.
    write("c");
    write("a");
    write("b");
    settleAll();
    expect(entry).toEqual({ writer: "c", savedAt: 30 });
    expect(writes).toBeLessThanOrEqual(6);
    expect(windows.a.lost && windows.b.lost).toBe(true);
    // Lost windows stay quiet on later events...
    const before = writes;
    queue.push("a", "b", "a", "b");
    settleAll();
    expect(writes).toBe(before);
    // ...until their user changes something: that change is the newest and wins once.
    windows.a.changedAt = 40;
    windows.a.lost = false;
    write("a");
    settleAll();
    expect(entry).toEqual({ writer: "a", savedAt: 40 });
    expect(writes).toBe(before + 1);
    // An equally new draft from elsewhere: the stored one stays.
    expect(settle({ writer: "z", changedAt: 40, lost: false }, entry)).toBe("yield");
    // A removed entry is written again, even by a session that lost (it overwrites no one).
    expect(settle({ writer: "b", changedAt: 20, lost: true }, null)).toBe("write");
  });

  it("a malformed draft is dropped", () => {
    const k = "omnikrux.monitoring.draft.d1";
    for (const bad of [
      "{ not json",
      JSON.stringify({ ...stored(), v: 2 }),
      JSON.stringify({ ...stored(), dashboardId: "d9" }),
      JSON.stringify({ ...stored(), baseVersion: "3" }),
      JSON.stringify({ ...stored(), draft: { ...stored().draft, panels: [{ id: "p-1" }] } }),
      JSON.stringify({ ...stored(), jsonText: 7 }),
    ]) {
      localStorage.setItem(k, bad);
      expect(readDraft("d1")).toBeNull();
      expect(localStorage.getItem(k)).toBeNull();
    }
  });
});
