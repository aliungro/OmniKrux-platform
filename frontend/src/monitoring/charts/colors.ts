// Series and threshold colours. A panel's series take Territories tokens in turn, so no two share
// one until all eight are used; the canvas reads the token's value at draw time (`resolveToken`),
// never a hard-coded colour.

import type { ChartSeries } from "../dashboards/runPanel";
import type { Threshold, ThresholdColor } from "../dashboards/schema";

/**
 * In the order series take them: neighbours far apart in hue (lavender, orange, green, blue, grey,
 * sky, orchid, lime). Never `--ok`, `--warn` or `--bad`: stat, gauge, bar and threshold lines use
 * them for Good, Warning and a breached threshold, so a series never looks like one.
 */
export const SERIES_COLORS = ["--focus", "--eks", "--gke", "--aks", "--onprem", "--kind", "--series-7", "--series-8"] as const;

type Colored = Pick<ChartSeries, "key" | "labels" | "queryRef" | "projectName">;

const labelText = (labels: Record<string, string>) => JSON.stringify(Object.keys(labels).sort().map((k) => [k, labels[k]]));

/**
 * A token for each of a panel's series (by key), all of them, hidden ones included, so hiding one
 * never recolours the rest. Series take the tokens in the panel's order: its queries and projects
 * as they run, then each one's series by their labels (a source may list them in any order), so
 * the same series keep the same colours from one refresh to the next. The tokens repeat only
 * after all eight are used.
 */
export function seriesColors(series: readonly Colored[]): Map<string, string> {
  const groups = new Map<string, number>();
  const ranked = series.map((s) => {
    const group = `${s.queryRef}\u0000${s.projectName ?? ""}`;
    if (!groups.has(group)) groups.set(group, groups.size);
    return { key: s.key, group: groups.get(group) as number, labels: labelText(s.labels) };
  });
  ranked.sort((a, b) => a.group - b.group || (a.labels < b.labels ? -1 : a.labels > b.labels ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out = new Map<string, string>();
  for (const r of ranked) if (!out.has(r.key)) out.set(r.key, SERIES_COLORS[out.size % SERIES_COLORS.length]);
  return out;
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
