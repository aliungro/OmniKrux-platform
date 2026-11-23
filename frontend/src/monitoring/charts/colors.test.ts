import { describe, expect, it } from "vitest";
import { SERIES_COLORS, seriesColors, thresholdColor } from "./colors";

const s = (key: string, labels: Record<string, string>, queryRef = "A", projectName: string | null = null) => ({ key, labels, queryRef, projectName });

describe("series colours", () => {
  it("come from the Territories tokens, never the Good, Warning or Bad ones", () => {
    expect(SERIES_COLORS).toEqual(["--focus", "--eks", "--gke", "--aks", "--onprem", "--kind", "--series-7", "--series-8"]);
    for (const status of ["--ok", "--warn", "--bad"]) expect(SERIES_COLORS).not.toContain(status);
    expect(new Set(SERIES_COLORS).size).toBe(SERIES_COLORS.length);
  });

  it("never repeat within a panel until all eight are used", () => {
    const five = Array.from({ length: 5 }, (_, i) => s(`k${i}`, { node: `n${i}` }));
    const colors = seriesColors(five);
    expect(new Set(colors.values()).size).toBe(5);
    // No series ever borrows the threshold colours.
    const eight = seriesColors(Array.from({ length: 8 }, (_, i) => s(`k${i}`, { node: `n${i}` })));
    for (const status of ["--ok", "--warn", "--bad"]) expect([...eight.values()]).not.toContain(status);
    const nine = seriesColors(Array.from({ length: 9 }, (_, i) => s(`k${i}`, { node: `n${i}` })));
    expect(new Set([...nine.values()].slice(0, 8)).size).toBe(8);
    expect([...nine.values()][8]).toBe(SERIES_COLORS[0]);
  });

  it("follow the panel's queries, then each one's labels, so the same series keep their colours", () => {
    const a = s("ka", { job: "api" });
    const b = s("kb", { job: "web" });
    const c = s("kc", { job: "api" }, "B");
    const first = seriesColors([a, b, c]);
    expect([first.get("ka"), first.get("kb"), first.get("kc")]).toEqual(["--focus", "--eks", "--gke"]);
    // A refresh where the source listed them in another order: the same colours.
    expect(seriesColors([b, a, c])).toEqual(first);
    // Label order inside a series doesn't matter either.
    expect(seriesColors([s("kb", { job: "web" }), s("ka", { job: "api" }), c])).toEqual(first);
  });

  it("on a group, each project's series follow their project", () => {
    const colors = seriesColors([s("p1", { job: "api" }, "A", "Shop"), s("p2", { job: "api" }, "A", "Blog")]);
    expect(colors.get("p1")).toBe("--focus");
    expect(colors.get("p2")).toBe("--eks");
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
