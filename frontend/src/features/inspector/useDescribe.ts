import { keepPreviousData, queryOptions, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getJson } from "../../api/http";
import type { PodDescribe, PodYaml } from "../../api/types";

export function podPath(clusterId: string, ns: string, name: string): string {
  return `/api/clusters/${encodeURIComponent(clusterId)}/pods/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`;
}

/** The describe query, shared by the inspector and the dock (which reads the pod's containers). */
export function describeQuery(
  clusterId: string,
  ns: string,
  name: string,
  resourceVersion: string,
  expectedUid?: string,
) {
  const key = ["describe", clusterId, ns, name, resourceVersion];
  const path = `${podPath(clusterId, ns, name)}/describe`;
  return queryOptions({
    queryKey: expectedUid === undefined ? key : [...key, expectedUid],
    queryFn: () => getJson<PodDescribe>(
      expectedUid === undefined ? path : `${path}?expected_uid=${encodeURIComponent(expectedUid)}`,
    ),
    retry: false,
  });
}

/**
 * The pod's describe, keyed on its resource version so it reloads whenever the watch reports a change.
 * Guarded requests keep the previous answer across resource versions of the same Pod UID.
 * No automatic retries: the backend's error is already in plain words, and the view offers Retry.
 */
export function useDescribe(
  clusterId: string,
  ns: string,
  name: string,
  resourceVersion: string,
  expectedUid?: string,
): UseQueryResult<PodDescribe> {
  return useQuery({
    ...describeQuery(clusterId, ns, name, resourceVersion, expectedUid),
    placeholderData: (previousData, previousQuery) => {
      const [, previousCluster, previousNs, previousName, , previousUid] = previousQuery?.queryKey ?? [];
      if (expectedUid === undefined && previousUid === undefined) return previousData;
      if (
        previousCluster === clusterId
        && previousNs === ns
        && previousName === name
        && previousUid === expectedUid
      ) {
        return previousData;
      }
    },
  });
}

/** The pod's manifest as YAML; only fetched while the YAML tab is open. */
export function usePodYaml(
  clusterId: string,
  ns: string,
  name: string,
  resourceVersion: string,
  enabled: boolean,
): UseQueryResult<string> {
  return useQuery({
    queryKey: ["pod-yaml", clusterId, ns, name, resourceVersion],
    queryFn: async () => (await getJson<PodYaml>(`${podPath(clusterId, ns, name)}/yaml`)).yaml,
    placeholderData: keepPreviousData,
    retry: false,
    enabled,
  });
}
