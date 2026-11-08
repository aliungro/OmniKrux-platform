import { useCallback, useMemo, useRef, useState } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { CLUSTERS_QUERY_KEY, retryCluster, useClusters } from "./api/useClusters";
import { refreshKinds, useKinds } from "./api/useKinds";
import { useLiveMetrics } from "./api/useMetrics";
import { useWatch } from "./api/useWatch";
import { failure } from "./api/http";
import type { Cluster, ClusterState, KindInfo, KindsResponse, OwnerRef, ResourceRow } from "./api/types";
import { AuditView } from "./features/audit/AuditView";
import { ActionsProvider } from "./features/actions/ActionDialog";
import type { RowAction } from "./features/actions/tools";
import { FilterBar } from "./features/chrome/FilterBar";
import { KindTabs } from "./features/chrome/KindTabs";
import { ShortcutBar } from "./features/chrome/ShortcutBar";
import { TopBar } from "./features/chrome/TopBar";
import { ForwardsMenu } from "./features/portforward/ForwardsMenu";
import { usePortForwards } from "./features/portforward/usePortForwards";
import { CommandPalette, usePaletteKeys, type PaletteMode, type PaletteSelection } from "./features/palette/CommandPalette";
import { Dock } from "./features/dock/Dock";
import { useDock } from "./features/dock/useDock";
import { NavigationNotice, NavigationProvider, useNavigator } from "./features/navigation/navigation";
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
} from "./features/territories/model";
import { TerritoryTable, type RowRequest } from "./features/territories/TerritoryTable";
import { useNow } from "./hooks/useNow";
import { useRoute } from "./route";
import s from "./App.module.css";

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
export function Console() {
  const queryClient = useQueryClient();
  const clusters = useClusters();
  const list = clusters.data;
  const { refetch } = clusters;
  const knownClusterIds = useMemo(() => (list ? new Set(list.map((c) => c.id)) : undefined), [list]);

  const [route, setRoute] = useRoute();
  // The audit log is its own view; the resources behind it keep the kind you were on, so coming
  // back lands there and nothing is re-watched while the log is open.
  const lastKind = useRef("pods");
  if (route.view === "resources") lastKind.current = route.kind;
  const kindKey = lastKind.current;
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
    if (filters.status !== "all") setFilters({ ...filters, status: "all" });
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

  const dock = useDock(list ?? []);
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
  const onKind = useCallback((key: string) => setRoute({ view: "resources", kind: key }), [setRoute]);
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
  const onSelectKind = useCallback(
    (key: string, opts?: { replace: boolean }) => {
      cancelJump();
      setRoute({ view: "resources", kind: key }, opts);
    },
    [setRoute, cancelJump],
  );

  const onBackFromAudit = useCallback(() => setRoute({ view: "resources", kind: lastKind.current }), [setRoute]);
  const onAudit = useCallback(
    () => (route.view === "audit" ? onBackFromAudit() : setRoute({ view: "audit" })),
    [setRoute, route.view, onBackFromAudit],
  );

  // The command palette: Ctrl K for everything, ":" for kinds. It runs nothing itself: a kind
  // switches the view, an action goes to the table as the row's key would (the same forms and
  // reviews), a view opens it.
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  usePaletteKeys(setPalette);
  const onClosePalette = useCallback(() => setPalette(null), []);
  // After a kind jump the row that had focus is gone: the kind's tab takes it.
  const focusActiveKind = useCallback(() => {
    document.querySelector<HTMLElement>('[role="tablist"][aria-label="Kinds"] [role="tab"][aria-selected="true"]')?.focus();
  }, []);
  const onPalette = useCallback(() => setPalette("all"), []);
  const onAllKinds = useCallback(() => setPalette("kinds"), []);
  const selectedRow = useMemo(() => {
    const sel = selection.selected;
    if (route.view !== "resources" || sel === null) return null;
    for (const t of shown) {
      if (t.cluster.id !== sel.clusterId) continue;
      const row = t.rows.find((r) => r.uid === sel.uid);
      return row ? { row, cluster: t.cluster } : null;
    }
    return null;
  }, [route.view, selection.selected, shown]);
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
  const onAuditView = useCallback(() => setRoute({ view: "audit" }), [setRoute]);
  const forwardCount = usePortForwards().query.data?.length ?? 0;
  const [forwardsAsk, setForwardsAsk] = useState(0);
  const onForwards = useMemo(() => (forwardCount > 0 ? () => setForwardsAsk((n) => n + 1) : undefined), [forwardCount]);

  let body;
  if (route.view === "audit") {
    // The audit log needs no cluster to read: it is the record of what was done.
    body = (
      <main className={s.main}>
        <AuditView onBack={onBackFromAudit} />
      </main>
    );
  } else if (list === undefined) {
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
        <FilterBar value={filters} onChange={onFilters} chips={chips} counts={counts} namespaces={namespaces} />
        <NavigationNotice text={nav.notice} waiting={nav.waiting} />
        <main className={s.main}>
          <TerritoryTable
            territories={shown}
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
        </main>
      </>
    );
  }
  const hasTable = list !== undefined && list.length > 0;

  // The dock sits outside the switch above, so its sessions (and their shells) outlive a moment
  // with no clusters, e.g. the last one removed. A change's review dialog is drawn by
  // ActionsProvider over all of it, naming the plan's cluster whatever is selected meanwhile.
  return (
    <NavigationProvider goTo={nav.goTo}>
      <ActionsProvider>
        <div className={s.app}>
          <TopBar
            clusters={all}
            forwards={<ForwardsMenu openRequest={forwardsAsk} />}
            onAudit={onAudit}
            auditOpen={route.view === "audit"}
            onPalette={onPalette}
          />
          {body}
          {(hasTable || dock.state.sessions.length > 0) && <Dock dock={dock} />}
          {hasTable && route.view !== "audit" && <ShortcutBar kind={kindKey} />}
          {palette !== null && (
            <CommandPalette
              mode={palette}
              kinds={served}
              kindsError={kindsError}
              selection={paletteSelection}
              onKind={onSelectKind}
              onRowAction={onRowAction}
              onAudit={onAuditView}
              onForwards={onForwards}
              onClose={onClosePalette}
              onFocusLost={focusActiveKind}
            />
          )}
        </div>
      </ActionsProvider>
    </NavigationProvider>
  );
}

export default function App() {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <Console />
    </QueryClientProvider>
  );
}
