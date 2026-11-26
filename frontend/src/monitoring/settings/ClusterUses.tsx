import { useQuery } from "@tanstack/react-query";
import { getJson } from "../../api/http";

interface ClusterUses {
  projects: string[];
  sources: string[];
}

const part = (n: number, one: string, names: string[]) => `${n} ${one}${n === 1 ? "" : "s"} (${names.join(", ")})`;

/**
 * What removing the cluster does to them, as it is: a cluster added again gets a new id, and
 * nothing re-binds to it, so its sources are set up again (and linked to the projects again).
 */
export function afterRemoval(projects: number, sources: number): string {
  const one = projects + sources === 1;
  const they = one ? "It stays" : "They stay";
  const them = one ? "it" : "them";
  if (sources === 0) return `${they}, without a cluster: adding the cluster again doesn't reconnect ${them}.`;
  const data = `${they}, but ${one ? "its" : "their"} data can't be read any more. Adding the cluster again doesn't reconnect ${them}:`;
  if (projects === 0) return `${data} ${one ? "it needs" : "they need"} setting up again.`;
  return `${data} their sources need setting up again and linking to ${projects === 1 ? "this project" : "these projects"}.`;
}

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
  return <p>Monitoring uses this cluster: {used.join(" and ")}. {afterRemoval(projects.length, sources.length)}</p>;
}
