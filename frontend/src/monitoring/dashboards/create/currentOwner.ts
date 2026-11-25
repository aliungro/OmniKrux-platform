// Where a new dashboard goes when nothing else is said: the project or group the active tab is
// about, else the one opened most recently that still exists.
import type { TreeOut } from "../../api/types";
import type { RecentItem } from "../../home/recent";
import type { MonitoringView } from "../../shell/tabState";
import type { OwnerKind } from "../schema";

export interface Owner {
  kind: OwnerKind;
  id: string;
  name: string;
}

/** The project or group with this id, as the tree names it; null when it isn't there (any more). */
export function ownerIn(tree: TreeOut, kind: OwnerKind, id: string): Owner | null {
  const found = kind === "project" ? tree.projects.find((p) => p.id === id) : tree.groups.find((g) => g.id === id);
  return found ? { kind, id: found.id, name: found.name } : null;
}

/** The project or group listing this dashboard (saved or ready-made); null when none does. */
export function ownerOfDashboard(tree: TreeOut, dashboardId: string): Owner | null {
  const p = tree.projects.find((x) => x.dashboards.some((d) => d.id === dashboardId));
  if (p) return { kind: "project", id: p.id, name: p.name };
  const g = tree.groups.find((x) => x.dashboards.some((d) => d.id === dashboardId));
  return g ? { kind: "group", id: g.id, name: g.name } : null;
}

/**
 * The project or group of the active tab's view (its page, a dashboard's owner, or the Import
 * page's target); else the most recently opened project or group that still exists; else null.
 */
export function currentOwner(view: MonitoringView, tree: TreeOut, recent: RecentItem[]): Owner | null {
  const here = view.page === "project" || view.page === "group" ? ownerIn(tree, view.page, view.id)
    : view.page === "dashboard" ? ownerOfDashboard(tree, view.id)
    : view.page === "import" && view.target ? ownerIn(tree, view.target.kind, view.target.id)
    : null;
  if (here) return here;
  for (const r of [...recent].sort((a, b) => b.at - a.at)) {
    if (r.kind === "dashboard") continue;
    const owner = ownerIn(tree, r.kind, r.id);
    if (owner) return owner;
  }
  return null;
}

/** "New dashboard", or "New dashboard (2)", (3)… when the owner already has one by that name. */
export function freeTitle(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

/** The titles an owner's saved dashboards use (ready-made views don't take a title). */
export function titlesOf(tree: TreeOut, owner: Pick<Owner, "kind" | "id">): Set<string> {
  const o = owner.kind === "project" ? tree.projects.find((p) => p.id === owner.id) : tree.groups.find((g) => g.id === owner.id);
  return new Set((o?.dashboards ?? []).filter((d) => !d.ready_made).map((d) => d.title));
}
