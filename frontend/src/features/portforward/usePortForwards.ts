import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { deleteEmpty, getJson, postJson } from "../../api/http";
import type { ForwardIn, ForwardOut } from "../../api/types";

export const PORT_FORWARDS_KEY = ["port-forwards"] as const;
export const FORWARDS_POLL_MS = 5000;

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
  const query = useQuery({
    queryKey: PORT_FORWARDS_KEY,
    queryFn: () => getJson<ForwardOut[]>("/api/port-forwards"),
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
