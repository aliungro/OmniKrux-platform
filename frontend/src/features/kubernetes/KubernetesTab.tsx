import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CLUSTERS_QUERY_KEY, retryCluster, useClusters } from "../../api/useClusters";
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
  NO_SELECTION,
  podsPerNode,
  rowKey,
  withDiscoveryFailures,
  type Filters,
  type Selection,
} from "../../features/territories/model";
import { TerritoryTable, type RowRequest } from "../../features/territories/TerritoryTable";
import { useNow } from "../../hooks/useNow";
import { ShellBridge } from "../shell/ShellBridge";
import { kindView, type ClosedTab, type KubeView } from "../shell/workspace";
import type { TabNav } from "../shell/browserHistory";
import type { useDock } from "../dock/useDock";
import type { PaletteSelection } from "../palette/CommandPalette";
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

/** The whole console page; expects a QueryClientProvider above it. */
export interface KubernetesTabProps { nav:TabNav<KubeView>; dock:ReturnType<typeof useDock>; closed:readonly ClosedTab<KubeView>[]; onReopen:(index:number)=>void; loadProblem:string|null; onDismissLoadProblem:()=>void; onEditPinned:()=>void }
export function KubernetesTab({ nav, dock }: KubernetesTabProps) {
 return nav.view.page === "home" ? <KubernetesHome nav={nav}/> : <KindView nav={nav} dock={dock}/>;
}
function KindView({nav: tabNav,dock}: {nav:TabNav<KubeView>;dock:ReturnType<typeof useDock>}) {
  const queryClient = useQueryClient();
  const clusters = useClusters();
  const list = clusters.data;
  const { refetch } = clusters;
  const knownClusterIds = useMemo(() => (list ? new Set(list.map((c) => c.id)) : undefined), [list]);

  const bridge = useContext(ShellBridge);
  const kindKey = tabNav.view.page === "kind" ? tabNav.view.kind : "pods";
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
    onClusterRemoved: () => void queryClient.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY }),
  });
  // The Nodes view's Pods column counts live pods per node.
  const podWatch = useWatch(kindKey === "nodes" ? "pods" : null);
  const podCounts = useMemo(() => (kindKey === "nodes" ? podsPerNode(podWatch) : null), [kindKey, podWatch]);
  // Pods and nodes have CPU and memory columns; polled only while one of those views is open.
  const metrics = useLiveMetrics(kindKey === "nodes" ? "nodes" : "pods", kindKey === "pods" || kindKey === "nodes");
  const now = useNow(60_000);

  const [filters, setFilters] = useState<Filters>(NO_FILTER);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  /** An action the palette asked for on the selected row; the table runs it as the row's key would. */
  const [rowRequest, setRowRequest] = useState<RowRequest | null>(null);
  // Another kind starts with nothing selected, and without a status chip it may not offer.
  const [shownKind, setShownKind] = useState(kindKey);
  if (shownKind !== kindKey) {
    setShownKind(kindKey);
    setSelection(NO_SELECTION);
    setRowRequest(null);
    if (filters.status !== "all" || filters.columns.length || filters.sort) setFilters({ ...filters, status: "all", columns: [], sort: null });
  }
  // A kind without namespaces ignores the namespace you picked for another one (and keeps it for later).
  const effective = useMemo(
    () => (kind.namespaced || filters.namespace === null ? filters : { ...filters, namespace: null }),
    [kind.namespaced, filters],
  );

  // Unfiltered territories drive the scope tokens and every count, so counts never shrink as you filter.
  // A cluster that couldn't read the kind's API group says so instead of "doesn't serve" (Ruling R36).
  const all = useMemo(
    () => withDiscoveryFailures(buildTerritories(list ?? [], watch, NO_FILTER, now, kind), discovered, kind),
    [list, watch, now, kind, discovered],
  );
  const shown = useMemo(
    () =>
      isNoFilter(effective)
        ? all
        : withDiscoveryFailures(buildTerritories(list ?? [], watch, effective, now, kind), discovered, kind),
    [all, list, watch, effective, now, kind, discovered],
  );
  const chips = useMemo(() => chipsFor(kind), [kind]);
  const counts = useMemo(() => countFilters(all, now, kind), [all, now, kind]);
  const namespaces = useMemo(() => (kind.namespaced ? namespacesIn(all) : null), [kind.namespaced, all]);

  const { openPod, openOwnerLogs, openWorkloadLogs, askNodeShell } = dock;
  const onOpenLogs = useCallback(
    (row: ResourceRow, previous?: boolean) => openPod(row, "logs", { previous }),
    [openPod],
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
  });
  const { cancel: cancelJump } = nav;
  // Picking a row, a kind or a filter yourself drops a jump still waiting for its row.
  const onSelection = useCallback<typeof setSelection>((next) => {
    cancelJump();
    setSelection(next);
  }, [cancelJump]);
  const onFilters = useCallback((next: Filters) => {
    cancelJump();
    setFilters(next);
  }, [cancelJump]);
  const onColumnFilter = useCallback((key: string, f: import("../territories/columnFilters").ColumnFilter | null) => { cancelJump(); setFilters(prev => ({...prev, columns: [...prev.columns.filter(x => x.key !== key), ...(f ? [f] : [])]})); }, [cancelJump]);
  const onSort = useCallback((sort: import("../territories/columnFilters").SortSpec | null) => { cancelJump(); setFilters(prev => ({...prev, sort})); }, [cancelJump]);
  const onSelectKind = useCallback(
    (key: string, opts?: { replace: boolean }) => {
      cancelJump();
      tabNav.navigate(v => kindView(v,key), opts?.replace ? "replace" : "push");
    },
    [tabNav.navigate, cancelJump],
  );

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
  const paletteSelection = useMemo<PaletteSelection | null>(
    () => (selectedRow ? { ...selectedRow, kind } : null),
    [selectedRow, kind],
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
  useEffect(() => { bridge.setScope(all); return () => bridge.setScope(null); }, [all, bridge.setScope]);
  useEffect(() => { bridge.setPaletteTarget({selection:paletteSelection,onKind:onSelectKind,onRowAction}); return () => bridge.setPaletteTarget(null); }, [bridge.setPaletteTarget,paletteSelection,onSelectKind,onRowAction]);
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
      <div className={s.note}>No clusters yet. Mount your kubeconfig at /kube/config and restart the console.</div>
    );
  } else {
    body = (
      <>
        <KindTabs
          kinds={served}
          active={kindKey}
          count={kindCount(all)}
          onSelect={onSelectKind}
          error={kindsError}
          onRetry={onRetryKinds}
          onAllKinds={onAllKinds}
        />
        <FilterBar value={filters} onChange={onFilters} chips={chips} counts={counts} namespaces={namespaces} columns={kind.columns} pickSource={all} />
        <NavigationNotice text={nav.notice} waiting={nav.waiting} />
        <div className={s.main}>
          <TerritoryTable
            territories={shown}
            columnFilters={filters.columns}
            sort={filters.sort}
            onColumnFilter={onColumnFilter}
            onSort={onSort}
            pickSource={all}
            kind={kind}
            selection={selection}
            onSelection={onSelection}
            reveal={nav.reveal}
            onRetry={onRetry}
            podCounts={podCounts}
            metrics={metrics}
            onOpenLogs={onOpenLogs}
            onOpenShell={onOpenShell}
            onNodeShell={onNodeShell}
            onOwnerLogs={onOwnerLogs}
            onWorkloadLogs={onWorkloadLogs}
            request={rowRequest}
          />
        </div>
      </>
    );
  }
  return <NavigationProvider goTo={nav.goTo}>{body}</NavigationProvider>;
}
