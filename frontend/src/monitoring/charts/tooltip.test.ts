import { describe, expect, it } from "vitest";
import { placeTip, TIP_ROWS, tipRows } from "./tooltip";

const box = (left: number, top: number, width = 400, height = 200) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const VIEW = { width: 1000, height: 800 };
const TIP = { width: 200, height: 150 };

describe("tipRows", () => {
  it("tooltip caps at ten rows and counts the rest", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ key: `s${i}`, value: i }));
    const { shown, more } = tipRows(rows);
    expect(TIP_ROWS).toBe(10);
    expect(shown).toHaveLength(10);
    expect(more).toBe(30);
    // Ten rows or fewer: nothing is counted.
    expect(tipRows(rows.slice(0, 10))).toEqual({ shown: [...rows.slice(0, 10)].reverse(), more: 0 });
    expect(tipRows([])).toEqual({ shown: [], more: 0 });
  });

  it("tooltip rows are sorted by value with nulls last", () => {
    const rows = [
      { key: "a", value: null },
      { key: "b", value: 2 },
      { key: "c", value: -1 },
      { key: "d", value: 5 },
      { key: "e", value: null },
      { key: "f", value: 2 },
    ];
    const { shown, more } = tipRows(rows);
    expect(shown.map((r) => r.key)).toEqual(["d", "b", "f", "c", "a", "e"]);
    expect(more).toBe(0);
    // The input is left as it was.
    expect(rows.map((r) => r.key)).toEqual(["a", "b", "c", "d", "e", "f"]);
    // All values null at the cursor: every row is still listed, in its own order.
    expect(tipRows([{ key: "x", value: null }, { key: "y", value: null }]).shown.map((r) => r.key)).toEqual(["x", "y"]);
  });
});

describe("placeTip", () => {
  it("tooltip stays inside the viewport", () => {
    // Room on the right: right of the crosshair, at the anchor's height.
    expect(placeTip({ x: 100, y: 10 }, TIP, box(50, 100), VIEW)).toEqual({ left: 112, top: 10 });
    // Right edge: the tip would leave the viewport, so it goes left of the crosshair.
    const right = placeTip({ x: 380, y: 10 }, TIP, box(600, 100), VIEW);
    expect(right.left).toBe(380 - 12 - 200);
    expect(600 + right.left + TIP.width).toBeLessThanOrEqual(VIEW.width - 8);
    // Left edge: no room on either side, so it is pushed inside with an 8 px margin.
    const narrow = { width: 300, height: 800 };
    const left = placeTip({ x: 150, y: 10 }, { width: 260, height: 100 }, box(0, 0, 300), narrow);
    expect(left.left).toBeGreaterThanOrEqual(8);
    expect(left.left + 260).toBeLessThanOrEqual(narrow.width - 8);
    // A box scrolled past the left edge still keeps the tip on screen.
    const past = placeTip({ x: 20, y: 10 }, TIP, box(-100, 100), VIEW);
    expect(-100 + past.left).toBeGreaterThanOrEqual(8);
    // Bottom edge: moved up so its bottom sits 8 px above the viewport's bottom.
    const low = placeTip({ x: 100, y: 150 }, TIP, box(50, 600), VIEW);
    expect(600 + low.top + TIP.height).toBe(VIEW.height - 8);
    // Top edge: a box scrolled above the viewport keeps the tip 8 px below its top.
    expect(placeTip({ x: 100, y: 10 }, TIP, box(50, -300), VIEW).top).toBe(308);
    // A tip taller than the viewport starts 8 px from the top.
    expect(placeTip({ x: 100, y: 40 }, { width: 200, height: 2600 }, box(0, 0), VIEW).top).toBe(8);
  });
});
