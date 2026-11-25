// What Explore opens on when its view doesn't say: the project, the source and the time range.

import { isQueryable } from "../sources/sourceLabels";
import type { LinkOut, ProjectOut, TreeOut } from "../api/types";
import type { TimeSpec } from "../dashboards/schema";
import { resolveTime } from "../dashboards/time";
import type { RecentItem } from "../home/recent";
import type { ExploreView } from "../shell/tabState";

export const DEFAULT_EXPLORE_TIME: TimeSpec = { from: "now-1h", to: "now" };

/** The view's project if it exists; else the most recently opened one that exists; else the first by name. */
export function defaultExploreProject(view: Pick<ExploreView, "project">, tree: TreeOut, recent: RecentItem[]): string | null {
  const exists = (id: string) => tree.projects.some((p) => p.id === id);
  if (view.project && exists(view.project)) return view.project;
  for (const r of [...recent].sort((a, b) => b.at - a.at)) if (r.kind === "project" && exists(r.id)) return r.id;
  const byName = [...tree.projects].sort((a, b) => a.name.localeCompare(b.name));
  return byName[0]?.id ?? null;
}

/** The view's source when the project links it; else the first Prometheus-compatible link; else the first Loki link. */
export function defaultExploreSource(project: ProjectOut, sourceId?: string): LinkOut | null {
  const named = sourceId ? project.links.find((l) => l.source_id === sourceId && isQueryable(l.source_type)) : undefined;
  return named ?? project.links.find((l) => l.source_type === "prometheus") ?? project.links.find((l) => l.source_type === "loki") ?? null;
}

/** The view's range when it reads as one (stored empty or unreadable parts are the default). */
export function exploreTime(time: ExploreView["time"]): TimeSpec {
  if (!time || !time.from.trim() || !time.to.trim()) return DEFAULT_EXPLORE_TIME;
  return resolveTime(time, Math.floor(Date.now() / 1000)) ? time : DEFAULT_EXPLORE_TIME;
}
