import type { ColumnSpec, NodeSize, ObjectColumn, ResourceRow } from "../../api/types";
import type { Live } from "../../api/useMetrics";
import { formatCpu, formatMemory, formatWindow, fraction, HOT_AT } from "../metrics/format";
import { usageBasis } from "../metrics/basis";
import { Meter } from "../metrics/Meter";
import { validWidth } from "../tables/columnWidths";
import { LinkButton, useGoTo } from "../navigation/navigation";
import { formatAge, formatAgo, statusClass, textColumn, titleColumn } from "./model";
import { Status } from "./Status";
import { ContainerBullets, isContainerStates } from "./ContainerBullets";
import s from "./ResourceRowView.module.css";

export const UNKNOWN = "—";

export function columnMinWidth(col: ColumnSpec): number {
  return col.type === "memory" ? 80 : 64;
}

function fixedWidth(col: ColumnSpec, widths?: ReadonlyMap<string, number>): number | undefined {
  const custom = widths?.get(col.key);
  if (validWidth(custom)) {
    return Math.max(columnMinWidth(col), custom);
  }
  if (col.type === "cpu") return 100;
  if (col.type === "memory") return 112;
  return undefined;
}

/** One grid template for the header and every row, from the columns' widths. */
export function gridTemplate(columns: readonly ColumnSpec[], titleKey: string = "name", widths?: ReadonlyMap<string, number>): string {
  // The built-in pod schema has restarts; other kinds keep their existing status width.
  const podColumns = columns.some((c) => c.key === "restarts");
  return columns
    .map((c) => {
      const fixed = fixedWidth(c, widths);
      if (fixed !== undefined) return `${fixed}px`;
      if (c.key === titleKey) return "minmax(200px, 2fr)";
      if (c.key === "name") return "1fr";
      if (podColumns && c.key === "status") return "minmax(180px, 1fr)";
      return c.width === "s" ? "70px" : c.width === "l" ? "2fr" : "1fr";
    })
    .join(" ");
}

/** Wide enough that every column keeps a readable share; the table scrolls sideways below it. */
export function minTableWidth(columns: readonly ColumnSpec[], titleKey: string = "name", widths?: ReadonlyMap<string, number>): number {
  const podColumns = columns.some((c) => c.key === "restarts");
  const cols = columns.reduce((w, c) => {
    const fixed = fixedWidth(c, widths);
    if (fixed !== undefined) return w + fixed;
    if (c.key === titleKey) return w + 200;
    if (c.key === "name") return w + 100;
    if (podColumns && c.key === "status") return w + 180;
    return w + (c.width === "s" ? 70 : c.width === "l" ? 180 : 100);
  }, 0);
  // Column gaps, the row's own padding and the table's.
  return cols + 12 * (columns.length - 1) + 32 + 32;
}

function isObjectColumn(v: unknown): v is ObjectColumn {
  return typeof v === "object" && v !== null && typeof (v as ObjectColumn).label === "string";
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
  if (isObjectColumn(v)) return v.label;
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
  nodeSize = null,
  nowMs,
}: {
  col: ColumnSpec;
  row: ResourceRow;
  now: Date;
  podsOnNode?: number | null;
  /** The row's live usage, or why there is none; null where metrics aren't polled. */
  live?: Live | null;
  nodeSize?: NodeSize | null;
  /** The moment `live` was judged at, for "measured X ago". */
  nowMs?: number;
}) {
  const v = row.columns[col.key];
  // A `{key}_title` column carries the details for this one's tooltip (Ruling R23: node taints).
  const detail = textColumn(row, `${col.key}_title`) || undefined;

  if (col.key === "name" || col.key === titleColumn(row)) {
    // The row's title is prominent; a Helm release's Secret name, shown beside it, is not.
    const text = col.key === "name" ? row.name : plain(v);
    const cls = col.key === titleColumn(row) ? s.name : s.dim;
    return <span role="gridcell" className={`${s.cell} ${cls}`} title={text}>{text}</span>;
  }
  if (col.key === "namespace") {
    return <span role="gridcell" className={`${s.cell} ${s.dim}`}>{row.namespace ?? UNKNOWN}</span>;
  }
  switch (col.type) {
    case "status": {
      const label = col.key === "status" ? textColumn(row, "status") : typeof v === "string" ? v : null;
      const podStatus = row.kind === "Pod" && col.key === "status";
      const containers = podStatus && isContainerStates(row.columns.containers)
        ? row.columns.containers : null;
      return (
        <span role="gridcell" className={`${s.cell} ${s.status}`}>
          {containers && <ContainerBullets containers={containers} />}
          <Status label={label ?? "Unknown"} cls={statusClass(row)} showShape={!podStatus} />
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
          <UsageMeter col={col} row={row} live={live} nodeSize={nodeSize} nowMs={nowMs ?? Date.now()} />
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
      return (
        <span role="gridcell" className={s.cell} title={text === UNKNOWN ? undefined : text}>
          {isObjectColumn(v) && v.kind_key !== null ? <ObjectLink row={row} target={v} kindKey={v.kind_key} /> : text}
        </span>
      );
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

/**
 * What an `object` cell points at, as a link on the row's cluster. It takes no tab stop (the table
 * has one), and keyboard users follow the same link from the row's details.
 */
function ObjectLink({ row, target, kindKey }: { row: ResourceRow; target: ObjectColumn; kindKey: string }) {
  const goTo = useGoTo();
  const { namespace, name, label } = target;
  return (
    <LinkButton
      link={{ kind_key: kindKey, namespace, name }}
      onLink={(link) => goTo({ ...link, clusterId: row.cluster_id })}
      tabIndex={-1}
      className={s.objLink}
    >
      {label}
    </LinkButton>
  );
}

/** CPU or memory of a pod or node row; a dash (with the reason as its title) whenever it is not live. */
function UsageMeter({ col, row, live, nodeSize, nowMs }: { col: ColumnSpec; row: ResourceRow; live: Live | null; nodeSize: NodeSize | null; nowMs: number }) {
  const u = live?.usage;
  if (!u) return <span title={live?.why ?? undefined}>{UNKNOWN}</span>;
  const cpu = col.type === "cpu";
  const basis = usageBasis(row, cpu ? "cpu" : "memory", nodeSize);
  const used = cpu ? u.cpu_m : u.memory_b;
  const frac = fraction(used, basis?.of);
  // Preserve the existing memory text: show a denominator only for a limit or allocatable.
  const against = basis?.basis === "limit" || basis?.basis === "allocatable" ? basis.of : null;
  const text = cpu ? formatCpu(used) : formatMemory(used, against);
  let comparison = "No limit, request or node size to compare with.";
  if (basis && frac !== null) {
    const pct = Math.round(frac * 100);
    const amount = cpu ? formatCpu(basis.of) : formatMemory(basis.of);
    switch (basis.basis) {
      case "limit": comparison = `${pct}% of its limit (${amount})`; break;
      case "request": comparison = `${pct}% of its request (${amount}); no limit set`; break;
      case "node": comparison = `${pct}% of node ${textColumn(row, "node") ?? ""} (${amount} allocatable); no request or limit set`; break;
      case "allocatable": comparison = `${pct}% of what the node can allocate (${amount})`; break;
    }
  }
  const measured = u.stale
    ? `Measured ${formatAge(u.at, new Date(nowMs))} ago; metrics-server has nothing newer.`
    : `Measured over ${formatWindow(u.window_s)}`;
  return <Meter compact text={text} frac={frac} hot={basis !== null && basis.basis !== "request" && frac !== null && frac >= HOT_AT} stale={u.stale} title={`${comparison}\n${measured}`} />;
}
