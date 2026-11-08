import { useQuery, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { getJson } from "./http";
import type { KindsResponse } from "./types";

export const KINDS_QUERY_KEY = ["kinds"] as const;

/** Every kind some cluster serves (GET /api/kinds); the server caches each cluster's answer for 5 min. */
export function useKinds(): UseQueryResult<KindsResponse> {
  return useQuery({
    queryKey: KINDS_QUERY_KEY,
    queryFn: () => getJson<KindsResponse>("/api/kinds"),
    refetchInterval: 60_000,
  });
}

/** Asks every cluster again now (a CRD installed a moment ago), and keeps the answer for the tabs. */
export async function refreshKinds(client: QueryClient): Promise<void> {
  const fresh = await getJson<KindsResponse>("/api/kinds?refresh=true");
  client.setQueryData(KINDS_QUERY_KEY, fresh);
}
