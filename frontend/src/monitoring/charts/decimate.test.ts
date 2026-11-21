import { describe, expect, it } from "vitest";
import { decimate } from "./decimate";

type P = [number, number | null];
const make = (n: number): P[] => Array.from({ length: n }, (_, i) => [i, Math.sin(i / 50)] as P);

describe("decimate", () => {
  it("keeps extremes and stays within four points per column", () => {
    const pts = Array.from({ length: 50000 }, (_, i) => [i, Math.sin(i / 50) + (i === 31337 ? 9 : 0)] as P);
    const out = decimate(pts, 0, 50000, 800);
    expect(out.length).toBeLessThanOrEqual(3200);
    expect(Math.max(...out.map((p) => p[1]!))).toBeCloseTo(Math.sin(31337 / 50) + 9);
  });

  it("keeps points in time order", () => {
    const out = decimate(make(5000), 0, 5000, 100);
    for (let i = 1; i < out.length; i++) expect(out[i][0]).toBeGreaterThan(out[i - 1][0]);
  });

  it("returns short series untouched", () => {
    const pts: P[] = [[0, 1], [10, 2], [20, 3]];
    expect(decimate(pts, 0, 20, 100)).toEqual(pts);
  });

  it("keeps at most two points when first and last are the extremes", () => {
    const pts: P[] = [[0, 1], [1, 2], [2, 3], [3, 4]];
    expect(decimate(pts, 0, 4, 1)).toEqual([[0, 1], [3, 4]]);
  });

  it("gaps stay gaps", () => {
    const pts: P[] = [];
    for (let i = 0; i < 2000; i++) pts.push([i, i === 1000 ? null : i]);
    const out = decimate(pts, 0, 2000, 50);
    expect(out.filter((p) => p[1] === null)).toEqual([[1000, null]]);
    const at = out.findIndex((p) => p[1] === null);
    expect(out[at - 1][0]).toBeLessThan(1000);
    expect(out[at + 1][0]).toBeGreaterThan(1000);
  });

  it("decimating 200 000 points stays under the frame budget", () => {
    const t0 = performance.now();
    for (let s = 0; s < 20; s++) decimate(make(10000), 0, 10000, 1200);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it("collapses a run of nulls into one gap marker", () => {
    const pts: P[] = [[0, 1], [1, 2], [2, null], [3, null], [4, null], [5, 3], [6, 4]];
    expect(decimate(pts, 0, 10, 100).filter((p) => p[1] === null)).toEqual([[2, null]]);
  });

  it("ignores NaN when picking extremes", () => {
    const pts: P[] = [[0, Number.NaN], [1, 5], [2, 1], [3, 9], [4, 2]];
    const out = decimate(pts, 0, 5, 1);
    expect(out.map((p) => p[1])).toEqual([5, 1, 9, 2].filter((v) => out.some((p) => p[1] === v)));
    expect(out.some((p) => Number.isNaN(p[1]))).toBe(false);
    expect(Math.max(...out.map((p) => p[1]!))).toBe(9);
    expect(Math.min(...out.map((p) => p[1]!))).toBe(1);
  });

  it("filters points outside the range even for one or two points", () => {
    expect(decimate([[-5, 1], [3, 2]], 0, 10, 10)).toEqual([[3, 2]]);
    expect(decimate([[50, 1]], 0, 10, 10)).toEqual([]);
  });
});
