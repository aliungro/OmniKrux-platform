import { describe, expect, it } from "vitest";
import { SERIES_COLORS, seriesColor, thresholdColor } from "./colors";

describe("series colours", () => {
  it("are stable and never rose", () => {
    expect(seriesColor("a|up|job=x")).toBe(seriesColor("a|up|job=x"));
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const c = seriesColor(`series-${i}`);
      expect(SERIES_COLORS).toContain(c);
      expect(c).not.toBe("--bad");
      seen.add(c);
    }
    expect(seen.size).toBe(SERIES_COLORS.length);
  });
  it("come from the Territories tokens", () => {
    expect(SERIES_COLORS).toEqual(["--focus", "--kind", "--ok", "--warn", "--eks", "--aks", "--gke", "--onprem"]);
  });
});

describe("thresholdColor", () => {
  const th = [{ value: 70, color: "warn" as const }, { value: 90, color: "bad" as const }];
  it("takes the highest threshold at or below the value", () => {
    expect(thresholdColor(50, th)).toBeNull();
    expect(thresholdColor(70, th)).toBe("warn");
    expect(thresholdColor(89.9, th)).toBe("warn");
    expect(thresholdColor(90, th)).toBe("bad");
    expect(thresholdColor(5, [])).toBeNull();
  });
  it("does not depend on the order given", () => {
    expect(thresholdColor(95, [...th].reverse())).toBe("bad");
  });
});
