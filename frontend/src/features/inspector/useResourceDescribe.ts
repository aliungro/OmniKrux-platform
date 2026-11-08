import { useQuery, type Query, type UseQueryResult } from "@tanstack/react-query";
import { getJson } from "../../api/http";
import type { ResourceDescribe, ResourceYaml } from "../../api/types";

/** `/api/clusters/{id}/resources/{kind}/{name}/{what}`, with `?namespace=` for a namespaced object. */
export function resourcePath(clusterId: string, kindKey: string, ns: string | null, name: string, what: "describe" | "yaml"): string {
  const base = `/api/clusters/${encodeURIComponent(clusterId)}/resources/${encodeURIComponent(kindKey)}/${encodeURIComponent(name)}/${what}`;
  return ns ? `${base}?namespace=${encodeURIComponent(ns)}` : base;
}

/**
 * The previous answer while a new one loads, but only for the same object (a new version of it):
 * another object's details are never shown as this one's.
 */
function sameObject<T>(key: readonly unknown[]) {
  return (previous: T | undefined, query: Query<T, Error, T, readonly unknown[]> | undefined): T | undefined =>
    previous !== undefined && query !== undefined && key.slice(0, 5).every((part, i) => query.queryKey[i] === part) ? previous : undefined;
}

/**
 * Any object's describe. `version` is the row's resource version, so the describe reloads whenever
 * the watch reports a change; the previous answer of the same object stays on screen meanwhile. A Secret's answer holds its
 * key names and sizes only: a revealed value never goes through here (see SecretValues).
 */
export function useResourceDescribe(
  clusterId: string,
  kindKey: string,
  ns: string | null,
  name: string,
  version: string,
): UseQueryResult<ResourceDescribe> {
  const queryKey = ["resource-describe", clusterId, kindKey, ns, name, version] as const;
  return useQuery({
    queryKey,
    queryFn: () => getJson<ResourceDescribe>(resourcePath(clusterId, kindKey, ns, name, "describe")),
    placeholderData: sameObject<ResourceDescribe>(queryKey),
    retry: false,
  });
}

/** The object as YAML (a Secret's values masked by the server); only fetched while the YAML tab is open. */
export function useResourceYaml(
  clusterId: string,
  kindKey: string,
  ns: string | null,
  name: string,
  version: string,
  enabled: boolean,
): UseQueryResult<string> {
  const queryKey = ["resource-yaml", clusterId, kindKey, ns, name, version] as const;
  return useQuery({
    queryKey,
    queryFn: async () => (await getJson<ResourceYaml>(resourcePath(clusterId, kindKey, ns, name, "yaml"))).yaml,
    placeholderData: sameObject<string>(queryKey),
    retry: false,
    enabled,
  });
}
