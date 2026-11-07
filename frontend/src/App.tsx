import { useCallback, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { CLUSTERS_QUERY_KEY, retryCluster, useClusters } from "./api/useClusters";
import { useWatch } from "./api/useWatch";
import type { OwnerRef, ResourceRow } from "./api/types";
import { FilterBar } from "./features/chrome/FilterBar";
import { KindTabs } from "./features/chrome/KindTabs";
import { ShortcutBar } from "./features/chrome/ShortcutBar";
import { TopBar } from "./features/chrome/TopBar";
import { Dock } from "./features/dock/Dock";
import { useDock } from "./features/dock/useDock";
import { buildTerritories, countFilters, podCount, type Filters } from "./features/territories/model";
import { TerritoryTable } from "./features/territories/TerritoryTable";
import { useNow } from "./hooks/useNow";
import s from "./App.module.css";

const NO_FILTER: Filters = { status: "all", text: "" };

function isNoFilter(f: Filters): boolean {
  return f.status === "all" && f.text.trim() === "";
}

/** The whole console page; expects a QueryClientProvider above it. */
export function Console() {
  const queryClient = useQueryClient();
  const clusters = useClusters();
  const list = clusters.data;
  const { refetch } = clusters;
  const knownClusterIds = useMemo(() => (list ? new Set(list.map((c) => c.id)) : undefined), [list]);
  // The watch names clusters the moment the backend adds or drops them; reload the list then.
  const watch = useWatch("pods", {
    knownClusterIds,
    onUnknownCluster: () => void refetch(),
    onClusterRemoved: () => void queryClient.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY }),
  });
  const now = useNow(60_000);
  const [filters, setFilters] = useState<Filters>(NO_FILTER);

  // Unfiltered territories drive the scope tokens and every count, so counts never shrink as you filter.
  const all = useMemo(() => buildTerritories(list ?? [], watch, NO_FILTER, now), [list, watch, now]);
  const shown = useMemo(
    () => (isNoFilter(filters) ? all : buildTerritories(list ?? [], watch, filters, now)),
    [all, list, watch, filters, now],
  );
  const counts = useMemo(() => countFilters(all, now), [all, now]);

  const dock = useDock(list ?? []);
  const { openPod, openOwnerLogs, askNodeShell } = dock;
  const onOpenLogs = useCallback(
    (row: ResourceRow, previous?: boolean) => openPod(row, "logs", { previous }),
    [openPod],
  );
  const onOpenShell = useCallback((row: ResourceRow) => openPod(row, "shell"), [openPod]);
  const onNodeShell = useCallback((row: ResourceRow, node: string) => askNodeShell(row.cluster_id, node), [askNodeShell]);
  const onOwnerLogs = useCallback((row: ResourceRow, owner: OwnerRef) => openOwnerLogs(row, owner), [openOwnerLogs]);

  const onRetry = useCallback((id: string) => {
    // The watch reports the cluster's new state; a failed request leaves its band in error.
    retryCluster(id).catch((err: unknown) => console.error(`Retry for cluster ${id} failed:`, err));
  }, []);

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
        <KindTabs active="pods" counts={{ pods: podCount(all) }} />
        <FilterBar value={filters} onChange={setFilters} counts={counts} />
        <main className={s.main}>
          <TerritoryTable
            territories={shown}
            onRetry={onRetry}
            onOpenLogs={onOpenLogs}
            onOpenShell={onOpenShell}
            onNodeShell={onNodeShell}
            onOwnerLogs={onOwnerLogs}
          />
        </main>
        <Dock dock={dock} />
        <ShortcutBar />
      </>
    );
  }

  return (
    <div className={s.app}>
      <TopBar clusters={all} />
      {body}
    </div>
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
