// The ready-made views a project gets from the sources it links. A mirror of the backend's
// `ready_keys` and `TITLES` in `dashboards/ready_made.py` (the source of truth): change both together.
import type { ProjectKind, ProjectOut } from "../api/types";

const TITLES = {
  cluster: "Cluster health",
  nodes: "Node health",
  namespaces: "Namespace health",
  workloads: "Workload health",
  pods: "Pod health",
  logs: "Logs overview",
} as const;
const PROMETHEUS_VIEWS = ["cluster", "nodes", "namespaces", "workloads", "pods"] as const;

/** The titles of the views a project gets: with Prometheus, five for Kubernetes and Node health for
 * any other kind; then, with Loki, the Logs overview (also without Prometheus). */
export function readyViewTitles(kind: ProjectKind, has: { prometheus: boolean; loki: boolean }): string[] {
  const keys: (keyof typeof TITLES)[] = has.prometheus ? (kind === "kubernetes" ? [...PROMETHEUS_VIEWS] : ["nodes"]) : [];
  if (has.loki) keys.push("logs");
  return keys.map((k) => TITLES[k]);
}

/** The titles a new link of this type would add to the project: none when it already has that type. */
export function readyAddedBy(project: ProjectOut, type: "prometheus" | "loki"): string[] {
  const have = { prometheus: project.links.some((l) => l.source_type === "prometheus"), loki: project.links.some((l) => l.source_type === "loki") };
  if (have[type]) return [];
  const before = readyViewTitles(project.kind, have);
  return readyViewTitles(project.kind, { ...have, [type]: true }).filter((t) => !before.includes(t));
}

/** "the ready-made view Logs overview" / "the ready-made views A, B". */
export function readyViewsPhrase(titles: string[]): string {
  return `the ready-made ${titles.length === 1 ? "view" : "views"} ${titles.join(", ")}`;
}
