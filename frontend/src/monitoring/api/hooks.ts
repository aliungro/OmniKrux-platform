import { useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { discover, getProject, getTree, listGroups, listProjects, listSources, sourceHealth } from "./client";
import type { DiscoveryOut, GroupOut, HealthOut, ProjectOut, SourceOut, TreeOut } from "./types";

export const treeKey = ["monitoring", "tree"] as const;
export const sourcesKey = ["monitoring", "sources"] as const;
export const healthKey = ["monitoring", "health"] as const;
export const projectsKey = ["monitoring", "projects"] as const;
export const projectKey = (id: string) => ["monitoring", "project", id] as const;
export const groupsKey = ["monitoring", "groups"] as const;
export const discoveryKey = (clusterId: string) => ["monitoring", "discovery", clusterId] as const;

export const useMonitoringTree = (): UseQueryResult<TreeOut> => useQuery({ queryKey: treeKey, queryFn: () => getTree() });
export const useSources = (): UseQueryResult<SourceOut[]> => useQuery({ queryKey: sourcesKey, queryFn: () => listSources() });
export const useSourceHealth = (): UseQueryResult<Record<string, HealthOut>> =>
  useQuery({ queryKey: healthKey, queryFn: () => sourceHealth(), refetchInterval: 30_000 });
export const useProjects = (): UseQueryResult<ProjectOut[]> => useQuery({ queryKey: projectsKey, queryFn: () => listProjects() });
export const useProject = (id: string): UseQueryResult<ProjectOut> => useQuery({ queryKey: projectKey(id), queryFn: () => getProject(id) });
export const useGroups = (): UseQueryResult<GroupOut[]> => useQuery({ queryKey: groupsKey, queryFn: () => listGroups() });
export const useDiscovery = (clusterId: string | null): UseQueryResult<DiscoveryOut> =>
  useQuery({
    queryKey: discoveryKey(clusterId ?? ""),
    queryFn: () => discover(clusterId as string),
    enabled: clusterId !== null,
  });

/** After a change: everything Monitoring shows is read again, and so is the audit log. */
export async function invalidateMonitoring(client: QueryClient): Promise<void> {
  await Promise.all([client.invalidateQueries({ queryKey: ["monitoring"] }), client.invalidateQueries({ queryKey: ["audit"] })]);
}

/**
 * A change that carries no secret (rename, link, group, delete). Calls whose body can hold a
 * secret (`createSource`, `updateSource`, `testNewSource`, `setupProject`) must not use this:
 * TanStack keeps a mutation's `variables` in its cache. Call them plainly and then
 * `invalidateMonitoring`.
 */
export function useMonitoringMutation<V, R>(fn: (vars: V) => Promise<R>): UseMutationResult<R, Error, V> {
  const client = useQueryClient();
  return useMutation<R, Error, V>({ mutationFn: fn, onSuccess: () => invalidateMonitoring(client) });
}
