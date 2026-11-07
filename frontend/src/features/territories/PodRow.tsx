import type { Provider, ResourceRow } from "../../api/types";
import { formatAge, statusClass, textColumn } from "./model";
import { knownProvider } from "./ProviderBadge";
import { Status } from "./Status";
import s from "./PodRow.module.css";
import pc from "./provider.module.css";

export const COLUMNS = ["Name", "Namespace", "Status", "Ready", "Restarts", "Node", "Age"] as const;
export const COLUMN_COUNT = COLUMNS.length;

const UNKNOWN = "—";

/** The key a pod row is known by across clusters (uids are only unique within one). */
export function rowKey(clusterId: string, uid: string): string {
  return `${clusterId}/${uid}`;
}

export function PodRow({
  row,
  provider,
  last = false,
  rowIndex,
  now,
  selected = false,
  expanded = false,
  focusable = false,
  onActivate,
}: {
  row: ResourceRow;
  provider: Provider;
  last?: boolean;
  rowIndex?: number;
  now?: Date;
  /** The table's current row: highlighted, and the one the keyboard acts on. */
  selected?: boolean;
  /** Its inspector is open right below it. */
  expanded?: boolean;
  /** Takes Tab focus for the table (one row at a time, roving tabindex). */
  focusable?: boolean;
  onActivate?: (row: ResourceRow) => void;
}) {
  const restarts = row.columns.restarts;
  const node = textColumn(row, "node");
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={onActivate ? selected : undefined}
      aria-expanded={onActivate ? expanded : undefined}
      data-row-key={rowKey(row.cluster_id, row.uid)}
      tabIndex={focusable ? 0 : -1}
      onClick={onActivate ? () => onActivate(row) : undefined}
      className={`${s.row} ${pc[knownProvider(provider)]}${last ? ` ${s.last}` : ""}${selected ? ` ${s.sel}` : ""}${onActivate ? ` ${s.active}` : ""}`}
    >
      <span role="gridcell" className={`${s.cell} ${s.name}`} title={row.name}>{row.name}</span>
      <span role="gridcell" className={`${s.cell} ${s.dim}`}>{row.namespace ?? UNKNOWN}</span>
      <span role="gridcell" className={s.cell}>
        <Status label={textColumn(row, "status") ?? "Unknown"} cls={statusClass(row)} />
      </span>
      <span role="gridcell" className={`${s.cell} ${s.num}`}>{textColumn(row, "ready") ?? UNKNOWN}</span>
      <span role="gridcell" className={`${s.cell} ${s.num}${restarts === 0 ? ` ${s.zero}` : ""}`}>
        {typeof restarts === "number" ? restarts : UNKNOWN}
      </span>
      <span role="gridcell" className={`${s.cell} ${s.dim}`} title={node ?? undefined}>{node ?? UNKNOWN}</span>
      <span role="gridcell" className={`${s.cell} ${s.dim} ${s.num}`}>{formatAge(row.created_at, now ?? new Date())}</span>
    </div>
  );
}
