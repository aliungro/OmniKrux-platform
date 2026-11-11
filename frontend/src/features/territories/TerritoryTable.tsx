import { ColumnHeader } from "./ColumnHeader";
import type { ColumnFilter, SortSpec } from "./columnFilters";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type SetStateAction,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MetricsLookup } from "../../api/useMetrics";
import type { ClusterState, KindInfo, OwnerRef, ResourceRow } from "../../api/types";
import { rowActions, TOOL_LABEL, type RowAction, type ToolId } from "../actions/tools";
import { useStartAction } from "../actions/useActions";
import { pageKey, pressed, rowShortcut } from "../chrome/shortcuts";
import { routesPageKeys } from "../chrome/pageKeys";
import { ContextMenu, isMenuKey, menuAnchor, type MenuAnchor, type MenuItem } from "../chrome/ContextMenu";
import { Inspector, type WorkloadLogs } from "../inspector/Inspector";
import type { ToolIntent } from "../inspector/Tools";
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
  initialScrollTop?: number;
  onScroll?: (top: number) => void;
  onMissingSelection?: () => void;
  columnFilters?: readonly ColumnFilter[];
  sort?: SortSpec | null;
  onColumnFilter?: (key: string, f: ColumnFilter | null) => void;
  onSort?: (s: SortSpec | null) => void;
  pickSource?: Territory[];
  kind: KindInfo;
  /** The current row and whether its details are open; held by Console so other views can set it. */
  selection: Selection;
  onSelection: Dispatch<SetStateAction<Selection>>;
  onRetry: (clusterId: string, state: ClusterState) => void;
  /** Live pods per node per cluster, for the Nodes view's Pods column. */
  podCounts?: Map<string, Map<string, number>> | null;
  /** Live CPU and memory per row (pods and nodes); null for kinds without them. */
  metrics?: MetricsLookup | null;
  /** `previous`: the run before the last restart (the `p` key). */
  onOpenLogs?: (row: ResourceRow, previous?: boolean) => void;
  onOpenShell?: (row: ResourceRow) => void;
  onNodeShell?: (row: ResourceRow, node: string) => void;
  onOwnerLogs?: (row: ResourceRow, owner: OwnerRef) => void;
  /** Logs of every pod a workload row selects (deployments, stateful sets, daemon sets). */
  onWorkloadLogs?: WorkloadLogs;
  /**
   * An action asked for elsewhere (the command palette) on a row: run as its key would, once per
   * `seq`, if the row is still on screen.
   */
  request?: RowRequest | null;
  /**
   * Goes up by one when a link lands on the selected row: the table scrolls it (and its details)
   * into view, and focuses it unless you've moved focus outside the table meanwhile.
   */
  reveal?: number;
  onOpenSplit?: (row: ResourceRow) => void;
  menuView?: unknown;
  paneActive?: boolean;
}

/** An action on a row, by its `rowKey`; `seq` tells two asks apart. */
export interface RowRequest {
  key: string;
  action: RowAction;
  seq: number;
}

function sameRef(a: RowRef | null, b: RowRef): boolean {
  return a !== null && a.clusterId === b.clusterId && a.uid === b.uid;
}

/** A cluster in one of these states hides its rows until it's live again; they're not gone. */
const NOT_LIVE: ReadonlySet<ClusterState> = new Set(["syncing", "error", "unknown"]);

const ROW_MENU_LABELS: Partial<Record<RowAction, string>> = {
  details: "Details", yaml: "YAML", logs: "Logs", previousLogs: "Previous logs",
  workloadLogs: "Logs", shell: "Shell", reveal: "Show secret keys",
};

function verbsFor(kind: KindInfo, row: ResourceRow): readonly string[] {
  return kind.verbs_by_cluster?.[row.cluster_id] ?? kind.verbs;
}

/**
 * Memoized: Console passes stable props, so a change elsewhere on the page (the dock, a dialog)
 * doesn't re-render the table.
 */
export const TerritoryTable = memo(function TerritoryTable({
  territories, initialScrollTop = 0, onScroll, onMissingSelection,
  columnFilters = [], sort = null, onColumnFilter = () => {}, onSort = () => {}, pickSource = territories,
  kind,
  selection,
  onSelection,
  onRetry,
  podCounts = null,
  metrics = null,
  onOpenLogs,
  onOpenShell,
  onNodeShell,
  onOwnerLogs,
  onWorkloadLogs,
  request = null,
  reveal = 0,
  onOpenSplit,
  menuView,
  paneActive = true,
}: TerritoryTableProps) {
  const { selected, open } = selection;
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
  const restored = useRef(false);
  /** Set when the keyboard moved the selection; the row takes focus once it has rendered. */
  const focusPending = useRef(false);
  /**
   * Set when the keyboard moved the selection; the row is scrolled into view after the items are
   * rebuilt. Not before: an open inspector moves with the selection, which shifts every index after it.
   */
  const scrollPending = useRef(false);
  /** How the pending scroll lines the row up: a link's target goes to the top, so its details show. */
  const scrollAlign = useRef<"auto" | "start">("auto");
  const revealed = useRef(reveal);
  /** A key pressed on a row that its details carry out: a change tool, the YAML tab, a workload's logs. */
  const [intent, setIntent] = useState<(ToolIntent & { key: string }) | null>(null);
  const [rowMenu, setRowMenu] = useState<{ key: string; anchor: MenuAnchor; view: unknown; kind: string } | null>(null);
  const intentDone = useCallback(() => setIntent(null), []);
  const can = {
    change: useStartAction() !== null,
    logs: onOpenLogs !== undefined,
    shell: onOpenShell !== undefined,
    workloadLogs: onWorkloadLogs !== undefined,
  };

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

  /**
   * Runs what a row's key means (or the palette asked for): the details, the dock's logs and
   * shells, or, through the details, the YAML tab and the change tools, each reviewed first.
   */
  const act = (row: ResourceRow, action: RowAction, from: "key" | "menu" | "palette") => {
    const ref = { clusterId: row.cluster_id, uid: row.uid };
    switch (action) {
      case "details":
        if (from === "key") toggle(row);
        else onSelection({ selected: ref, open: true });
        return;
      case "logs":
      case "previousLogs":
        select(row);
        onOpenLogs?.(row, action === "previousLogs");
        return;
      case "shell":
        select(row);
        onOpenShell?.(row);
        return;
      default: {
        const key = rowKey(row.cluster_id, row.uid);
        onSelection({ selected: ref, open: true });
        setIntent((prev) => ({ key, tool: action, seq: (prev?.seq ?? 0) + 1 }));
      }
    }
  };
  const actRef = useRef(act);
  actRef.current = act;

  const rowAt = (key: string) => {
    const index = indexByKey.get(key);
    const item = index === undefined ? undefined : items[index];
    return item?.type === "row" ? item.row : null;
  };
  const openRowMenu = (trigger: HTMLElement, point?: { clientX: number; clientY: number }) => {
    const key = trigger.dataset.rowKey;
    if (!key || !indexByKey.has(key)) return false;
    setRowMenu({ key, anchor: menuAnchor(trigger, point), view: menuView, kind: kind.key });
    return true;
  };
  const restoreRowFocus = (trigger?: HTMLElement) => {
    const fallback = scrollRef.current?.querySelector<HTMLElement>('[data-row-key][tabindex="0"]');
    (trigger?.isConnected ? trigger : fallback ?? scrollRef.current)?.focus({ preventScroll: true });
  };
  const menuRow = rowMenu ? rowAt(rowMenu.key) : null;
  const menuMatchesView = rowMenu?.view === menuView && rowMenu?.kind === kind.key;
  const menuItems: MenuItem[] = [];
  if (rowMenu && menuRow && menuMatchesView && paneActive) {
    for (const action of rowActions(kind.key, verbsFor(kind, menuRow), menuRow, can)) {
      menuItems.push({
        id: action,
        label: ROW_MENU_LABELS[action] ?? TOOL_LABEL[action as ToolId],
        danger: action === "delete" || action === "drain" || action === "evict",
        onSelect: () => {
          const current = rowAt(rowMenu.key);
          if (current && rowMenu.anchor.trigger.isConnected) act(current, action, "menu");
        },
      });
    }
    if (onOpenSplit) menuItems.push({
      id: "open-split", label: "Open in new split tab", divider: menuItems.length > 0, restoreFocus: false,
      onSelect: () => {
        const current = rowAt(rowMenu.key);
        if (current && rowMenu.anchor.trigger.isConnected) onOpenSplit(current);
      },
    });
  }
  useLayoutEffect(() => {
    if (!rowMenu) return;
    if (paneActive && menuRow && menuMatchesView && rowMenu.anchor.trigger.isConnected) return;
    setRowMenu(null);
    if (paneActive) restoreRowFocus(rowMenu.anchor.trigger);
  });

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('a, button, input, textarea, select, [contenteditable]')) return;
    const trigger = e.target.closest<HTMLElement>("[data-row-key]");
    if (trigger && e.currentTarget.contains(trigger) && openRowMenu(trigger, e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // The palette's ask, once, on the row as it is now (never one that has gone meanwhile).
  const asked = useRef(request?.seq ?? 0);
  useEffect(() => {
    if (request === null || request.seq === asked.current) return;
    asked.current = request.seq;
    const at = indexByKey.get(request.key);
    const it = at === undefined ? undefined : items[at];
    if (it?.type === "row") actRef.current(it.row, request.action, "palette");
  }, [request, indexByKey, items]);

  const runRowKey = (e: KeyboardEvent<HTMLDivElement> | globalThis.KeyboardEvent, at: number | undefined, fromPage = false) => {
    // Escape closes the details from the row or from inside them.
    if (pressed("close", e)) {
      if (!open) return;
      e.preventDefault();
      close();
      return;
    }
    if (at === undefined) return;
    const it = items[at];
    if (it.type !== "row") return;
    // The key means what this kind gives it (`s`: a pod's shell, a deployment's scale, a node's
    // shell), among what this row offers (a node has the one of cordon and uncordon that applies).
    const id = rowShortcut(e, kind.key, rowActions(kind.key, verbsFor(kind, it.row), it.row, can));
    if (id === undefined) return;
    e.preventDefault();
    if (fromPage) {
      const key = rowKey(it.row.cluster_id, it.row.uid);
      const el = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-row-key]") ?? [])
        .find((n) => n.dataset.rowKey === key);
      if (el) el.focus({ preventScroll: true });
      else {
        focusPending.current = true;
        virtualizer.scrollToIndex(at, { align: "auto" });
      }
    }
    // A held `x` must not walk on into the secret's keys and reveal one (audited) by itself.
    if (id === "reveal" && e.repeat) return;
    if (id === "move") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      let i = at + step;
      while (i >= 0 && i < items.length && items[i].type !== "row") i += step;
      const next = items[i];
      if (next?.type !== "row") return;
      select(next.row);
      focusPending.current = true;
      scrollPending.current = true;
      scrollAlign.current = "auto";
      return;
    }
    act(it.row, id as RowAction, "key");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Everything except Escape acts on a focused row, never on keys inside the details.
    const target = e.target as HTMLElement;
    const key = target.dataset?.rowKey;
    if (key && isMenuKey(e) && openRowMenu(target)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    runRowKey(e, key === undefined ? undefined : indexByKey.get(key));
  };

  const onPageKey = (e: globalThis.KeyboardEvent) => {
    if (!paneActive || !pageKey(e) || !routesPageKeys(e.target)) return;
    // Keep native activation and navigation on chrome controls (including nested button icons).
    if (["Enter", " ", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
      && e.target instanceof Element
      && e.target.closest('button, a[href], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], summary')) return;
    const at = selectedKey === null ? undefined : indexByKey.get(selectedKey);
    if (at === undefined && pressed("move", e)) {
      const step = e.key === "ArrowDown" ? 1 : -1;
      let edge = step === 1 ? 0 : items.length - 1;
      while (edge >= 0 && edge < items.length && items[edge].type !== "row") edge += step;
      const it = items[edge];
      if (it?.type !== "row") return;
      e.preventDefault();
      focusPending.current = true;
      scrollPending.current = true;
      scrollAlign.current = "auto";
      select(it.row);
      return;
    }
    runRowKey(e, at, true);
  };
  const pageKeyRef = useRef(onPageKey);
  pageKeyRef.current = onPageKey;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => pageKeyRef.current(e);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useLayoutEffect(() => {
    if (restored.current || !territories.some(t => t.state === "ready" && t.rows.length > 0)) return;
    restored.current = true;
    const index = selectedKey === null ? undefined : indexByKey.get(selectedKey);
    if (index !== undefined) virtualizer.scrollToIndex(index, { align: "auto" });
    else if (scrollRef.current) scrollRef.current.scrollTop = initialScrollTop;
  }, [territories, selectedKey, indexByKey, virtualizer, initialScrollTop]);

  // Bring the selected row into view, then focus it once the virtualizer has rendered it.
  useLayoutEffect(() => {
    if (revealed.current !== reveal) {
      revealed.current = reveal;
      scrollPending.current = true;
      scrollAlign.current = "start";
      // A link you followed hands focus to its row, unless you've since moved on (the dock, a field).
      const active = document.activeElement;
      focusPending.current = active === null || active === document.body || (scrollRef.current?.contains(active) ?? false);
    }
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
      if (open) { if (onMissingSelection) onMissingSelection(); else onSelection((prev) => (prev.open ? { ...prev, open: false } : prev)); }
      return;
    }
    if (scrollPending.current) {
      scrollPending.current = false;
      virtualizer.scrollToIndex(at, { align: scrollAlign.current });
      scrollAlign.current = "auto";
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
  const titleKey = kind.key === "helm-releases" ? "release" : "name";
  const tableStyle = useMemo(
    () => ({ "--cols": gridTemplate(columns, titleKey), minWidth: minTableWidth(columns, titleKey) }) as CSSProperties,
    [columns, titleKey],
  );

  return (
    <div ref={scrollRef} className={s.scroll} tabIndex={-1} onKeyDown={onKeyDown} onContextMenu={onContextMenu}
      onScroll={(e) => {
        onScroll?.(e.currentTarget.scrollTop);
        if (!rowMenu) return;
        const trigger = rowMenu.anchor.trigger;
        const viewport = e.currentTarget.getBoundingClientRect();
        const bounds = trigger.getBoundingClientRect();
        if (!trigger.isConnected || bounds.bottom <= viewport.top + HEADER_HEIGHT || bounds.top >= viewport.bottom
          || bounds.right <= viewport.left || bounds.left >= viewport.right) {
          setRowMenu(null);
          restoreRowFocus();
        }
      }}>
      <div
        role="grid"
        aria-label={`${kindTitle(kind)} by cluster`}
        aria-rowcount={items.length + 1}
        className={s.table}
        style={tableStyle}
      >
        <div role="rowgroup" className={s.head}>
          <div role="row" aria-rowindex={1} className={`${rv.grid} ${s.cols}`}>
            {columns.map((c) => <ColumnHeader key={c.key} col={c} filter={columnFilters.find(f => f.key === c.key)} sort={sort} source={pickSource} onFilter={f => onColumnFilter(c.key, f)} onSort={onSort} />)}
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
                      kindKey={kind.key}
                      verbs={verbsFor(kind, it.row)}
                      intent={intent?.key === rowKey(it.row.cluster_id, it.row.uid) ? intent : null}
                      onIntentDone={intentDone}
                      provider={it.provider}
                      paneActive={paneActive}
                      onOpenLogs={onOpenLogs}
                      onOpenShell={onOpenShell}
                      onNodeShell={onNodeShell}
                      onOwnerLogs={onOwnerLogs}
                      onWorkloadLogs={onWorkloadLogs}
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
                  <ClusterBand
                    t={it.t}
                    kind={kind}
                    onRetry={onRetry}
                    rowIndex={rowIndex}
                    metricsNote={metrics ? metrics.why(it.t.cluster.id) : null}
                  />
                ) : (
                  <ResourceRowView
                    row={it.row}
                    kind={kind}
                    provider={it.provider}
                    last={last}
                    rowIndex={rowIndex}
                    now={now}
                    selected={key === selectedKey}
                    expanded={open && key === selectedKey}
                    focusable={key === tabKey}
                    podCounts={podCounts}
                    metrics={metrics}
                    onActivate={toggle}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {rowMenu && menuRow && menuItems.length > 0 && (
        <ContextMenu anchor={rowMenu.anchor} label={`Actions for ${menuRow.name}`} items={menuItems}
          onClose={() => setRowMenu(null)} />
      )}
    </div>
  );
});
