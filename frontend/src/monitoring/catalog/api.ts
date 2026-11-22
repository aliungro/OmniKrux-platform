// The project catalog in the browser: what `GET /projects/{id}/catalog` lists for each linked
// source (metrics with their types, help and labels; log streams with their label values). The
// server builds it and keeps it a while; the browser keeps what it read for five minutes.
import { useCallback } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { failureOf, NETWORK_MESSAGE, QueryFailure, UNREADABLE_ANSWER } from "../api/query";
import type { SourceType } from "../api/types";

export interface CatalogMetricOut {
  name: string;
  type: string | null;
  help: string | null;
  unit: string | null;
  labels: string[];
  /** `null` when the source didn't list its series. */
  series: number | null;
  family: string | null;
}

export interface StreamLabelOut {
  name: string;
  values: string[];
  truncated: boolean;
}

export type CatalogState = "ok" | "partial" | "error";

export interface SourceCatalogOut {
  source_id: string;
  source_name: string;
  source_type: SourceType;
  state: CatalogState;
  message: string | null;
  /** An ISO date-time. */
  built_at: string;
  metrics: CatalogMetricOut[];
  labels: string[];
  streams: StreamLabelOut[];
  notes: string[];
}

export interface CatalogOut {
  project_id: string;
  /** In link order. */
  sources: SourceCatalogOut[];
}

/** Reads a project's catalog; `refresh` asks the server to build it again. Rejects with `QueryFailure`. */
export async function getCatalog(projectId: string, refresh = false, signal?: AbortSignal): Promise<CatalogOut> {
  let res: Response;
  try {
    res = await fetch(`/api/monitoring/projects/${encodeURIComponent(projectId)}/catalog?refresh=${refresh}`, signal ? { signal } : {});
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new QueryFailure(0, "network", NETWORK_MESSAGE);
  }
  if (!res.ok) throw await failureOf(res);
  try {
    return (await res.json()) as CatalogOut;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new QueryFailure(res.status, "bad_request", UNREADABLE_ANSWER);
  }
}

export const catalogKey = (projectId: string | null) => ["monitoring", "catalog", projectId] as const;
export const CATALOG_STALE_MS = 300_000;

export function useProjectCatalog(projectId: string | null): UseQueryResult<CatalogOut, QueryFailure> {
  return useQuery<CatalogOut, QueryFailure>({
    queryKey: catalogKey(projectId),
    queryFn: ({ signal }) => getCatalog(projectId as string, false, signal),
    enabled: projectId !== null,
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
}

/** Builds a project's catalog again and keeps the answer. Rejects with `QueryFailure`. */
export function useRefreshCatalog(): (projectId: string) => Promise<void> {
  const client = useQueryClient();
  return useCallback(
    async (projectId: string) => {
      client.setQueryData(catalogKey(projectId), await getCatalog(projectId, true));
    },
    [client],
  );
}
