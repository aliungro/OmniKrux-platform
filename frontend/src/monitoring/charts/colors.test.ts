import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SERIES_COLORS, seriesColors, thresholdColor } from "./colors";

const s = (key: string, labels: Record<string, string>, queryRef = "A", projectName: string | null = null) => ({ key, labels, queryRef, projectName });

describe("series colours", () => {
  it("come from the Territories tokens, never the Good, Warning or Bad ones", () => {
    expect(SERIES_COLORS).toEqual(["--focus", "--eks", "--gke", "--aks", "--series-5", "--kind", "--series-7", "--series-8"]);
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

// OKLab distance (x100) between two sRGB hex colours.
const lab = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const delta = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i])) * 100;

describe("the palette", () => {
  it("the first eight colours are told apart", () => {
    const css = readFileSync(resolve(process.cwd(), "src/design/tokens.css"), "utf8");
    const hex = SERIES_COLORS.map((token) => new RegExp(`${token}:\\s*(#[0-9A-Fa-f]{6})`).exec(css)?.[1] as string);
    expect(hex.every(Boolean)).toBe(true);
    // The validator's floor: neighbours (the ones a legend puts side by side) 15 apart in OKLab x100,
    // and no two of the eight, neighbours or not, under 8.
    for (let i = 0; i < hex.length; i++) {
      if (i > 0) expect(delta(hex[i - 1], hex[i]), `${SERIES_COLORS[i - 1]} / ${SERIES_COLORS[i]}`).toBeGreaterThan(15);
      for (let j = i + 1; j < hex.length; j++) expect(delta(hex[i], hex[j]), `${SERIES_COLORS[i]} / ${SERIES_COLORS[j]}`).toBeGreaterThan(8);
    }
    // The provider colour Kubernetes badges use is untouched.
    expect(css).toMatch(/--onprem:\s*#A3A0B8/i);
  });
});
