// Table panel: label columns then one value column per query, sortable by header (click, Enter or
// Space), virtualized so a long answer stays light.

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChartSeries } from "../dashboards/runPanel";
import type { PanelSpec } from "../dashboards/schema";
import { tableRows, valueColumns, type TableData } from "./reduce";
import { formatValue, NO_VALUE } from "./units";
import styles from "./Charts.module.css";

type TablePanel = Extract<PanelSpec, { type: "table" }>;
type Sort = { column: number; descending: boolean } | null;

const ROW = 30;
const OVERSCAN = 8;

export interface TableChartProps {
  panel: TablePanel;
  series: ChartSeries[];
}

/** A column's words: label names as sentence case (`pod_name` is Pod name), query names as written with a capital. */
export function headerWords(name: string, isLabel: boolean): string {
  const text = isLabel ? name.replace(/[_.]+/g, " ").trim() : name;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const blank = (v: string | number | null) => v === null || v === "";

function compare(a: string | number | null, b: string | number | null): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function initialSort(sort: TablePanel["options"]["sort"], columns: string[]): Sort {
  const column = sort ? columns.indexOf(sort.column) : -1;
  return sort && column >= 0 ? { column, descending: sort.descending } : null;
}

export default function TableChart({ panel, series }: TableChartProps) {
  const table = useMemo(() => tableRows(series, panel), [series, panel]);
  if (series.length === 0) return null;
  // The list is its own component, so it starts fresh (and measures its box) whenever the panel
  // goes from nothing to something.
  return <TableList panel={panel} table={table} />;
}

function TableList({ panel, table }: { panel: TablePanel; table: TableData }) {
  const o = panel.options;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<Sort>(() => initialSort(o.sort, table.columns));
  // The panel's own sort option changing (an edit) resets the header state.
  const [seenOption, setSeenOption] = useState(o.sort);
  if (seenOption?.column !== o.sort?.column || seenOption?.descending !== o.sort?.descending) {
    setSeenOption(o.sort);
    setSort(initialSort(o.sort, table.columns));
  }
  const valueFrom = table.columns.length - valueColumns(panel).names.length;

  const rows = useMemo(() => {
    if (!sort) return table.rows;
    const { column, descending } = sort;
    return [...table.rows].sort((x, y) => {
      const a = x.cells[column];
      const b = y.cells[column];
      if (blank(a) || blank(b)) return blank(a) === blank(b) ? 0 : blank(a) ? 1 : -1; // blanks last either way
      return (descending ? -1 : 1) * compare(a, b);
    });
  }, [table.rows, sort]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    getItemKey: (i) => rows[i].key,
    overscan: OVERSCAN,
  });

  const toggle = (column: number) =>
    setSort((s) => (s && s.column === column ? { column, descending: !s.descending } : { column, descending: false }));
  const onKey = (column: number) => (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle(column);
    }
  };
  const columns = `repeat(${table.columns.length}, minmax(96px, 1fr))`;

  return (
    <div className={styles.table} role="table" aria-label={panel.title} aria-rowcount={rows.length + 1}>
      <div ref={scrollRef} className={styles.tableScroll} tabIndex={0} aria-label={`${panel.title} rows`}>
        <div className={styles.tableHead} role="row" style={{ gridTemplateColumns: columns }}>
          {table.columns.map((name, i) => (
            <div
              key={i}
              role="columnheader"
              tabIndex={0}
              className={i >= valueFrom ? `${styles.th} ${styles.num}` : styles.th}
              aria-sort={sort && sort.column === i ? (sort.descending ? "descending" : "ascending") : "none"}
              aria-keyshortcuts="Enter Space"
              onClick={() => toggle(i)}
              onKeyDown={onKey(i)}
            >
              <span className={styles.thText} title={headerWords(name, i < valueFrom)}>{headerWords(name, i < valueFrom)}</span>
              <span className={styles.sortMark} aria-hidden="true">
                {sort && sort.column === i ? (sort.descending ? "▾" : "▴") : ""}
              </span>
            </div>
          ))}
        </div>
        <div className={styles.tableBody} role="rowgroup" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index];
            return (
              <div
                key={v.key}
                role="row"
                aria-rowindex={v.index + 2}
                className={styles.tr}
                style={{ gridTemplateColumns: columns, transform: `translateY(${v.start}px)`, height: ROW }}
              >
                {row.cells.map((cell, i) => {
                  const shown = i >= valueFrom ? formatValue(cell as number | null, o.unit, o.decimals) : blank(cell) ? NO_VALUE : String(cell);
                  // A cut cell shows its whole value on hover.
                  return (
                    <div key={i} role="cell" className={i >= valueFrom ? `${styles.td} ${styles.num}` : styles.td} title={shown === NO_VALUE ? undefined : shown}>
                      {shown}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
