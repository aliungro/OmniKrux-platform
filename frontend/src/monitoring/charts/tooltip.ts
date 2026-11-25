// The time series tooltip's rows and place. With dozens of series the tooltip lists only the ten
// biggest values at the cursor and counts the rest, and it is placed so it never leaves the window.

/** The most rows the tooltip lists; the rest are counted ("and {n} more"). */
export const TIP_ROWS = 10;
/** The least room kept between the tooltip and the window's edges, in pixels. */
const MARGIN = 8;

/**
 * The rows to list: by value, biggest first, rows without a value last (each keeps its own order
 * among equals), the first `TIP_ROWS` of them; `more` counts the rest. The input is not changed.
 */
export function tipRows<R extends { value: number | null }>(rows: R[]): { shown: R[]; more: number } {
  const rank = (v: number | null) => (v === null || Number.isNaN(v) ? -Infinity : v);
  const sorted = rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const av = a.row.value === null || Number.isNaN(a.row.value);
      const bv = b.row.value === null || Number.isNaN(b.row.value);
      if (av !== bv) return av ? 1 : -1;
      return rank(b.row.value) - rank(a.row.value) || a.i - b.i;
    })
    .map((x) => x.row);
  return { shown: sorted.slice(0, TIP_ROWS), more: Math.max(0, sorted.length - TIP_ROWS) };
}

/**
 * Where the tooltip goes, relative to `box` (the element it is positioned in), for a crosshair at
 * `anchor` (also box-relative). It sits `gap` px right of the crosshair unless that would leave the
 * viewport, then left of it; if neither side has room it is pushed inside. Its top starts at the
 * anchor and is clamped so the tip stays in the viewport with 8 px margins; a tip taller than the
 * viewport starts 8 px from its top.
 */
export function placeTip(
  anchor: { x: number; y: number },
  tip: { width: number; height: number },
  box: DOMRect,
  viewport: { width: number; height: number },
  gap = 12,
): { left: number; top: number } {
  // The box-relative limits that keep the tip inside the viewport.
  const minLeft = MARGIN - box.left;
  const maxLeft = viewport.width - MARGIN - tip.width - box.left;
  const minTop = MARGIN - box.top;
  const maxTop = viewport.height - MARGIN - tip.height - box.top;

  const right = anchor.x + gap;
  const left = anchor.x - gap - tip.width;
  const fits = (x: number) => x >= minLeft && x <= maxLeft;
  let x: number;
  if (fits(right)) x = right;
  else if (fits(left)) x = left;
  else x = Math.max(minLeft, Math.min(right, maxLeft));

  const y = Math.max(minTop, Math.min(anchor.y, maxTop));
  return { left: x, top: y };
}
