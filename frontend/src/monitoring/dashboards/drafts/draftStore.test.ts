import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { panel, spec } from "../../test/dashboardSeeds";
import { DRAFT_PREFIX, draftsWork, readDraft, removeDraft, writeDraft, type StoredDraft } from "./draftStore";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const stored = (over: Partial<StoredDraft> = {}): StoredDraft => ({
  v: 1, dashboardId: "d1", baseVersion: 3, savedAt: 1_700_000_000_000,
  draft: spec("API latency", [panel("p-1", "Requests", "up")]), jsonText: null, ...over,
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
