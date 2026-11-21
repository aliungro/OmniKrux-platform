// Series and threshold colours. Series take a Territories token by a stable hash of their key; the
// canvas reads the token's value at draw time (`resolveToken`), never a hard-coded colour.

import type { Threshold, ThresholdColor } from "../dashboards/schema";

/** Never `--bad`: rose means a breached threshold, not "series 4". */
export const SERIES_COLORS = ["--focus", "--kind", "--ok", "--warn", "--eks", "--aks", "--gke", "--onprem"] as const;

/** FNV-1a over UTF-16 code units. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The token name (e.g. `--kind`) for a series key: the same key always gets the same one. */
export function seriesColor(key: string): string {
  return SERIES_COLORS[fnv1a(key) % SERIES_COLORS.length];
}

/** The highest threshold at or below the value, or null below them all. */
export function thresholdColor(value: number, thresholds: Threshold[]): ThresholdColor | null {
  let best: Threshold | null = null;
  for (const t of thresholds) {
    if (t.value <= value && (best === null || t.value > best.value)) best = t;
  }
  return best ? best.color : null;
}

/** A token's current value on an element (the theme can change between draws). */
export function resolveToken(style: Pick<CSSStyleDeclaration, "getPropertyValue">, token: string): string {
  return style.getPropertyValue(token).trim() || "currentcolor";
}
