import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ClusterState, KindInfo, OwnerRef, ResourceRow } from "../../api/types";
import { rowShortcut } from "../chrome/shortcuts";
import { Inspector } from "../inspector/Inspector";
import { flatten, kindTitle, rowKey, type RowRef, type Selection, type Territory } from "./model";
import { gridTemplate, minTableWidth } from "./cells";
import { ClusterBand } from "./ClusterBand";
import { ResourceRowView } from "./ResourceRowView";
import rv from "./ResourceRowView.module.css";
import s from "./TerritoryTable.module.css";

const BAND_HEIGHT = 52;
const ROW_HEIGHT = 36;
/** First guess for the inspector; the virtualizer measures the real height once it renders. */
const INSPECTOR_ESTIMATE = 360;
/** The sticky column header's height; keep in step with `.cols` in TerritoryTable.module.css. */
const HEADER_HEIGHT = 30;
const OVERSCAN = 10;

export interface TerritoryTableProps {
  territories: Territory[];
  kind: KindInfo;
  /** The current row and whether its details are open; held by Console so other views can set it. */
  selection: Selection;
  onSelection: Dispatch<SetStateAction<Selection>>;
  onRetry: (clusterId: string, state: ClusterState) => void;
  /** Live pods per node per cluster, for the Nodes view's Pods column. */
  podCounts?: Map<string, Map<string, number>> | null;
  /** `previous`: the run before the last restart (the `p` key). */
  onOpenLogs?: (row: ResourceRow, previous?: boolean) => void;
  onOpenShell?: (row: ResourceRow) => void;
  onNodeShell?: (row: ResourceRow, node: string) => void;
  onOwnerLogs?: (row: ResourceRow, owner: OwnerRef) => void;
}

function sameRef(a: RowRef | null, b: RowRef): boolean {
  return a !== null && a.clusterId === b.clusterId && a.uid === b.uid;
}

/** A cluster in one of these states hides its rows until it's live again; they're not gone. */
const NOT_LIVE: ReadonlySet<ClusterState> = new Set(["syncing", "error", "unknown"]);

/**
 * Memoized: Console passes stable props, so a change elsewhere on the page (the dock, a dialog)
 * doesn't re-render the table.
 */
export const TerritoryTable = memo(function TerritoryTable({
  territories,
  kind,
  selection,
  onSelection,
  onRetry,
  podCounts = null,
  onOpenLogs,
  onOpenShell,
  onNodeShell,
  onOwnerLogs,
}: TerritoryTableProps) {
  const { selected, open } = selection;
  // Ruling R11: only pods have details for now; other kinds' rows select but don't open.
  const inspectable = kind.key === "pods";
  const items = useMemo(
    () => flatten(territories, open && inspectable ? selected : null),
    [territories, open, inspectable, selected],
  );
  const indexByKey = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((it, i) => {
      if (it.type === "row") m.set(rowKey(it.row.cluster_id, it.row.uid), i);
    });
    return m;
  }, [items]);
  const selectedKey = selected ? rowKey(selected.clusterId, selected.uid) : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Set when the keyboard moved the selection; the row takes focus once it has rendered. */
  const focusPending = useRef(false);
  /**
   * Set when the keyboard moved the selection; the row is scrolled into view after the items are
   * rebuilt. Not before: an open inspector moves with the selection, which shifts every index after it.
   */
  const scrollPending = useRef(false);

  const estimateSize = useCallback((i: number) => {
    const t = items[i].type;
    return t === "band" ? BAND_HEIGHT : t === "row" ? ROW_HEIGHT : INSPECTOR_ESTIMATE;
  }, [items]);
  const getItemKey = useCallback((i: number) => {
    const it = items[i];
    if (it.type === "band") return `band:${it.t.cluster.id}`;
    return `${it.type}:${rowKey(it.row.cluster_id, it.row.uid)}`;
  }, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    paddingEnd: 16,
    // The body starts below the sticky header, which also covers the top of the viewport.
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
  });
  const now = new Date();

  const select = useCallback((row: ResourceRow) => {
    const ref = { clusterId: row.cluster_id, uid: row.uid };
    onSelection((prev) => (sameRef(prev.selected, ref) ? prev : { ...prev, selected: ref }));
  }, [onSelection]);

  const toggle = useCallback((row: ResourceRow) => {
    const ref = { clusterId: row.cluster_id, uid: row.uid };
    onSelection((prev) => ({ selected: ref, open: !(prev.open && sameRef(prev.selected, ref)) }));
  }, [onSelection]);

  const close = useCallback(() => {
    onSelection((prev) => (prev.open ? { ...prev, open: false } : prev));
    focusPending.current = true;
  }, [onSelection]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const shortcut = rowShortcut(e.key);
    if (!shortcut) return;
    if (shortcut.id === "close") {
      if (!open) return;
      e.preventDefault();
      close();
      return;
    }
    // Everything else acts on a focused row, never on keys typed inside the inspector.
    const key = (e.target as HTMLElement).dataset?.rowKey;
    const at = key === undefined ? undefined : indexByKey.get(key);
    if (at === undefined) return;
    const it = items[at];
    if (it.type !== "row") return;
    // Ruling R14: details, logs and shells are pods' only, until per-kind meanings arrive.
    if (shortcut.podsOnly && !inspectable) return;
    switch (shortcut.id) {
      case "move": {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        let i = at + step;
        while (i >= 0 && i < items.length && items[i].type !== "row") i += step;
        const next = items[i];
        if (next?.type !== "row") return;
        select(next.row);
        focusPending.current = true;
        scrollPending.current = true;
        return;
      }
      case "details":
        e.preventDefault();
        toggle(it.row);
        return;
      case "logs":
      case "previousLogs":
        if (onOpenLogs) {
          e.preventDefault();
          select(it.row);
          onOpenLogs(it.row, shortcut.id === "previousLogs");
        }
        return;
      case "shell":
        if (onOpenShell) {
          e.preventDefault();
          select(it.row);
          onOpenShell(it.row);
        }
        return;
    }
  };

  // Bring the selected row into view, then focus it once the virtualizer has rendered it.
  useLayoutEffect(() => {
    if (selectedKey === null) return;
    const at = indexByKey.get(selectedKey);
    if (at === undefined) {
      focusPending.current = false;
      scrollPending.current = false;
      // Its cluster is reconnecting: the row is hidden, not gone. Keep it selected, details open,
      // so both come back with it.
      const home = territories.find((t) => t.cluster.id === selected?.clusterId);
      if (home && NOT_LIVE.has(home.state)) return;
      // Deleted or filtered out on a live cluster: nothing left to inspect.
      if (open) onSelection((prev) => (prev.open ? { ...prev, open: false } : prev));
      return;
    }
    if (scrollPending.current) {
      scrollPending.current = false;
      virtualizer.scrollToIndex(at, { align: "auto" });
    }
    if (!focusPending.current) return;
    const el = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? [])
      .find((n) => n.dataset.rowKey === selectedKey);
    if (!el) return;
    focusPending.current = false;
    el.focus({ preventScroll: true });
  });

  // One row takes Tab focus: the selected one while it's shown, else the first row.
  const tabKey = selectedKey !== null && indexByKey.has(selectedKey) ? selectedKey : indexByKey.keys().next().value;
  const margin = virtualizer.options.scrollMargin;
  const columns = kind.columns;
  const tableStyle = useMemo(
    () => ({ "--cols": gridTemplate(columns), minWidth: minTableWidth(columns) }) as CSSProperties,
    [columns],
  );

  return (
    <div ref={scrollRef} className={s.scroll} onKeyDown={onKeyDown}>
      <div
        role="grid"
        aria-label={`${kindTitle(kind)} by cluster`}
        aria-rowcount={items.length + 1}
        className={s.table}
        style={tableStyle}
      >
        <div role="rowgroup" className={s.head}>
          <div role="row" aria-rowindex={1} className={`${rv.grid} ${s.cols}`}>
            {columns.map((c) => <span key={c.key} role="columnheader">{c.label}</span>)}
          </div>
        </div>
        <div role="rowgroup" className={s.body} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const it = items[v.index];
            const rowIndex = v.index + 2;
            const last = items[v.index + 1]?.type === "band" || v.index === items.length - 1;
            if (it.type === "inspector") {
              return (
                <div
                  key={v.key}
                  ref={virtualizer.measureElement}
                  data-index={v.index}
                  role="row"
                  aria-rowindex={rowIndex}
                  className={`${s.item} ${s.inspRow}${last ? ` ${s.last}` : ""}`}
                  style={{ transform: `translateY(${v.start - margin}px)` }}
                >
                  <div role="gridcell" aria-colspan={columns.length}>
                    <Inspector
                      row={it.row}
                      provider={it.provider}
                      onOpenLogs={onOpenLogs}
                      onOpenShell={onOpenShell}
                      onNodeShell={onNodeShell}
                      onOwnerLogs={onOwnerLogs}
                      onClose={close}
                    />
                  </div>
                </div>
              );
            }
            const key = it.type === "row" ? rowKey(it.row.cluster_id, it.row.uid) : null;
            return (
              <div key={v.key} role="presentation" className={s.item} style={{ height: v.size, transform: `translateY(${v.start - margin}px)` }}>
                {it.type === "band" ? (
                  <ClusterBand t={it.t} kind={kind} onRetry={onRetry} rowIndex={rowIndex} />
                ) : (
                  <ResourceRowView
                    row={it.row}
                    kind={kind}
                    provider={it.provider}
                    last={last}
                    rowIndex={rowIndex}
                    now={now}
                    selected={key === selectedKey}
                    expanded={inspectable ? open && key === selectedKey : undefined}
                    focusable={key === tabKey}
                    podCounts={podCounts}
                    onActivate={inspectable ? toggle : select}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
