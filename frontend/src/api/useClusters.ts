import { useQuery, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { deleteEmpty, getJson, postEmpty, postJson } from "./http";
import type { Cluster } from "./types";

export const CLUSTERS_QUERY_KEY = ["clusters"] as const;

export function useClusters(): UseQueryResult<Cluster[]> {
  return useQuery({
    queryKey: CLUSTERS_QUERY_KEY,
    queryFn: () => getJson<Cluster[]>("/api/clusters"),
    refetchInterval: 15000,
  });
}

export function retryCluster(id: string): Promise<void> {
  return postEmpty(`/api/clusters/${encodeURIComponent(id)}/retry`);
}

export async function evictClusters(client: QueryClient, ids: readonly string[]): Promise<void> {
  // A read started before deletion can return a removed cluster even with no cached rows yet.
  await client.cancelQueries({ queryKey: CLUSTERS_QUERY_KEY });
  if (!ids.length) return;
  const removed = new Set(ids);
  client.setQueryData<Cluster[]>(CLUSTERS_QUERY_KEY, clusters => clusters?.filter(cluster => !removed.has(cluster.id)));
}

export async function removeCluster(client: QueryClient, id: string): Promise<void> {
  await deleteEmpty(`/api/clusters/${encodeURIComponent(id)}`);
  await evictClusters(client, [id]);
  void client.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY });
}

export async function importKubeconfig(client: QueryClient, kubeconfig: string): Promise<Cluster[]> {
  const clusters = await postJson<Cluster[]>("/api/clusters/kubeconfig", { kubeconfig });
  void client.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY });
  return clusters;
}
