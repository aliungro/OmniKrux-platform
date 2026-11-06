import type { Provider, ResourceRow } from "../../api/types";
import { formatAge, statusClass, textColumn } from "./model";
import { knownProvider } from "./ProviderBadge";
import { Status } from "./Status";
import s from "./PodRow.module.css";
import pc from "./provider.module.css";

export const COLUMNS = ["Name", "Namespace", "Status", "Ready", "Restarts", "Node", "Age"] as const;
export const COLUMN_COUNT = COLUMNS.length;

const UNKNOWN = "—";

export function PodRow({
  row,
  provider,
  last = false,
  rowIndex,
  now,
}: {
  row: ResourceRow;
  provider: Provider;
  last?: boolean;
  rowIndex?: number;
  now?: Date;
}) {
  const restarts = row.columns.restarts;
  const node = textColumn(row, "node");
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      tabIndex={-1}
      className={`${s.row} ${pc[knownProvider(provider)]}${last ? ` ${s.last}` : ""}`}
    >
      <span role="cell" className={`${s.cell} ${s.name}`} title={row.name}>{row.name}</span>
      <span role="cell" className={`${s.cell} ${s.dim}`}>{row.namespace ?? UNKNOWN}</span>
      <span role="cell" className={s.cell}>
        <Status label={textColumn(row, "status") ?? "Unknown"} cls={statusClass(row)} />
      </span>
      <span role="cell" className={`${s.cell} ${s.num}`}>{textColumn(row, "ready") ?? UNKNOWN}</span>
      <span role="cell" className={`${s.cell} ${s.num}${restarts === 0 ? ` ${s.zero}` : ""}`}>
        {typeof restarts === "number" ? restarts : UNKNOWN}
      </span>
      <span role="cell" className={`${s.cell} ${s.dim}`} title={node ?? undefined}>{node ?? UNKNOWN}</span>
      <span role="cell" className={`${s.cell} ${s.dim} ${s.num}`}>{formatAge(row.created_at, now ?? new Date())}</span>
    </div>
  );
}
