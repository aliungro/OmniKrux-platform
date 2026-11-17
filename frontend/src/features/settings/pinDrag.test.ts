import { expect, it } from "vitest";
import { dropFor, landingIndex, shiftOf, type Slot } from "./pinDrag";

const slots: Slot[] = ["a", "b", "c", "d"].map((key, i) => ({ key, top: i * 40, height: 40 }));

it("landing index counts midpoints above the pointer", () => {
  expect(landingIndex(slots, 0, 95)).toBe(2);
  expect(landingIndex(slots, 0, 5)).toBe(0);
  expect(landingIndex(slots, 3, 115)).toBe(3);
  expect(landingIndex(slots, 3, 40)).toBe(1);
  expect(landingIndex(slots, 3, -20)).toBe(0);
});

it("shift opens the gap between source and destination", () => {
  expect([1, 2, 3].map(i => shiftOf(i, 0, 2, 40))).toEqual([-40, -40, 0]);
  expect([0, 1, 2].map(i => shiftOf(i, 3, 1, 40))).toEqual([0, 40, 40]);
  expect([0, 2, 3].map(i => shiftOf(i, 1, 1, 40))).toEqual([0, 0, 0]);
});

it("dropFor converts an index into before or after", () => {
  const pinned = ["a", "b", "c", "d"];
  expect(dropFor(pinned, "a", 2)).toEqual({ key: "c", placement: "after" });
  expect(dropFor(pinned, "d", 0)).toEqual({ key: "a", placement: "before" });
  expect(dropFor(pinned, "b", 1)).toBeNull();
  expect(dropFor(pinned, "gone", 1)).toBeNull();
});
