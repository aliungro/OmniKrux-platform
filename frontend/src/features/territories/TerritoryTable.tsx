import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ResourceRow } from "../../api/types";
import { Inspector } from "../inspector/Inspector";
import { flatten, type RowRef, type Territory } from "./model";
import { ClusterBand } from "./ClusterBand";
import { COLUMN_COUNT, COLUMNS, PodRow, rowKey } from "./PodRow";
import pr from "./PodRow.module.css";
import s from "./TerritoryTable.module.css";

const BAND_HEIGHT = 52;
const ROW_HEIGHT = 36;
/** First guess for the inspector; the virtualizer measures the real height once it renders. */
const INSPECTOR_ESTIMATE = 360;
/** The sticky column header's height; keep in step with `.cols` in TerritoryTable.module.css. */
const HEADER_HEIGHT = 30;
const OVERSCAN = 10;

export function TerritoryTable({
  territories,
  onRetry,
  onOpenLogs,
  onOpenShell,
}: {
  territories: Territory[];
  onRetry: (clusterId: string) => void;
  onOpenLogs?: (row: ResourceRow) => void;
  onOpenShell?: (row: ResourceRow) => void;
}) {
  const [selected, setSelected] = useState<RowRef | null>(null);
  const [open, setOpen] = useState(false);
  const items = useMemo(() => flatten(territories, open ? selected : null), [territories, open, selected]);
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

  const select = useCallback((row: ResourceRow) => setSelected({ clusterId: row.cluster_id, uid: row.uid }), []);

  const toggle = useCallback((row: ResourceRow) => {
    const same = selected?.clusterId === row.cluster_id && selected.uid === row.uid;
    select(row);
    setOpen(!(open && same));
  }, [open, select, selected]);

  const close = useCallback(() => {
    setOpen(false);
    focusPending.current = true;
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
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
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        let i = at + step;
        while (i >= 0 && i < items.length && items[i].type !== "row") i += step;
        const next = items[i];
        if (next?.type !== "row") return;
        select(next.row);
        focusPending.current = true;
        virtualizer.scrollToIndex(i, { align: "auto" });
        return;
      }
      case "Enter":
      case "d":
        e.preventDefault();
        toggle(it.row);
        return;
      case "l":
        if (onOpenLogs) {
          e.preventDefault();
          select(it.row);
          onOpenLogs(it.row);
        }
        return;
      case "s":
        if (onOpenShell) {
          e.preventDefault();
          select(it.row);
          onOpenShell(it.row);
        }
        return;
    }
  };

  // Move focus to the selected row once the virtualizer has rendered it.
  useLayoutEffect(() => {
    if (!focusPending.current || selectedKey === null) return;
    const el = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? [])
      .find((n) => n.dataset.rowKey === selectedKey);
    if (!el) return;
    focusPending.current = false;
    el.focus({ preventScroll: true });
  });

  // One row takes Tab focus: the selected one while it's shown, else the first row.
  const tabKey = selectedKey !== null && indexByKey.has(selectedKey) ? selectedKey : indexByKey.keys().next().value;
  const margin = virtualizer.options.scrollMargin;

  return (
    <div ref={scrollRef} className={s.scroll} onKeyDown={onKeyDown}>
      <div role="grid" aria-label="Pods by cluster" aria-rowcount={items.length + 1} className={s.table}>
        <div role="rowgroup" className={s.head}>
          <div role="row" aria-rowindex={1} className={`${pr.grid} ${s.cols}`}>
            {COLUMNS.map((c) => <span key={c} role="columnheader">{c}</span>)}
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
                  <div role="gridcell" aria-colspan={COLUMN_COUNT}>
                    <Inspector
                      row={it.row}
                      provider={it.provider}
                      onOpenLogs={onOpenLogs}
                      onOpenShell={onOpenShell}
                      onClose={close}
                    />
                  </div>
                </div>
              );
            }
            return (
              <div key={v.key} role="presentation" className={s.item} style={{ height: v.size, transform: `translateY(${v.start - margin}px)` }}>
                {it.type === "band" ? (
                  <ClusterBand t={it.t} onRetry={onRetry} rowIndex={rowIndex} />
                ) : (
                  <PodRow
                    row={it.row}
                    provider={it.provider}
                    last={last}
                    rowIndex={rowIndex}
                    now={now}
                    selected={rowKey(it.row.cluster_id, it.row.uid) === selectedKey}
                    expanded={open && rowKey(it.row.cluster_id, it.row.uid) === selectedKey}
                    focusable={rowKey(it.row.cluster_id, it.row.uid) === tabKey}
                    onActivate={toggle}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
