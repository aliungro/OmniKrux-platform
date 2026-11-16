import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { clusterLifecycle } from "../../api/clusterLifecycle";
import { deleteEmpty, getJson, postJson } from "../../api/http";
import type { Cluster, ForwardIn, ForwardOut } from "../../api/types";
import { CLUSTERS_QUERY_KEY } from "../../api/useClusters";

export const PORT_FORWARDS_KEY = ["port-forwards"] as const;
export const FORWARDS_POLL_MS = 5000;

export async function forgetClusterForwards(client: QueryClient, id: string): Promise<void> {
  await client.cancelQueries({ queryKey: PORT_FORWARDS_KEY });
  client.setQueryData<ForwardOut[]>(PORT_FORWARDS_KEY, forwards => forwards?.filter(forward => forward.cluster_id !== id));
  void client.invalidateQueries({ queryKey: PORT_FORWARDS_KEY });
}

export interface PortForwards {
  query: UseQueryResult<ForwardOut[]>;
  /** Starts a forward; rejects with the server's words (all ports in use, no ready pods, …). */
  start: (req: ForwardIn) => Promise<ForwardOut>;
  /** Stops one; the list is read again afterwards. */
  stop: (id: string) => Promise<void>;
}

/** The running forwards, read every 5 s, with start and stop. A start or stop also refreshes the audit log. */
export function usePortForwards(): PortForwards {
  const queryClient = useQueryClient();
  const lifecycle = clusterLifecycle(queryClient);
  const query = useQuery({
    queryKey: PORT_FORWARDS_KEY,
    queryFn: async ({ signal }) => {
      const started = lifecycle.startChange();
      const forwards = await getJson<ForwardOut[]>("/api/port-forwards", signal);
      const registry = queryClient.getQueryData<Cluster[]>(CLUSTERS_QUERY_KEY);
      return forwards.filter(({ cluster_id }) =>
        !lifecycle.isRemoved(cluster_id) && !lifecycle.wasRemovedSince(cluster_id, started) &&
        (!lifecycle.wasRemovedSince(cluster_id, 0) || registry?.some(cluster => cluster.id === cluster_id)));
    },
    refetchInterval: FORWARDS_POLL_MS,
    retry: false,
  });
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: PORT_FORWARDS_KEY });
    void queryClient.invalidateQueries({ queryKey: ["audit"] });
  }, [queryClient]);
  const start = useCallback(
    async (req: ForwardIn) => {
      try {
        return await postJson<ForwardOut>("/api/port-forwards", req);
      } finally {
        refresh();
      }
    },
    [refresh],
  );
  const stop = useCallback(
    async (id: string) => {
      try {
        await deleteEmpty(`/api/port-forwards/${encodeURIComponent(id)}`);
      } finally {
        refresh();
      }
    },
    [refresh],
  );
  return useMemo(() => ({ query, start, stop }), [query, start, stop]);
}
