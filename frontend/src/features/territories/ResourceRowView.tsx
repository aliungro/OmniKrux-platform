import type { KindInfo, Provider, ResourceRow } from "../../api/types";
import type { MetricsLookup } from "../../api/useMetrics";
import { Cell } from "./cells";
import { rowKey, textColumn } from "./model";
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
  metrics = null,
  onActivate,
  bulk,
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
  /** Live CPU and memory for this kind's rows (pods and nodes); null where none are polled. */
  metrics?: MetricsLookup | null;
  onActivate?: (row: ResourceRow) => void;
  bulk?: { checked: boolean; onToggle?: () => void };
}) {
  const at = now ?? new Date();
  const nodePods = podCounts?.get(row.cluster_id);
  const podsOnNode = nodePods ? (nodePods.get(row.name) ?? 0) : null;
  const metricsKey = row.namespace ? `${row.namespace}/${row.name}` : row.name;
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-selected={onActivate ? selected : undefined}
      aria-expanded={onActivate ? expanded : undefined}
      data-row-key={rowKey(row.cluster_id, row.uid)}
      data-bulk-selected={bulk?.checked || undefined}
      tabIndex={focusable ? 0 : -1}
      onClick={onActivate ? () => onActivate(row) : undefined}
      className={`${s.row} ${pc[knownProvider(provider)]}${last ? ` ${s.last}` : ""}${selected ? ` ${s.sel}` : ""}${onActivate ? ` ${s.active}` : ""}`}
    >
      {bulk && <span role="gridcell" className={s.check}>
        <input type="checkbox" aria-label={`Select ${row.name}`} checked={bulk.checked}
          disabled={!bulk.onToggle} tabIndex={focusable ? 0 : -1}
          onChange={bulk.onToggle} onClick={event => event.stopPropagation()} />
      </span>}
      {kind.columns.map((c) => (
        <Cell
          key={c.key}
          col={c}
          row={row}
          now={at}
          podsOnNode={c.type === "pods" ? podsOnNode : null}
          live={metrics && (c.type === "cpu" || c.type === "memory") ? metrics.usage(row.cluster_id, metricsKey) : null}
          nodeSize={row.kind === "Pod" && (c.type === "cpu" || c.type === "memory") ? metrics?.nodeSize(row.cluster_id, textColumn(row, "node") ?? "") ?? null : null}
          nowMs={metrics?.now}
        />
      ))}
    </div>
  );
}
