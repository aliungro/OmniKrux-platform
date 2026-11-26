import type { MonitoringView } from "../shell/tabState";
import { sourceTypeLabel } from "../sources/sourceLabels";
import type { ProjectKind, SourceOut, TreeDashboard, TreeOut } from "../api/types";

export type SearchEntry = {
  kind: "project" | "group" | "source" | "dashboard" | "page";
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

/**
 * A dashboard opens itself; its subtitle says first whether it is a ready-made view (the part that
 * tells two of one name apart, kept when a narrow list cuts the line), then its owner.
 */
function dashboardEntry(d: TreeDashboard, owner: string): SearchEntry {
  return { kind: "dashboard", id: d.id, name: d.title, subtitle: `${d.ready_made ? "Ready-made view" : "Dashboard"} · ${owner}`, view: { page: "dashboard", id: d.id } };
}

/** Monitoring's own pages, found by name too. */
const PAGES: SearchEntry[] = (
  [["home", "Home"], ["explore", "Explore"], ["alerts", "Alerts"], ["sources", "Sources"], ["import", "Import"]] as const
).map(([page, name]) => ({ kind: "page", id: page, name, subtitle: "Page", view: { page } }));

/**
 * Everything Find can open; with `pages`, Monitoring's own pages too. `clusterNames` (cluster id
 * to name) names a Kubernetes project's cluster; without it the id shows.
 */
export function buildSearchIndex(input: { tree: TreeOut; sources: SourceOut[]; clusterNames?: Record<string, string>; pages?: boolean }): SearchEntry[] {
  const { tree, sources, clusterNames = {} } = input;
  const entries: SearchEntry[] = input.pages ? [...PAGES] : [];
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
    entries.push({ kind: "source", id: s.id, name: s.name, subtitle: sourceTypeLabel(s.type), view: { page: "source", id: s.id } });
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

/** Every entry that matches, best first. */
function matches(index: SearchEntry[], text: string): SearchEntry[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  return index
    .map((entry) => ({ entry, rank: rank(entry, needle) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: "base" }))
    .map((x) => x.entry);
}

/** Case-insensitive: a name that starts with the text, then a word that does, then a name or subtitle containing it; ties by name. */
export function searchMonitoring(index: SearchEntry[], text: string, limit = 8): SearchEntry[] {
  return matches(index, text).slice(0, limit);
}

/** As `searchMonitoring`, and how many more matched than are shown. */
export function findResults(index: SearchEntry[], text: string, limit = 8): { shown: SearchEntry[]; more: number } {
  const all = matches(index, text);
  return { shown: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

const KIND_LABEL: Record<"project" | "group" | "source", string> = { project: "Project", group: "Group", source: "Source" };

/** A result's second line: what it is, then its subtitle. A dashboard's and a page's subtitle say what it is already. */
export function hitSubtitle(hit: SearchEntry): string {
  return hit.kind === "dashboard" || hit.kind === "page" ? hit.subtitle : `${KIND_LABEL[hit.kind]} · ${hit.subtitle}`;
}

/** Said under Find's results when more matched than it shows. */
export const FIND_MORE = "{n} more: keep typing to narrow them down.";
