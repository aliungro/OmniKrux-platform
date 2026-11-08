import type { KindInfo, Provider, ResourceRow } from "../../api/types";
import { Cell } from "./cells";
import { rowKey } from "./model";
import { knownProvider } from "./ProviderBadge";
import s from "./ResourceRowView.module.css";
import pc from "./provider.module.css";

/** One row of any kind: its kind's columns, in the table's grid (`--cols` on the table). */
export function ResourceRowView({
  row,
  kind,
  provider,
  last = false,
  rowIndex,
  now,
  selected = false,
  expanded,
  focusable = false,
  podCounts,
  onActivate,
}: {
  row: ResourceRow;
  kind: KindInfo;
  provider: Provider;
  last?: boolean;
  rowIndex?: number;
  now?: Date;
  /** The table's current row: highlighted, and the one the keyboard acts on. */
  selected?: boolean;
  /** Whether its details are open right below it; undefined for a row that has no details to open. */
  expanded?: boolean;
  /** Takes Tab focus for the table (one row at a time, roving tabindex). */
  focusable?: boolean;
  /** Live pods per node per cluster, for a node row's Pods column. */
  podCounts?: Map<string, Map<string, number>> | null;
  onActivate?: (row: ResourceRow) => void;
}) {
  const at = now ?? new Date();
  const nodePods = podCounts?.get(row.cluster_id);
  const podsOnNode = nodePods ? (nodePods.get(row.name) ?? 0) : null;
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
      {kind.columns.map((c) => (
        <Cell key={c.key} col={c} row={row} now={at} podsOnNode={c.type === "pods" ? podsOnNode : null} />
      ))}
    </div>
  );
}
