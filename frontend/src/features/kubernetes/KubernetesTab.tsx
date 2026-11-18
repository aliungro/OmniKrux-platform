import { lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { retryCluster, useClusters } from "../../api/useClusters";
import { useCloudAccounts } from "../../api/useCloud";
import { refreshKinds, useKinds } from "../../api/useKinds";
import { useLiveMetrics } from "../../api/useMetrics";
import { useWatch } from "../../api/useWatch";
import { failure } from "../../api/http";
import type { Cluster, ClusterState, KindInfo, KindsResponse, OwnerRef, ResourceRow } from "../../api/types";
import type { RowAction } from "../../features/actions/tools";
import { FilterBar } from "../../features/chrome/FilterBar";
import { KindTabs } from "../../features/chrome/KindTabs";
import { NavigationNotice, NavigationProvider, useNavigator } from "../../features/navigation/navigation";
import {
  buildTerritories,
  chipsFor,
  countFilters,
  fallbackKind,
  isNoFilter,
  kindCount,
  namespacesIn,
  NO_FILTER,

  podsPerNode,
  rowKey,
  showingFilters,
  withDiscoveryFailures,
  type Filters,
  type Selection,
} from "../../features/territories/model";
import { ViewBoundary } from "../shell/lazyView";
import type { RowRequest } from "../../features/territories/TerritoryTable";
import { useNow } from "../../hooks/useNow";
import { ShellBridge } from "../shell/ShellBridge";
import { HOME, kindView, type ClosedTab, type KubeView } from "../shell/workspace";
import type { TabNav } from "../shell/browserHistory";
import type { useDock } from "../dock/useDock";
import { useFollowSelection } from "../dock/useFollowSelection";
import type { PaletteSelection } from "../palette/CommandPalette";
import { usePinnedKinds } from "../settings/pinnedKinds";
import { useAttentionLanding } from "../home/useAttentionLanding";
import { KubernetesHome } from "../home/KubernetesHome";
import s from "../../App.module.css";

/** The page's kinds, or undefined while GET /api/kinds hasn't answered (or answered with something else). */
function servedKinds(data: unknown): KindInfo[] | undefined {
  const kinds = (data as { kinds?: unknown } | undefined)?.kinds;
  return Array.isArray(kinds) ? (kinds as KindInfo[]) : undefined;
}

/** How each cluster's discovery went, from the same answer. */
function discovery(data: unknown): KindsResponse["clusters"] | undefined {
  const clusters = (data as { clusters?: unknown } | undefined)?.clusters;
  return clusters !== null && typeof clusters === "object" && !Array.isArray(clusters)
    ? (clusters as KindsResponse["clusters"])
    : undefined;
}

const NO_CLUSTERS: Cluster[] = [];
export const TEXT_COALESCE_MS = 1000;

/** The whole console page; expects a QueryClientProvider above it. */
export interface KubernetesTabProps {
  nav: TabNav<KubeView>;
  dock: ReturnType<typeof useDock>;
  closed: readonly ClosedTab<KubeView>[];
  onReopen(index: number): void;
  loadProblem: string | null;
  onDismissLoadProblem(): void;
  onEditPinned(): void;
  onOpenView?(view: KubeView, split?: boolean): void;
  paneActive?: boolean;
}

const TerritoryTable = lazy(() => import("../territories/TerritoryTable").then(m => ({ default: m.TerritoryTable })));

export function KubernetesTab({ nav, dock, closed, onReopen, loadProblem, onDismissLoadProblem, onEditPinned, onOpenView, paneActive = true }: KubernetesTabProps) {
  // Keep the shared Pods watch alive across the Home/Pods component handoff.
  // Otherwise the outgoing subscriber closes it between render and subscription,
  // briefly publishing retained rows before the new empty watch takes over.
  useWatch(nav.view.page === "home" || nav.view.kind === "pods" ? "pods" : null);
  return nav.view.page === "home"
    ? <KubernetesHome nav={nav} closed={closed} onReopen={onReopen} loadProblem={loadProblem} onDismissLoadProblem={onDismissLoadProblem} paneActive={paneActive} />
    : <KindView nav={nav} dock={dock} onEditPinned={onEditPinned} onOpenView={onOpenView} paneActive={paneActive} />;
}

function KindView({ nav: tabNav, dock, onEditPinned, onOpenView, paneActive }: Pick<KubernetesTabProps, "nav" | "dock" | "onEditPinned" | "onOpenView"> & { paneActive: boolean }) {
  const pinned = usePinnedKinds();
  const queryClient = useQueryClient();
  const clusters = useClusters();
  const list = clusters.data;
  const { refetch } = clusters;
  const knownClusterIds = useMemo(() => (list ? new Set(list.map((c) => c.id)) : undefined), [list]);

  const bridge = useContext(ShellBridge);
  const kindKey = tabNav.view.page === "kind" ? tabNav.view.kind : "pods";
  const accounts = useCloudAccounts(kindKey === "pods");
  const found = kindKey === "pods" && !accounts.isError && Array.isArray(accounts.data)
    ? accounts.data.reduce((count, account) => count + (account.counts?.new ?? 0), 0) : 0;
  const kinds = useKinds();
  const served = servedKinds(kinds.data);
  const discovered = discovery(kinds.data);
  // Without the list, only the kind you're on has a tab: say why, with a way to ask again.
  const kindsError = served === undefined && kinds.isError ? failure(kinds.error, "retry") : null;
  const { refetch: refetchKinds } = kinds;
  const onRetryKinds = useCallback(() => void refetchKinds(), [refetchKinds]);
  const kind = useMemo(() => served?.find((k) => k.key === kindKey) ?? fallbackKind(kindKey), [served, kindKey]);

  // The watch names clusters the moment the backend adds or drops them; reload the list then.
  const watch = useWatch(kindKey, {
    knownClusterIds,
    onUnknownCluster: () => void refetch(),
  });
  // The Nodes view's Pods column counts live pods per node.
  const podWatch = useWatch(kindKey === "nodes" ? "pods" : null);
  const podCounts = useMemo(() => (kindKey === "nodes" ? podsPerNode(podWatch) : null), [kindKey, podWatch]);
  // Pods and nodes have CPU and memory columns; polled only while one of those views is open.
  const metrics = useLiveMetrics(kindKey === "nodes" ? "nodes" : "pods", kindKey === "pods" || kindKey === "nodes");
  const now = useNow(60_000);

  const view = tabNav.view.page === "kind" ? tabNav.view : kindView(tabNav.view, "pods") as Extract<KubeView, {page:"kind"}>;
  const { filters } = view;
  const attention = view.fromAttention;
  const [tableReady, setTableReady] = useState(false);
  const tableMount = useCallback((element: HTMLDivElement | null) => setTableReady(element !== null), []);
  const landing = useAttentionLanding(attention, watch, list ? list.some(c => c.id === attention?.clusterId) : undefined, paneActive, tableReady);
  const held = !!attention && !landing.ready;
  const selection = useMemo<Selection>(() => ({ selected: held ? null : view.selected, open: !held && view.open }), [view.selected, view.open, held]);
  const latestSelection = useRef(selection);
  latestSelection.current = selection;
  const lastText = useRef(0);
  const lastTextView = useRef<KubeView | null>(null);
  useEffect(() => {
    if (lastTextView.current && lastTextView.current !== tabNav.view) {
      lastText.current = 0;
      lastTextView.current = null;
    }
  }, [tabNav.view]);
  const initialScrollTop = useRef(tabNav.scrollTop).current;
  const [scopeNotice, setScopeNotice] = useState<{text:string; view:KubeView} | null>(null);
  const scopeNoticeText = scopeNotice?.view === tabNav.view ? scopeNotice.text : null;
  const clusterNames = useRef(new Map<string, string>());
  useEffect(() => { list?.forEach(c => clusterNames.current.set(c.id, c.name)); }, [list]);
  useEffect(() => {
    if (!list || clusters.isError || view.clusters === null) return;
    const ids = new Set(list.map(c => c.id));
    const gone = view.clusters.filter(id => !ids.has(id));
    if (!gone.length) return;
    const rest = view.clusters.filter(id => ids.has(id));
    const names = gone.map(id => clusterNames.current.get(id) ?? id).join(", ");
    const text = rest.length ? `${names} ${gone.length === 1 ? "is" : "are"} gone from Omnikrux, so this tab shows the rest.` : `The ${gone.length === 1 ? "cluster" : "clusters"} this tab looked at ${gone.length === 1 ? "is" : "are"} gone from Omnikrux, so it shows every cluster.`;
    let next: KubeView | null = null;
    tabNav.navigate(v => {
      if (v.page !== "kind" || v.clusters !== view.clusters) return v;
      next = { ...v, clusters: rest.length ? rest : null };
      return next;
    }, "replace");
    if (next) setScopeNotice({ text, view: next });
  }, [list, clusters.isError, view.clusters, tabNav.navigate]);
  const scoped = useMemo(() => view.clusters === null ? list ?? NO_CLUSTERS : (list ?? NO_CLUSTERS).filter(c => view.clusters!.includes(c.id)), [list, view.clusters]);
  const setFilters = useCallback<React.Dispatch<React.SetStateAction<Filters>>>(next => {
    tabNav.navigate(v => v.page === "kind" ? { ...v, filters: typeof next === "function" ? next(v.filters) : next } : v, "replace");
  }, [tabNav.navigate]);
  const setSelection = useCallback<React.Dispatch<React.SetStateAction<Selection>>>(next => {
    tabNav.navigate(v => {
      if (v.page !== "kind") return v;
      const old = { selected: v.selected, open: v.open };
      const value = typeof next === "function" ? next(old) : next;
      return { ...v, ...value, fromAttention: undefined };
    }, "replace");
  }, [tabNav.navigate]);
  /** An action the palette asked for on the selected row. */
  const [rowRequest, setRowRequest] = useState<RowRequest | null>(null);
  // A kind without namespaces ignores the namespace you picked for another one (and keeps it for later).
  const effective = useMemo(
    () => (kind.namespaced || filters.namespace === null ? filters : { ...filters, namespace: null }),
    [kind.namespaced, filters],
  );

  // Unfiltered territories drive the scope tokens and every count, so counts never shrink as you filter.
  // A cluster that couldn't read the kind's API group says so instead of "doesn't serve" (Ruling R36).
  const all = useMemo(
    () => withDiscoveryFailures(buildTerritories(scoped, watch, NO_FILTER, now, kind), discovered, kind),
    [scoped, watch, now, kind, discovered],
  );
  const shown = useMemo(
    () =>
      isNoFilter(effective)
        ? all
        : withDiscoveryFailures(buildTerritories(scoped, watch, effective, now, kind), discovered, kind),
    [all, scoped, watch, effective, now, kind, discovered],
  );
  const chips = useMemo(() => chipsFor(kind), [kind]);
  const counts = useMemo(() => countFilters(all, now, kind), [all, now, kind]);
  const namespaces = useMemo(() => (kind.namespaced ? namespacesIn(all) : null), [kind.namespaced, all]);

  const { openPod, openFollow, openPinned, openOwnerLogs, openWorkloadLogs, askNodeShell } = dock;
  // L: the one follow log, on this pod; p: the run before the last restart, in a tab of its own.
  const onOpenLogs = useCallback(
    (row: ResourceRow, previous?: boolean) => (previous ? openPod(row, "logs", { previous: true }) : openFollow(row)),
    [openPod, openFollow],
  );
  const onOpenShell = useCallback((row: ResourceRow) => openPod(row, "shell"), [openPod]);
  const onNodeShell = useCallback((row: ResourceRow, node: string) => askNodeShell(row.cluster_id, node), [askNodeShell]);
  const onOwnerLogs = useCallback((row: ResourceRow, owner: OwnerRef) => openOwnerLogs(row, owner), [openOwnerLogs]);
  const onWorkloadLogs = useCallback(
    (row: ResourceRow, selector: string, opts?: { focus?: boolean }) => openWorkloadLogs(row, selector, opts),
    [openWorkloadLogs],
  );

  const onRetry = useCallback((id: string, state: ClusterState) => {
    // An absent kind may have been installed since: ask the clusters for their kinds again first
    // (the server otherwise answers from a 5-minute cache). The watch reports the cluster's new
    // state; a failed request leaves its band as it was.
    const first = state === "absent" ? refreshKinds(queryClient).catch((err: unknown) => {
      console.error("Refreshing the kinds failed:", err);
    }) : Promise.resolve();
    first
      .then(() => retryCluster(id))
      .catch((err: unknown) => console.error(`Retry for cluster ${id} failed:`, err));
  }, [queryClient]);

  // Links: a jump switches to the link's kind, then selects and opens its row once the watch has it.
  const onKind = useCallback((key: string) => tabNav.navigate(v => kindView(v,key), "push"), [tabNav.navigate]);
  const nav = useNavigator({
    kindKey,
    watch,
    clusters: list ?? NO_CLUSTERS,
    kinds: served,
    onKind,
    setFilters,
    setSelection,
    onLand: (row, landedKind, sameKind) => {
      lastText.current = 0;
      tabNav.navigate(v => v.page === "kind" ? { ...v, fromAttention: undefined, filters: showingFilters(row, v.filters, landedKind, new Date()), clusters: v.clusters === null || v.clusters.includes(row.cluster_id) ? v.clusters : [...v.clusters, row.cluster_id], selected: {clusterId: row.cluster_id, uid: row.uid}, open: true } : v, sameKind ? "push" : "replace");
    },
  });
  const { cancel: cancelJump } = nav;
  // Picking a row, a kind or a filter yourself drops a jump still waiting for its row.
  const onSelection = useCallback<typeof setSelection>((next) => {
    cancelJump();
    const previous = latestSelection.current;
    const value = typeof next === "function" ? next(previous) : next;
    latestSelection.current = value;
    lastText.current = 0;
    tabNav.navigate(v => v.page === "kind" ? { ...v, ...value, fromAttention: undefined } : v, previous.open !== value.open ? "push" : "replace");
  }, [cancelJump, tabNav.navigate]);
  const onFilters = useCallback((next: Filters) => {
    cancelJump();
    const textOnly = next.text !== filters.text && next.status === filters.status && next.namespace === filters.namespace && next.columns === filters.columns && next.sort === filters.sort;
    const now = Date.now();
    const mode = textOnly && lastText.current && now - lastText.current < TEXT_COALESCE_MS ? "replace" : "push";
    lastText.current = textOnly ? now : 0;
    tabNav.navigate(v => {
      if (v.page !== "kind") return v;
      const updated = { ...v, filters: next, fromAttention: undefined };
      lastTextView.current = textOnly ? updated : null;
      return updated;
    }, mode);
  }, [cancelJump, filters, tabNav.navigate]);
  const onMissingSelection = useCallback(() => {
    const id = selection.selected?.clusterId;
    if (id && (!Object.hasOwn(watch.rows, id) || Object.hasOwn(watch.pending, id))) return;
    setSelection(prev => ({...prev, open:false}));
  }, [selection.selected, watch.rows, watch.pending, setSelection]);
  const onColumnFilter = useCallback((key: string, f: import("../territories/columnFilters").ColumnFilter | null) => { cancelJump(); lastText.current = 0; tabNav.navigate(v => v.page === "kind" ? {...v, fromAttention: undefined, filters: {...v.filters, columns: [...v.filters.columns.filter(x => x.key !== key), ...(f ? [f] : [])]}} : v, "push"); }, [cancelJump, tabNav.navigate]);
  const onSort = useCallback((sort: import("../territories/columnFilters").SortSpec | null) => { cancelJump(); lastText.current = 0; tabNav.navigate(v => v.page === "kind" ? {...v, filters: {...v.filters, sort}} : v, "push"); }, [cancelJump, tabNav.navigate]);
  const onSelectKind = useCallback(
    (key: string, opts?: { replace: boolean }) => {
      cancelJump();
      if (key === kindKey) return;
      lastText.current = 0;
      tabNav.navigate(v => kindView(v,key), opts?.replace ? "replace" : "push");
    },
    [tabNav.navigate, cancelJump, kindKey],
  );
  const openRowSplit = useCallback((row: ResourceRow) => {
    onOpenView?.({
      ...kindView(HOME, kindKey, [row.cluster_id]),
      selected: { clusterId: row.cluster_id, uid: row.uid },
      open: true,
    }, true);
  }, [onOpenView, kindKey]);

  const selectedRow = useMemo(() => {
    const sel = selection.selected;
    if (sel === null) return null;
    for (const t of shown) {
      if (t.cluster.id !== sel.clusterId) continue;
      const row = t.rows.find((r) => r.uid === sel.uid);
      return row ? { row, cluster: t.cluster } : null;
    }
    return null;
  }, [selection.selected, shown]);
  // The follow log moves with this pane's selection once it settles.
  useFollowSelection({ active: paneActive && !held, kindKey, selected: selection.selected, watch, dock });
  const paletteSelection = useMemo<PaletteSelection | null>(
    () => (tableReady && selectedRow ? { ...selectedRow, kind } : null),
    [tableReady, selectedRow, kind],
  );
  const onRowAction = useCallback(
    (action: RowAction) => {
      if (!selectedRow) return;
      cancelJump();
      const key = rowKey(selectedRow.row.cluster_id, selectedRow.row.uid);
      setRowRequest((prev) => ({ key, action, seq: (prev?.seq ?? 0) + 1 }));
    },
    [selectedRow, cancelJump],
  );
  useEffect(() => {
    if (!paneActive) return;
    bridge.setScope(all);
    return () => bridge.setScope(null);
  }, [all, bridge.setScope, paneActive]);
  useEffect(() => {
    if (!paneActive) return;
    bridge.setPaletteTarget({ selection: paletteSelection, onKind: onSelectKind, onRowAction });
    return () => bridge.setPaletteTarget(null);
  }, [bridge.setPaletteTarget, paletteSelection, onSelectKind, onRowAction, paneActive]);
  const onAllKinds = () => document.dispatchEvent(new KeyboardEvent("keydown",{key:":",bubbles:true}));

  let body;
  if (list === undefined) {
    body = clusters.isError ? (
      <div className={s.note} role="alert">
        <span>Can't load clusters: {clusters.error.message}</span>
        <button type="button" className={s.btn} onClick={() => void clusters.refetch()}>
          Try again
        </button>
      </div>
    ) : (
      <div className={s.note} role="status">Loading clusters…</div>
    );
  } else if (list.length === 0) {
    body = (
      <><NavigationNotice text={scopeNoticeText} /><div className={s.note}>No clusters yet. Mount your kubeconfig at /kube/config and restart the console.</div></>
    );
  } else {
    body = (
      <>
        <KindTabs
          pinned={pinned.pinned} onPin={pinned.pin} onUnpin={pinned.unpin} onMove={pinned.move} onEditPinned={onEditPinned}
          kinds={served}
          active={kindKey}
          count={kindCount(all)}
          navigationView={tabNav.view}
          paneActive={paneActive}
          onSelect={onSelectKind}
          error={kindsError}
          onRetry={onRetryKinds}
          onAllKinds={onAllKinds}
          onOpenKind={onOpenView && ((key, split) => onOpenView(kindView(HOME, key, view.clusters), split))}
        />
        <FilterBar paneActive={paneActive} clusters={list} scope={view.clusters} onScope={scope => { cancelJump(); lastText.current = 0; setScopeNotice(null); tabNav.navigate(v => v.page === "kind" ? {...v, clusters: scope, fromAttention: undefined} : v, "push"); }} value={filters} onChange={onFilters} chips={chips} counts={counts} namespaces={namespaces} columns={kind.columns} pickSource={all} />
        <NavigationNotice text={attention && landing.state === "missing" ? "This Pod is no longer available" : attention && landing.state === "error" ? "Could not verify this Pod. Try again." : attention && !landing.ready ? "Opening Pod… Waiting for live pod status" : nav.notice ?? scopeNoticeText} waiting={nav.waiting || (!!attention && landing.state === "waiting")} />
        {attention && landing.state === "error" && <button type="button" className={s.btn} onClick={landing.retry}>Try Pod again</button>}
        <div ref={landing.root} tabIndex={-1} className={s.main} data-kind-row-keys>
          <ViewBoundary label="resources">
            <div ref={tableMount} style={{ display: "contents" }}>
              <TerritoryTable
                initialScrollTop={initialScrollTop}
                onScroll={tabNav.setScroll}
                onMissingSelection={onMissingSelection}
                territories={held && landing.state !== "missing" ? shown.map(t => ({ ...t, rows: [] })) : shown}
                columnFilters={filters.columns}
                sort={filters.sort}
                onColumnFilter={onColumnFilter}
                onSort={onSort}
                pickSource={all}
                kind={kind}
                selection={selection}
                onSelection={onSelection}
                reveal={nav.reveal + (landing.ready ? 1 : 0)}
                expectedUid={attention && landing.ready ? attention.uid : undefined}
                onRetry={onRetry}
                podCounts={podCounts}
                metrics={metrics}
                onOpenLogs={onOpenLogs}
                onPinLogs={openPinned}
                onOpenShell={onOpenShell}
                onNodeShell={onNodeShell}
                onOwnerLogs={onOwnerLogs}
                onWorkloadLogs={onWorkloadLogs}
                request={rowRequest}
                paneActive={paneActive}
                onOpenSplit={onOpenView && openRowSplit}
                menuView={tabNav.view}
              />
            </div>
          </ViewBoundary>
        </div>
      </>
    );
  }
  return <NavigationProvider goTo={nav.goTo}>
    {found > 0 && <div className={s.discoveryNotice}>
      <button type="button" className={s.btn} onClick={() => tabNav.navigate({ page: "home", section: "discovered" }, "push")}>
        {found} new {found === 1 ? "cluster" : "clusters"} found
      </button>
    </div>}
    {body}
  </NavigationProvider>;
}
