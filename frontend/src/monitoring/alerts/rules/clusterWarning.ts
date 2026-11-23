// A rule that may read another cluster's data. A Kubernetes project's link to a source carries a
// filter that keeps the project's cluster apart; setup fills it in when OmniKrux can tell which
// label separates the clusters. When it can't (the source names several clusters and none is this
// one, or no label tells them apart, or the source couldn't be asked), the link is kept without a
// filter and its origin stays "none": the user chose to allow it, and is warned wherever a rule
// reads it (the rule form and the rule's details).

import type { GroupOut, LinkOut, ProjectOut } from "../../api/types";
import type { ScopeKind, SourceType } from "../api";

export const mixedClustersWords = (project: string, source: string) =>
  `${project}'s data from ${source} may include other clusters: OmniKrux couldn't tell which label separates them, so this rule may fire on another cluster's data. Add a filter on the project page.`;

/** A Kubernetes project's link that no filter narrows to its cluster, because OmniKrux couldn't tell
 * how (a filter OmniKrux decided isn't needed reads "auto"; one the user wrote, "user"). */
export function mayMixClusters(project: Pick<ProjectOut, "kind" | "cluster_id">, link: Pick<LinkOut, "filter" | "filter_origin">): boolean {
  return project.kind === "kubernetes" && project.cluster_id !== null && link.filter.trim() === "" && link.filter_origin === "none";
}

/** The link a rule reads in `project`: the named source, else the project's first of the type. */
export function linkRead(project: ProjectOut, type: SourceType, sourceId: string | null): LinkOut | undefined {
  const ofType = project.links.filter((l) => l.source_type === type);
  return sourceId !== null ? ofType.find((l) => l.source_id === sourceId) : ofType[0];
}

/**
 * The warnings of a rule on `scope` reading `type` (and, for a project, `sourceId`): one per project
 * whose link may mix clusters. `projectIds` names the projects a group rule runs in; without it the
 * group's members are read from `groups`.
 */
export function mixedClusterWarnings(
  scope: { kind: ScopeKind; id: string },
  type: SourceType,
  sourceId: string | null,
  projects: readonly ProjectOut[],
  groups: readonly GroupOut[] = [],
  projectIds?: readonly string[],
): string[] {
  const ids = scope.kind === "project" ? [scope.id] : projectIds ?? groups.find((g) => g.id === scope.id)?.project_ids ?? [];
  const out: string[] = [];
  for (const id of ids) {
    const project = projects.find((p) => p.id === id);
    if (!project) continue;
    const link = linkRead(project, type, scope.kind === "project" ? sourceId : null);
    if (link && mayMixClusters(project, link)) out.push(mixedClustersWords(project.name, link.source_name));
  }
  return out;
}
