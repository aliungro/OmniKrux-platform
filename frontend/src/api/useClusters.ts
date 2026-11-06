import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getJson, postEmpty } from "./http";
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
