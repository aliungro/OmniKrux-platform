import { useCallback, useRef, type ReactNode } from "react";
import { ColumnResizeHandle } from "../tables/ColumnResizeHandle";
import { MAX_COLUMN_WIDTH, useColumnWidths } from "../tables/columnWidths";
import { fitColumnWidth, measureColumn } from "../tables/fitColumn";
import s from "./ResizableInspectorTable.module.css";

export interface InspectorColumn {
  key: string;
  label: string;
  minWidth?: number;
  /** A preferred width in the unresized table's automatic layout. */
  defaultWidth?: number;
}

/** A header with a stable `readWidth`, so its handle keeps one ResizeObserver across renders. */
function InspectorColumnHeader({ columnKey, label, minWidth, view, previewWidth, commitWidth, getGuideRect }: {
  columnKey: string;
  label: string;
  minWidth: number;
  view: string;
  getGuideRect: () => DOMRect | null;
} & Pick<ReturnType<typeof useColumnWidths>, "previewWidth" | "commitWidth">) {
  const header = useRef<HTMLTableCellElement>(null);
  const readWidth = useCallback(() => header.current?.getBoundingClientRect().width ?? minWidth, [minWidth]);
  return (
    <th ref={header} scope="col" aria-label={label} style={{ minWidth }}>
      <span data-column-label className={s.label}>{label}</span>
      <ColumnResizeHandle
        label={label}
        minWidth={minWidth}
        maxWidth={MAX_COLUMN_WIDTH}
        readWidth={readWidth}
        onPreview={width => previewWidth(columnKey, width)}
        onCommit={width => commitWidth(columnKey, width)}
        onFit={() => fitColumnWidth(measureColumn(header.current!), minWidth, MAX_COLUMN_WIDTH)}
        guide={getGuideRect}
        view={view}
      />
    </th>
  );
}

export function ResizableInspectorTable({ tableKey, columns, className, label, view, children }: {
  tableKey: string;
  columns: readonly InspectorColumn[];
  className: string;
  label?: string;
  view?: string;
  children: ReactNode;
}) {
  const { widths, previewWidth, commitWidth } = useColumnWidths(tableKey);
  const scroll = useRef<HTMLDivElement>(null);
  const getGuideRect = useCallback(() => scroll.current?.getBoundingClientRect() ?? null, []);
  const tracks = columns.map(column => {
    const minWidth = column.minWidth ?? 64;
    const saved = widths.get(column.key);
    return { ...column, minWidth, width: saved === undefined ? undefined : Math.max(minWidth, saved) };
  });
  const fixed = tracks.some(track => track.width !== undefined);
  const allFixed = fixed && tracks.every(track => track.width !== undefined);
  // Fixed layout divides remaining space equally among automatic columns. Reserve
  // the largest remaining minimum for each automatic column to respect all minimums.
  const autoMin = Math.max(0, ...tracks.map(track => track.width === undefined ? track.minWidth : 0));
  const total = tracks.reduce((sum, track) => sum + (track.width ?? (fixed ? autoMin : track.minWidth)), 0);

  return (
    <div ref={scroll} className={s.scroll}>
      <table
        className={className}
        aria-label={label}
        style={{ minWidth: total, width: allFixed ? total : "100%", tableLayout: fixed ? "fixed" : undefined }}
      >
        <colgroup>
          {tracks.map(track => (
            <col key={track.key} style={{ width: fixed ? track.width : track.defaultWidth }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {tracks.map(({ key, label, minWidth }) => (
              <InspectorColumnHeader key={key} columnKey={key} label={label} minWidth={minWidth}
                view={view ?? tableKey} previewWidth={previewWidth} commitWidth={commitWidth} getGuideRect={getGuideRect} />
            ))}
          </tr>
        </thead>
        {children}
      </table>
    </div>
  );
}
