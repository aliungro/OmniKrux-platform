import type { MonitoringView } from "../shell/tabState";
import type { ProjectKind, SourceOut, TreeDashboard, TreeOut } from "../api/types";

export type SearchEntry = {
  kind: "project" | "group" | "source" | "dashboard";
  id: string;
  name: string;
  subtitle: string;
  view: MonitoringView;
};

function projectSubtitle(kind: ProjectKind, cluster: string | null | undefined): string {
  switch (kind) {
    case "kubernetes": return cluster ? `Kubernetes · ${cluster}` : "Kubernetes";
    case "docker": return "Docker host";
    case "servers": return "Servers";
    case "custom": return "Your own project";
  }
}

/** A dashboard opens itself; its subtitle names its owner and whether it is a ready-made view. */
function dashboardEntry(d: TreeDashboard, owner: string): SearchEntry {
  return { kind: "dashboard", id: d.id, name: d.title, subtitle: `${owner} · ${d.ready_made ? "Ready-made" : "Dashboard"}`, view: { page: "dashboard", id: d.id } };
}

/** Everything Find can open. `clusterNames` (cluster id to name) names a Kubernetes project's cluster; without it the id shows. */
export function buildSearchIndex(input: { tree: TreeOut; sources: SourceOut[]; clusterNames?: Record<string, string> }): SearchEntry[] {
  const { tree, sources, clusterNames = {} } = input;
  const entries: SearchEntry[] = [];
  for (const p of tree.projects) {
    const cluster = p.cluster_id ? (clusterNames[p.cluster_id] ?? p.cluster_id) : null;
    entries.push({ kind: "project", id: p.id, name: p.name, subtitle: projectSubtitle(p.kind, cluster), view: { page: "project", id: p.id } });
    for (const d of p.dashboards) entries.push(dashboardEntry(d, p.name));
  }
  for (const g of tree.groups) {
    entries.push({ kind: "group", id: g.id, name: g.name, subtitle: `${g.project_ids.length} ${g.project_ids.length === 1 ? "project" : "projects"}`, view: { page: "group", id: g.id } });
    for (const d of g.dashboards) entries.push(dashboardEntry(d, g.name));
  }
  for (const s of sources) {
    entries.push({ kind: "source", id: s.id, name: s.name, subtitle: s.type === "loki" ? "Loki" : "Prometheus-compatible", view: { page: "source", id: s.id } });
  }
  return entries;
}

const WORD_BREAK = /[\s\-_./:·]+/;

function rank(entry: SearchEntry, text: string): number {
  const name = entry.name.toLowerCase();
  if (name.startsWith(text)) return 0;
  if (name.split(WORD_BREAK).some((w) => w.startsWith(text))) return 1;
  if (name.includes(text)) return 2;
  if (entry.subtitle.toLowerCase().includes(text)) return 3;
  return -1;
}

/** Case-insensitive: a name that starts with the text, then a word that does, then a name or subtitle containing it; ties by name. */
export function searchMonitoring(index: SearchEntry[], text: string, limit = 8): SearchEntry[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  return index
    .map((entry) => ({ entry, rank: rank(entry, needle) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: "base" }))
    .slice(0, limit)
    .map((x) => x.entry);
}
