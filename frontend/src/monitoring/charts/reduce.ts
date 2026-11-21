// Turning series into the few numbers and rows the stat, gauge, bar and table panels show.

import type { ChartSeries } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";

export type Calc = "last" | "mean" | "max" | "min" | "sum";
type TablePanel = Extract<PanelSpec, { type: "table" }>;

/** One number for a series. Gaps (`null`) are ignored; with no values the answer is `null`. */
export function reduceSeries(points: [number, number | null][], calc: Calc): number | null {
  let last: number | null = null;
  let sum = 0;
  let count = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const p of points) {
    const v = p[1];
    if (v === null || !Number.isFinite(v)) continue;
    last = v;
    sum += v;
    count++;
    if (v > max) max = v;
    if (v < min) min = v;
  }
  if (count === 0) return null;
  switch (calc) {
    case "last": return last;
    case "mean": return sum / count;
    case "sum": return sum;
    case "max": return max;
    case "min": return min;
  }
}

export interface TableData {
  columns: string[];
  rows: { key: string; cells: (string | number | null)[] }[];
}

export const PROJECT_COLUMN = "Project";

/** The shown queries' refs and the names of their value columns. */
export function valueColumns(panel: TablePanel): { refs: string[]; names: string[] } {
  const queries = panel.queries.filter((q) => !q.hidden);
  if (queries.length <= 1) return { refs: [queries[0]?.ref ?? "A"], names: ["Value"] };
  return { refs: queries.map((q) => q.ref), names: queries.map((q) => q.legend.trim() || q.ref) };
}

/**
 * One row per label set (and project), one value column per shown query. A query's column is
 * named by its legend or its ref (`Value` when there is only one), and holds the series' last value.
 */
export function tableRows(series: ChartSeries[], panel: TablePanel): TableData {
  const group = series.some((s) => s.projectName !== null);
  const { refs, names } = valueColumns(panel);

  let labels: string[] = [];
  for (const s of series) {
    for (const name of Object.keys(s.labels)) {
      if (name !== "__name__" && !labels.includes(name)) labels.push(name);
    }
  }
  const wanted = panel.options.columns;
  if (wanted.length > 0) labels = wanted.filter((name) => name !== "__name__");

  const rows = new Map<string, { key: string; cells: (string | number | null)[] }>();
  for (const s of series) {
    const slot = refs.indexOf(s.queryRef);
    if (slot < 0) continue;
    const identity = JSON.stringify([s.projectName, labels.map((l) => s.labels[l] ?? null)]);
    let row = rows.get(identity);
    if (!row) {
      const cells: (string | number | null)[] = [];
      if (group) cells.push(s.projectName ?? "");
      for (const l of labels) cells.push(s.labels[l] ?? "");
      for (let i = 0; i < refs.length; i++) cells.push(null);
      row = { key: identity, cells };
      rows.set(identity, row);
    }
    row.cells[(group ? 1 : 0) + labels.length + slot] = reduceSeries(s.points, "last");
  }
  return { columns: [...(group ? [PROJECT_COLUMN] : []), ...labels, ...names], rows: [...rows.values()] };
}
