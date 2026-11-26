import { useQuery } from "@tanstack/react-query";
import { getJson } from "../../api/http";

interface ClusterUses {
  projects: string[];
  sources: string[];
}

const part = (n: number, one: string, names: string[]) => `${n} ${one}${n === 1 ? "" : "s"} (${names.join(", ")})`;

/**
 * Shown in a cluster's removal review: the Monitoring projects and sources that depend on it.
 * It reads the route once, and says nothing while loading, when it can't be read, or when
 * Monitoring doesn't use the cluster, so the Kubernetes review reads as it always did.
 */
export function MonitoringClusterUses({ clusterId }: { clusterId: string }) {
  const uses = useQuery({
    queryKey: ["monitoring", "cluster-uses", clusterId],
    queryFn: () => getJson<ClusterUses>(`/api/monitoring/clusters/${encodeURIComponent(clusterId)}/uses`),
    retry: false,
  });
  if (!uses.data) return null;
  const { projects, sources } = uses.data;
  const used = [
    ...(projects.length > 0 ? [part(projects.length, "project", projects)] : []),
    ...(sources.length > 0 ? [part(sources.length, "source", sources)] : []),
  ];
  if (used.length === 0) return null;
  return <p>Monitoring uses this cluster: {used.join(" and ")}. They stay, but their data can't be read until the cluster is added again.</p>;
}
