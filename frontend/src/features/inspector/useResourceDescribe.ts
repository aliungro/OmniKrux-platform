import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getJson } from "../../api/http";
import type { ResourceDescribe, ResourceYaml } from "../../api/types";

/** `/api/clusters/{id}/resources/{kind}/{name}/{what}`, with `?namespace=` for a namespaced object. */
export function resourcePath(clusterId: string, kindKey: string, ns: string | null, name: string, what: "describe" | "yaml"): string {
  const base = `/api/clusters/${encodeURIComponent(clusterId)}/resources/${encodeURIComponent(kindKey)}/${encodeURIComponent(name)}/${what}`;
  return ns ? `${base}?namespace=${encodeURIComponent(ns)}` : base;
}

/**
 * Any object's describe. `version` changes whenever the watch reports a change to the row, so the
 * describe reloads then; the previous answer stays on screen meanwhile. A Secret's answer holds its
 * key names and sizes only: a revealed value never goes through here (see SecretValues).
 */
export function useResourceDescribe(
  clusterId: string,
  kindKey: string,
  ns: string | null,
  name: string,
  version: string,
): UseQueryResult<ResourceDescribe> {
  return useQuery({
    queryKey: ["resource-describe", clusterId, kindKey, ns, name, version],
    queryFn: () => getJson<ResourceDescribe>(resourcePath(clusterId, kindKey, ns, name, "describe")),
    placeholderData: keepPreviousData,
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
  return useQuery({
    queryKey: ["resource-yaml", clusterId, kindKey, ns, name, version],
    queryFn: async () => (await getJson<ResourceYaml>(resourcePath(clusterId, kindKey, ns, name, "yaml"))).yaml,
    placeholderData: keepPreviousData,
    retry: false,
    enabled,
  });
}
