import type { ColumnSpec, Link, ResourceRow } from "../../api/types";
import { formatAge, formatAgo, statusClass, textColumn } from "./model";
import { Status } from "./Status";
import s from "./ResourceRowView.module.css";

export const UNKNOWN = "—";

/** One grid template for the header and every row, from the columns' widths. */
export function gridTemplate(columns: readonly ColumnSpec[]): string {
  return columns
    .map((c) => (c.key === "name" ? "minmax(200px, 2fr)" : c.width === "s" ? "70px" : c.width === "l" ? "2fr" : "1fr"))
    .join(" ");
}

/** Wide enough that every column keeps a readable share; the table scrolls sideways below it. */
export function minTableWidth(columns: readonly ColumnSpec[]): number {
  const cols = columns.reduce((w, c) => w + (c.key === "name" ? 200 : c.width === "s" ? 70 : c.width === "l" ? 180 : 100), 0);
  // Column gaps, the row's own padding and the table's.
  return cols + 12 * (columns.length - 1) + 32 + 32;
}

function isLink(v: unknown): v is Link {
  return typeof v === "object" && v !== null && typeof (v as Link).label === "string";
}

/** Plain words for a value the backend sent; "—" for nothing (never a made-up 0 or "None"). */
function plain(v: unknown): string {
  if (v === null || v === undefined || v === "") return UNKNOWN;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) {
    const parts = v.filter((x) => typeof x === "string" || typeof x === "number").map(String);
    return parts.length > 0 ? parts.join(", ") : UNKNOWN;
  }
  if (isLink(v)) return v.label;
  return UNKNOWN;
}

/**
 * One cell of a row, by its column's type. `podsOnNode` is the live pod count for a node row
 * (null when its cluster's pods aren't live).
 */
export function Cell({
  col,
  row,
  now,
  podsOnNode = null,
}: {
  col: ColumnSpec;
  row: ResourceRow;
  now: Date;
  podsOnNode?: number | null;
}) {
  const v = row.columns[col.key];
  // A `{key}_title` column carries the details for this one's tooltip (Ruling R23: node taints).
  const detail = textColumn(row, `${col.key}_title`) || undefined;

  if (col.key === "name") {
    return <span role="gridcell" className={`${s.cell} ${s.name}`} title={row.name}>{row.name}</span>;
  }
  if (col.key === "namespace") {
    return <span role="gridcell" className={`${s.cell} ${s.dim}`}>{row.namespace ?? UNKNOWN}</span>;
  }
  switch (col.type) {
    case "status": {
      const label = col.key === "status" ? textColumn(row, "status") : typeof v === "string" ? v : null;
      return (
        <span role="gridcell" className={s.cell}>
          <Status label={label ?? "Unknown"} cls={statusClass(row)} />
        </span>
      );
    }
    case "age":
      return <span role="gridcell" className={`${s.cell} ${s.dim} ${s.num}`}>{formatAge(row.created_at, now)}</span>;
    case "time": {
      const at = typeof v === "string" ? v : null;
      const when = at ? new Date(at) : null;
      const title = when && !Number.isNaN(when.getTime()) ? when.toLocaleString() : undefined;
      return <span role="gridcell" className={`${s.cell} ${s.dim} ${s.num}`} title={title}>{formatAgo(at, now)}</span>;
    }
    case "cpu":
    case "memory":
      // Metrics arrive with Task 11; until then nothing is measured, so nothing is shown.
      return <span role="gridcell" className={`${s.cell} ${s.num} ${s.zero}`}>{UNKNOWN}</span>;
    case "pods":
      return (
        <span role="gridcell" className={`${s.cell} ${s.num}${podsOnNode === null ? ` ${s.zero}` : ""}`}>
          {podsOnNode ?? UNKNOWN}
        </span>
      );
    case "number":
      return (
        <span role="gridcell" className={`${s.cell} ${s.num}${v === 0 || typeof v !== "number" ? ` ${s.zero}` : ""}`} title={detail}>
          {typeof v === "number" ? v : plain(v)}
        </span>
      );
    case "object": {
      const text = plain(v);
      return <span role="gridcell" className={s.cell} title={text === UNKNOWN ? undefined : text}>{text}</span>;
    }
    default: {
      const text = plain(v);
      return (
        <span role="gridcell" className={`${s.cell} ${s.dim}`} title={detail ?? (text === UNKNOWN ? undefined : text)}>
          {text}
        </span>
      );
    }
  }
}
