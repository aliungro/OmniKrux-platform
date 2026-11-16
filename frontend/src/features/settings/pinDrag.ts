/** A pinned row's place in the list, captured when a drag lifts it. `top` is relative to the list's top. */
export interface Slot {
  key: string;
  top: number;
  height: number;
}

/**
 * Where the lifted row lands: its index in the new order. That is the number of other rows whose
 * midpoint lies above `y`, the lifted row's top in list coordinates, with the other rows measured
 * as they sit once the source is taken out (rows below it close up by its height). So the gap moves
 * one row as soon as the lifted row is half a row past a neighbour, up or down alike.
 */
export function landingIndex(slots: readonly Slot[], from: number, y: number): number {
  const size = slots[from]?.height ?? 0;
  let index = 0;
  slots.forEach((slot, i) => {
    if (i === from) return;
    const middle = slot.top + slot.height / 2 - (i > from ? size : 0);
    if (middle < y) index += 1;
  });
  return index;
}

/** How far row `i` slides so the gap opens at `to`: rows between the source and the gap close up toward it. */
export function shiftOf(i: number, from: number, to: number, size: number): number {
  if (from < i && i <= to) return -size;
  if (to <= i && i < from) return size;
  return 0;
}

/** The `reorder(key, target, placement)` call that puts `source` at index `to`, or null when it stays put. */
export function dropFor(
  pinned: readonly string[], source: string, to: number,
): { key: string; placement: "before" | "after" } | null {
  const from = pinned.indexOf(source);
  if (from < 0 || to === from) return null;
  const others = pinned.filter(key => key !== source);
  if (to <= 0) return { key: others[0], placement: "before" };
  const target = others[Math.min(to, others.length) - 1];
  return target === undefined ? null : { key: target, placement: "after" };
}
