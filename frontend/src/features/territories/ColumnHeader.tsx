import { useCallback, useRef, useState } from "react";
import type { ColumnSpec } from "../../api/types";
import { ColumnResizeHandle } from "../tables/ColumnResizeHandle";
import { MAX_COLUMN_WIDTH } from "../tables/columnWidths";
import { fitColumnWidth, measureColumn } from "../tables/fitColumn";
import { columnMinWidth } from "./cells";
import { filterUiFor, type ColumnFilter, type SortSpec } from "./columnFilters";
import { ColumnFilterMenu } from "./ColumnFilterMenu";
import type { Territory } from "./model";
import s from "./ColumnHeader.module.css";

interface ColumnHeaderProps {
  col: ColumnSpec;
  filter?: ColumnFilter;
  sort: SortSpec | null;
  source: Territory[];
  onFilter: (filter: ColumnFilter | null) => void;
  onSort: (sort: SortSpec | null) => void;
  onPreviewWidth: (width: number | null) => void;
  onCommitWidth: (width: number | null) => void;
  resizeView?: unknown;
  /** The visible table area, for the drag guide. */
  getGuideRect?: () => DOMRect | null;
}

export function ColumnHeader({ col, filter, sort, source, onFilter, onSort, onPreviewWidth, onCommitWidth, resizeView, getGuideRect }: ColumnHeaderProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLSpanElement>(null);
  const readWidth = useCallback(() => header.current?.getBoundingClientRect().width ?? 0, []);
  const min = columnMinWidth(col);
  const fit = useCallback(() => header.current ? fitColumnWidth(measureColumn(header.current), min, MAX_COLUMN_WIDTH) : null, [min]);
  const sortable = !["cpu", "memory", "pods"].includes(col.type);
  const dir = sort?.key === col.key ? sort.dir : null;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return (
    <span ref={header} role="columnheader" aria-label={col.label}
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"} className={s.header}>
      {sortable ? (
        <button className={s.sort} data-column-label title={`Sort by ${col.label}`}
          onClick={() => onSort(dir === "asc" ? { key: col.key, dir: "desc" } : dir === "desc" ? null : { key: col.key, dir: "asc" })}>
          {col.label}{dir && (dir === "asc" ? " ▲" : " ▼")}
        </button>
      ) : <span className={s.label} data-column-label>{col.label}</span>}
      {filterUiFor(col) && (
        <>
          <button ref={trigger} type="button" className={`${s.filter} ${filter ? s.active : ""}`}
            aria-label={`Filter by ${col.label}`} aria-expanded={open} onClick={() => setOpen(!open)}>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
              <path d="M1 2h10L7 6.5V10L5 11V6.5z" fill="currentColor" />
            </svg>
          </button>
          {open && <ColumnFilterMenu col={col} filter={filter} source={source} onApply={onFilter} onClose={close} />}
        </>
      )}
      <ColumnResizeHandle label={col.label} minWidth={min} maxWidth={MAX_COLUMN_WIDTH}
        readWidth={readWidth} onPreview={onPreviewWidth} onCommit={onCommitWidth} onFit={fit} guide={getGuideRect} view={resizeView} />
    </span>
  );
}
