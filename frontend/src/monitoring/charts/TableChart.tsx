// Table panel: label columns then one value column per query, sortable by header (click, Enter or
// Space), windowed so a long answer stays light.

import { useMemo, useState, type KeyboardEvent } from "react";
import type { ChartSeries } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import { tableRows, valueColumns } from "./reduce";
import { formatValue, NO_VALUE } from "./units";
import { useWindowed } from "./useWindowed";
import styles from "./Charts.module.css";

type TablePanel = Extract<PanelSpec, { type: "table" }>;

const ROW = 30;

export interface TableChartProps {
  panel: TablePanel;
  series: ChartSeries[];
}

function compare(a: string | number | null, b: string | number | null): number {
  if (a === null || a === "") return b === null || b === "" ? 0 : 1;
  if (b === null || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export default function TableChart({ panel, series }: TableChartProps) {
  const o = panel.options;
  const table = useMemo(() => tableRows(series, panel), [series, panel]);
  const [sort, setSort] = useState(o.sort);
  const sortIndex = sort ? table.columns.indexOf(sort.column) : -1;
  const valueFrom = table.columns.length - valueColumns(panel).names.length;

  const rows = useMemo(() => {
    if (sortIndex < 0 || !sort) return table.rows;
    const dir = sort.descending ? -1 : 1;
    return [...table.rows].sort((x, y) => dir * compare(x.cells[sortIndex], y.cells[sortIndex]));
  }, [table.rows, sortIndex, sort]);

  const win = useWindowed(rows.length, ROW, true);
  if (series.length === 0) return null;

  const toggle = (column: string) =>
    setSort((s) => (s && s.column === column ? { column, descending: !s.descending } : { column, descending: false }));
  const onKey = (column: string) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle(column);
    }
  };
  const columns = `repeat(${table.columns.length}, minmax(96px, 1fr))`;

  return (
    <div className={styles.table} role="table" aria-label={panel.title} aria-rowcount={rows.length + 1}>
      <div ref={win.ref} className={styles.tableScroll} onScroll={win.onScroll} tabIndex={0} aria-label={`${panel.title} rows`}>
        <div className={styles.tableHead} role="row" style={{ gridTemplateColumns: columns }}>
          {table.columns.map((name, i) => (
            <div
              key={name}
              role="columnheader"
              tabIndex={0}
              className={i >= valueFrom ? `${styles.th} ${styles.num}` : styles.th}
              aria-sort={sort && sort.column === name ? (sort.descending ? "descending" : "ascending") : "none"}
              aria-keyshortcuts="Enter Space"
              onClick={() => toggle(name)}
              onKeyDown={onKey(name)}
            >
              {name}
              <span className={styles.sortMark} aria-hidden="true">
                {sort && sort.column === name ? (sort.descending ? "▾" : "▴") : ""}
              </span>
            </div>
          ))}
        </div>
        <div className={styles.tableBody} role="rowgroup" style={{ height: rows.length * ROW }}>
          {rows.slice(win.first, win.last).map((row, k) => (
            <div
              key={row.key}
              role="row"
              aria-rowindex={win.first + k + 2}
              className={styles.tr}
              style={{ gridTemplateColumns: columns, top: (win.first + k) * ROW, height: ROW }}
            >
              {row.cells.map((cell, i) => (
                <div key={i} role="cell" className={i >= valueFrom ? `${styles.td} ${styles.num}` : styles.td} title={typeof cell === "string" ? cell : undefined}>
                  {i >= valueFrom ? formatValue(cell as number | null, o.unit, o.decimals) : cell === "" || cell === null ? NO_VALUE : cell}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
