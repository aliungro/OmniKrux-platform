import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { clusterLifecycle } from "./clusterLifecycle";
import { deleteEmpty, getJson, postEmpty, postJson } from "./http";
import type { Cluster } from "./types";

export const CLUSTERS_QUERY_KEY = ["clusters"] as const;

export function useClusters(): UseQueryResult<Cluster[]> {
  const lifecycle = clusterLifecycle(useQueryClient());
  return useQuery({
    queryKey: CLUSTERS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const started = lifecycle.startChange();
      const registry = await getJson<Cluster[]>("/api/clusters", signal);
      signal.throwIfAborted();
      return lifecycle.reconcile(registry, started);
    },
    refetchInterval: 15000,
  });
}

export function retryCluster(id: string): Promise<void> {
  return postEmpty(`/api/clusters/${encodeURIComponent(id)}/retry`);
}

export async function evictClusters(client: QueryClient, ids: readonly string[]): Promise<void> {
  const lifecycle = clusterLifecycle(client);
  ids.forEach(id => lifecycle.remove(id));
  // A read started before deletion can return a removed cluster even with no cached rows yet.
  await client.cancelQueries({ queryKey: CLUSTERS_QUERY_KEY });
  if (!ids.length) return;
  const removed = new Set(ids);
  client.setQueryData<Cluster[]>(CLUSTERS_QUERY_KEY, clusters => clusters?.filter(cluster => !removed.has(cluster.id)));
}

export function removeWatchedCluster(client: QueryClient, id: string): void {
  if (clusterLifecycle(client).isRemoved(id)) return;
  void evictClusters(client, [id]).then(() => client.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY }));
}

export async function removeCluster(client: QueryClient, id: string): Promise<void> {
  await deleteEmpty(`/api/clusters/${encodeURIComponent(id)}`);
  await evictClusters(client, [id]);
  void client.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY });
}

export async function importKubeconfig(client: QueryClient, kubeconfig: string): Promise<Cluster[]> {
  const lifecycle = clusterLifecycle(client);
  const started = lifecycle.startChange();
  const clusters = await postJson<Cluster[]>("/api/clusters/kubeconfig", { kubeconfig });
  lifecycle.added(clusters.map(cluster => cluster.id), started);
  void client.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY });
  return clusters;
}
