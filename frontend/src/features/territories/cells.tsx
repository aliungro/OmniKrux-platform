import type { ColumnSpec, Link, ResourceRow } from "../../api/types";
import type { Live } from "../../api/useMetrics";
import { formatCpu, formatMemory, formatWindow, fraction, HOT_AT } from "../metrics/format";
import { Meter } from "../metrics/Meter";
import { formatAge, formatAgo, statusClass, textColumn } from "./model";
import { Status } from "./Status";
import s from "./ResourceRowView.module.css";

export const UNKNOWN = "—";

const isMeter = (c: ColumnSpec) => c.type === "cpu" || c.type === "memory";
/** A 60 px bar, its gap and a text like "301 / 256 Mi". */
const METER_WIDTH = "minmax(150px, 1fr)";

/** One grid template for the header and every row, from the columns' widths. */
export function gridTemplate(columns: readonly ColumnSpec[]): string {
  return columns
    .map((c) => (c.key === "name" ? "minmax(200px, 2fr)" : isMeter(c) ? METER_WIDTH : c.width === "s" ? "70px" : c.width === "l" ? "2fr" : "1fr"))
    .join(" ");
}

/** Wide enough that every column keeps a readable share; the table scrolls sideways below it. */
export function minTableWidth(columns: readonly ColumnSpec[]): number {
  const cols = columns.reduce((w, c) => w + (c.key === "name" ? 200 : isMeter(c) ? 150 : c.width === "s" ? 70 : c.width === "l" ? 180 : 100), 0);
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
  live = null,
  nowMs,
}: {
  col: ColumnSpec;
  row: ResourceRow;
  now: Date;
  podsOnNode?: number | null;
  /** The row's live usage, or why there is none; null where metrics aren't polled. */
  live?: Live | null;
  /** The moment `live` was judged at, for "measured X ago". */
  nowMs?: number;
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
      return (
        <span role="gridcell" className={`${s.cell} ${s.num}${live?.usage ? "" : ` ${s.zero}`}`}>
          <UsageMeter col={col} row={row} live={live} nowMs={nowMs ?? Date.now()} />
        </span>
      );
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

/** CPU or memory of a pod or node row; a dash (with the reason as its title) whenever it is not live. */
function UsageMeter({ col, row, live, nowMs }: { col: ColumnSpec; row: ResourceRow; live: Live | null; nowMs: number }) {
  const u = live?.usage;
  if (!u) return <span title={live?.why ?? undefined}>{UNKNOWN}</span>;
  const num = (k: string) => {
    const x = row.columns[k];
    return typeof x === "number" && x > 0 ? x : null;
  };
  const cpu = col.type === "cpu";
  // Pods: against the limit, else the request. Nodes: against what they can allocate.
  const limit = cpu ? (num("cpu_limit_m") ?? num("allocatable_cpu_m")) : (num("memory_limit_b") ?? num("allocatable_memory_b"));
  const request = cpu ? num("cpu_request_m") : num("memory_request_b");
  const used = cpu ? u.cpu_m : u.memory_b;
  const basis = limit ?? request;
  const frac = fraction(used, basis);
  const text = cpu ? formatCpu(used) : formatMemory(used, limit);
  const title = u.stale
    ? `Measured ${formatAge(u.at, new Date(nowMs))} ago; metrics-server has nothing newer.`
    : `Measured over ${formatWindow(u.window_s)}`;
  return <Meter text={text} frac={frac} hot={limit !== null && frac !== null && frac >= HOT_AT} stale={u.stale} title={title} />;
}
