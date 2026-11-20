import type { TreeOut, TreeProject } from "../api/types";
import type { MonitoringView } from "../shell/tabState";

export type TreeRow = {
  key: string;
  level: 0 | 1;
  kind: "section" | "project" | "group" | "shortcut" | "dashboard" | "empty";
  label: string;
  view?: MonitoringView;
  expanded?: boolean;
  color?: TreeProject["color"];
};

export const SIDEBAR_KEY = "omnikrux.monitoring.sidebar";

export const groupKey = (id: string) => `group:${id}`;
export const projectKey = (id: string) => `project:${id}`;

/**
 * The sidebar's rows: the Groups section, each group with its shortcuts while open, then the
 * Projects section, each project with its dashboards (or "No dashboards yet") while open.
 */
export function treeRows(tree: TreeOut, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [{ key: "section:groups", level: 0, kind: "section", label: "Groups" }];
  const byId = new Map(tree.projects.map((p) => [p.id, p]));
  for (const g of tree.groups) {
    const key = groupKey(g.id);
    const open = expanded.has(key);
    rows.push({ key, level: 0, kind: "group", label: g.name, view: { page: "group", id: g.id }, expanded: open });
    if (!open) continue;
    for (const id of g.project_ids) {
      const p = byId.get(id);
      if (!p) continue;
      rows.push({ key: `${key}/${projectKey(id)}`, level: 1, kind: "shortcut", label: p.name, view: { page: "project", id }, color: p.color });
    }
  }
  rows.push({ key: "section:projects", level: 0, kind: "section", label: "Projects" });
  for (const p of tree.projects) {
    const key = projectKey(p.id);
    const open = expanded.has(key);
    rows.push({ key, level: 0, kind: "project", label: p.name, view: { page: "project", id: p.id }, expanded: open, color: p.color });
    if (!open) continue;
    if (!p.dashboards.length) rows.push({ key: `${key}/empty`, level: 1, kind: "empty", label: "No dashboards yet" });
    for (const d of p.dashboards) rows.push({ key: `${key}/dashboard:${d.id}`, level: 1, kind: "dashboard", label: d.title });
  }
  return rows;
}

/** The open groups and projects, as saved; blocked or damaged storage is none open. */
export function readExpanded(): Set<string> {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? "[]");
    return new Set(Array.isArray(data) ? data.filter((x): x is string => typeof x === "string" && x.length <= 300).slice(0, 500) : []);
  } catch {
    return new Set();
  }
}

export function saveExpanded(keys: ReadonlySet<string>): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, JSON.stringify([...keys]));
  } catch {
    // storage is blocked: the tree opens closed next time
  }
}
