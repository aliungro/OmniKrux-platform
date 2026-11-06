import { useCallback, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { flatten, type Territory } from "./model";
import { ClusterBand } from "./ClusterBand";
import { COLUMNS, PodRow } from "./PodRow";
import s from "./TerritoryTable.module.css";

const BAND_HEIGHT = 52;
const ROW_HEIGHT = 36;
const OVERSCAN = 10;

export function TerritoryTable({
  territories,
  onRetry,
}: {
  territories: Territory[];
  onRetry: (clusterId: string) => void;
}) {
  const items = useMemo(() => flatten(territories), [territories]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const estimateSize = useCallback((i: number) => (items[i].type === "band" ? BAND_HEIGHT : ROW_HEIGHT), [items]);
  const getItemKey = useCallback((i: number) => {
    const it = items[i];
    return it.type === "band" ? `band:${it.t.cluster.id}` : `row:${it.row.cluster_id}/${it.row.uid}`;
  }, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    paddingEnd: 16,
  });
  const now = new Date();

  return (
    <div ref={scrollRef} className={s.scroll}>
      <div role="table" aria-label="Pods by cluster" aria-rowcount={items.length + 1} className={s.table}>
        <div role="rowgroup" className={s.head}>
          <div role="row" aria-rowindex={1} className={s.cols}>
            {COLUMNS.map((c) => <span key={c} role="columnheader">{c}</span>)}
          </div>
        </div>
        <div role="rowgroup" className={s.body} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const it = items[v.index];
            const rowIndex = v.index + 2;
            return (
              <div key={v.key} role="presentation" className={s.item} style={{ height: v.size, transform: `translateY(${v.start}px)` }}>
                {it.type === "band" ? (
                  <ClusterBand t={it.t} onRetry={onRetry} rowIndex={rowIndex} />
                ) : (
                  <PodRow
                    row={it.row}
                    provider={it.provider}
                    last={items[v.index + 1]?.type !== "row"}
                    rowIndex={rowIndex}
                    now={now}
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
