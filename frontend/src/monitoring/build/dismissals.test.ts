import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISMISSED_KEY, dismiss, readDismissed } from "./dismissals";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("dismissals", () => {
  it("dismissals survive in storage under the omnikrux key and blocked storage keeps them in memory", () => {
    dismiss("dash1", "perSecond:p1:A");
    expect(DISMISSED_KEY).toBe("omnikrux.monitoring.recommendations.dismissed");
    expect(JSON.parse(localStorage.getItem(DISMISSED_KEY)!)).toContain("dash1|perSecond:p1:A");
    expect(readDismissed("dash1").has("perSecond:p1:A")).toBe(true);
    expect(readDismissed("dash2").size).toBe(0);

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => dismiss("blocked-scope", "k")).not.toThrow();
    expect(readDismissed("blocked-scope").has("k")).toBe(true);
  });

  it("keeps at most 500, dropping the oldest, and ignores damaged storage", () => {
    for (let i = 0; i < 505; i++) dismiss("s", `k${i}`);
    const stored = JSON.parse(localStorage.getItem(DISMISSED_KEY)!) as string[];
    expect(stored).toHaveLength(500);
    expect(readDismissed("s").has("k0")).toBe(false);
    expect(readDismissed("s").has("k504")).toBe(true);
    localStorage.setItem(DISMISSED_KEY, "{nope");
    expect(() => readDismissed("s")).not.toThrow();
  });
});
