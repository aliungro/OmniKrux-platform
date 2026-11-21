// The panel grid: 24 columns, rows of any height. Pure functions over PanelSpec lists. A panel
// that did not move keeps its object identity, so callers can tell which panel an edit touched.

import { DEFAULT_SIZES, GRID_COLUMNS } from "./schema";
import type { DashboardSpec, Layout, PanelSpec } from "./schema";

const MIN_W = 2;
const MIN_H = 2;
const MAX_H = 40;

type Dir = "left" | "right" | "up" | "down";
type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
export type NewPanel = DistributiveOmit<PanelSpec, "layout"> & { layout?: Partial<Layout> };

export function overlaps(a: Layout, b: Layout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const same = (a: Layout, b: Layout) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

function withLayout(p: PanelSpec, layout: Layout): PanelSpec {
  return same(p.layout, layout) ? p : ({ ...p, layout } as PanelSpec);
}

/** Sort by y then x and float each panel up while nothing is in its way. */
export function compact(panels: PanelSpec[]): PanelSpec[] {
  const sorted = [...panels].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  const placed: PanelSpec[] = [];
  for (const p of sorted) {
    let y = p.layout.y;
    while (y > 0 && !placed.some((q) => overlaps({ ...p.layout, y: y - 1 }, q.layout))) y--;
    placed.push(withLayout(p, { ...p.layout, y }));
  }
  return placed;
}

function clamp(to: Layout): Layout {
  const w = Math.min(GRID_COLUMNS, Math.max(MIN_W, Math.round(to.w)));
  const h = Math.min(MAX_H, Math.max(MIN_H, Math.round(to.h)));
  const x = Math.min(GRID_COLUMNS - w, Math.max(0, Math.round(to.x)));
  const y = Math.max(0, Math.round(to.y));
  return { x, y, w, h };
}

/** Put a panel at `to` (clamped), push whatever it covers down below it, then compact. */
export function placePanel(panels: PanelSpec[], id: string, to: Layout): PanelSpec[] {
  const target = clamp(to);
  let list = panels.map((p) => (p.id === id ? withLayout(p, target) : p));
  const queue: string[] = [id];
  while (queue.length > 0) {
    const moverId = queue.shift();
    const mover = list.find((p) => p.id === moverId);
    if (!mover) continue;
    const below = mover.layout.y + mover.layout.h;
    const hit = list
      .filter((p) => p.id !== id && p.id !== mover.id && overlaps(mover.layout, p.layout))
      .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
    for (const h of hit) {
      list = list.map((p) => (p.id === h.id ? withLayout(p, { ...p.layout, y: below }) : p));
      queue.push(h.id);
    }
  }
  return compact(list);
}

export function nudge(panels: PanelSpec[], id: string, dir: Dir): PanelSpec[] {
  const p = panels.find((q) => q.id === id);
  if (!p) return panels;
  const l = p.layout;
  if (dir === "left") return l.x <= 0 ? panels : placePanel(panels, id, { ...l, x: l.x - 1 });
  if (dir === "right") {
    return l.x + l.w >= GRID_COLUMNS ? panels : placePanel(panels, id, { ...l, x: l.x + 1 });
  }
  if (dir === "up") return l.y <= 0 ? panels : placePanel(panels, id, { ...l, y: l.y - 1 });
  // Down: a panel in the way swaps over this one; otherwise compaction would float it back.
  const moved = { ...l, y: l.y + 1 };
  const blocker = panels
    .filter((q) => q.id !== id && overlaps(moved, q.layout))
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)[0];
  if (!blocker) return placePanel(panels, id, moved);
  return placePanel(panels, blocker.id, { ...blocker.layout, y: l.y });
}

export function grow(panels: PanelSpec[], id: string, dir: Dir): PanelSpec[] {
  const p = panels.find((q) => q.id === id);
  if (!p) return panels;
  const l = p.layout;
  let next: Layout = l;
  if (dir === "right") next = { ...l, w: Math.min(l.w + 1, GRID_COLUMNS - l.x) };
  else if (dir === "left") next = { ...l, w: Math.max(l.w - 1, MIN_W) };
  else if (dir === "down") next = { ...l, h: Math.min(l.h + 1, MAX_H) };
  else next = { ...l, h: Math.max(l.h - 1, MIN_H) };
  return same(l, next) ? panels : placePanel(panels, id, next);
}

/** The first row-major spot where w x h fits above the current bottom, else a new row. */
export function freeSpot(panels: PanelSpec[], w: number, h: number): { x: number; y: number } {
  const width = Math.min(GRID_COLUMNS, w);
  const bottom = panels.reduce((m, p) => Math.max(m, p.layout.y + p.layout.h), 0);
  for (let y = 0; y + h <= bottom; y++) {
    for (let x = 0; x + width <= GRID_COLUMNS; x++) {
      if (!panels.some((p) => overlaps({ x, y, w: width, h }, p.layout))) return { x, y };
    }
  }
  return { x: 0, y: bottom };
}

export function appendPanel(spec: DashboardSpec, panel: NewPanel): DashboardSpec {
  const size = DEFAULT_SIZES[panel.type];
  const w = panel.layout?.w ?? size.w;
  const h = panel.layout?.h ?? size.h;
  const spot =
    panel.layout?.x !== undefined && panel.layout?.y !== undefined
      ? { x: panel.layout.x, y: panel.layout.y }
      : freeSpot(spec.panels, w, h);
  const full = { ...panel, layout: { ...spot, w, h } } as PanelSpec;
  return { ...spec, panels: [...spec.panels, full] };
}

/** The panel whose centre lies in `dir` from this one, nearest first; ties go to smaller y, x. */
export function neighbour(panels: PanelSpec[], fromId: string, dir: Dir): string | null {
  const from = panels.find((p) => p.id === fromId);
  if (!from) return null;
  const cx = from.layout.x + from.layout.w / 2;
  const cy = from.layout.y + from.layout.h / 2;
  let best: { id: string; d: number; y: number; x: number } | null = null;
  for (const p of panels) {
    if (p.id === fromId) continue;
    const dx = p.layout.x + p.layout.w / 2 - cx;
    const dy = p.layout.y + p.layout.h / 2 - cy;
    const ok =
      (dir === "left" && dx < 0) ||
      (dir === "right" && dx > 0) ||
      (dir === "up" && dy < 0) ||
      (dir === "down" && dy > 0);
    if (!ok) continue;
    const cand = { id: p.id, d: dx * dx + dy * dy, y: p.layout.y, x: p.layout.x };
    if (
      !best ||
      cand.d < best.d ||
      (cand.d === best.d && (cand.y < best.y || (cand.y === best.y && cand.x < best.x)))
    ) {
      best = cand;
    }
  }
  return best ? best.id : null;
}
