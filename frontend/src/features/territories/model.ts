import type { Cluster, ClusterState, Provider, ResourceRow, StatusClass } from "../../api/types";
import type { WatchState } from "../../api/watchState";

export interface Filters {
  status: "all" | "failing" | "pending" | "restartedToday";
  text: string;
}

export interface Territory {
  cluster: Cluster;
  state: ClusterState;
  message: string | null;
  rows: ResourceRow[];
  total: number;
  failing: number;
  pending: number;
}

export type FlatItem =
  | { type: "band"; t: Territory }
  | { type: "row"; row: ResourceRow; provider: Provider }
  | { type: "inspector"; row: ResourceRow; provider: Provider };

/** A pod row's identity across clusters; uids are only unique within one cluster. */
export interface RowRef {
  clusterId: string;
  uid: string;
}

/** A string column, or null when the backend sent nothing usable. */
export function textColumn(row: ResourceRow, key: string): string | null {
  const v = row.columns[key];
  return typeof v === "string" ? v : null;
}

const STATUS_CLASSES: readonly string[] = ["ok", "warn", "bad", "done"];

export function statusClass(row: ResourceRow): StatusClass {
  const v = textColumn(row, "status_class");
  return v !== null && STATUS_CLASSES.includes(v) ? (v as StatusClass) : "done";
}

function isFailing(row: ResourceRow): boolean {
  return statusClass(row) === "bad";
}

function isPending(row: ResourceRow): boolean {
  if (statusClass(row) !== "warn") return false;
  const s = textColumn(row, "status") ?? "";
  return s === "Pending" || s === "ContainerCreating" || s.startsWith("Init:");
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function restartedOn(row: ResourceRow, now: Date): boolean {
  const at = textColumn(row, "last_restart_at");
  if (!at) return false;
  const d = new Date(at);
  return !Number.isNaN(d.getTime()) && sameLocalDay(d, now);
}

export function matchesFilter(row: ResourceRow, f: Filters, now: Date): boolean {
  if (f.status === "failing" && !isFailing(row)) return false;
  if (f.status === "pending" && !isPending(row)) return false;
  if (f.status === "restartedToday" && !restartedOn(row, now)) return false;
  const q = f.text.trim().toLowerCase();
  if (!q) return true;
  return [row.name, row.namespace, textColumn(row, "node")].some(
    (v) => v !== null && v.toLowerCase().includes(q),
  );
}

const RANK: Record<StatusClass, number> = { bad: 0, warn: 1, ok: 2, done: 2 };
const byName = new Intl.Collator(undefined, { numeric: true }).compare;

/** Failing first, then pending, then the rest; by name within each group. */
function sortRows(rows: ResourceRow[]): ResourceRow[] {
  return rows
    .map((row) => ({ row, rank: RANK[statusClass(row)] }))
    .sort((a, b) => a.rank - b.rank || byName(a.row.name, b.row.name))
    .map((x) => x.row);
}

type LiveStatus = WatchState["clusters"][string] | undefined;

function buildTerritory(
  cluster: Cluster,
  live: LiveStatus,
  rows: Map<string, ResourceRow> | undefined,
  f: Filters,
  now: Date,
): Territory {
  const all = rows ? Array.from(rows.values()) : [];
  let failing = 0;
  let pending = 0;
  for (const row of all) {
    if (isFailing(row)) failing++;
    if (isPending(row)) pending++;
  }
  return {
    cluster,
    state: live ? live.state : cluster.state,
    message: live ? live.message : cluster.message,
    rows: sortRows(all.filter((row) => matchesFilter(row, f, now))),
    total: all.length,
    failing,
    pending,
  };
}

interface CacheEntry {
  cluster: Cluster;
  live: LiveStatus;
  minute: number;
  territory: Territory;
}

/**
 * Territories by the row Map they were built from (or by the cluster, when it shows no rows),
 * then by filter. A watch update copies only the Maps it touches, so every other cluster hits.
 */
const cache = new WeakMap<object, Map<string, CacheEntry>>();
/** Distinct filters remembered per row Map; typing a search adds one per keystroke. */
const MAX_FILTERS_PER_ROWS = 8;

export function buildTerritories(clusters: Cluster[], w: WatchState, f: Filters, now: Date): Territory[] {
  // Filters only read `now` for its local day, which can't change within a minute.
  const minute = Math.floor(now.getTime() / 60_000);
  const filterKey = `${f.status}\u0000${f.text.trim().toLowerCase()}`;
  return clusters.map((cluster) => {
    const live: LiveStatus = Object.hasOwn(w.clusters, cluster.id) ? w.clusters[cluster.id] : undefined;
    const state = live ? live.state : cluster.state;
    // Rows kept from before an error or a reconnect are not live: never show them as current.
    // ("unknown" only means no status frame yet; any rows present came from a fresh snapshot.)
    const stale = state === "error" || state === "syncing";
    const rows = stale || !Object.hasOwn(w.rows, cluster.id) ? undefined : w.rows[cluster.id];

    const owner: object = rows ?? cluster;
    let byFilter = cache.get(owner);
    if (!byFilter) cache.set(owner, (byFilter = new Map()));
    const hit = byFilter.get(filterKey);
    if (hit && hit.cluster === cluster && hit.live === live && hit.minute === minute) return hit.territory;

    const territory = buildTerritory(cluster, live, rows, f, now);
    if (!hit && byFilter.size >= MAX_FILTERS_PER_ROWS) byFilter.clear();
    byFilter.set(filterKey, { cluster, live, minute, territory });
    return territory;
  });
}

export interface FilterCounts {
  failing: number;
  pending: number;
  restartedToday: number;
}

/** Chip counts over every live row, whatever filter is active. Pass territories built with status "all" and no text. */
export function countFilters(ts: Territory[], now: Date): FilterCounts {
  const out: FilterCounts = { failing: 0, pending: 0, restartedToday: 0 };
  for (const t of ts) {
    if (t.state !== "ready") continue;
    out.failing += t.failing;
    out.pending += t.pending;
    for (const row of t.rows) if (restartedOn(row, now)) out.restartedToday++;
  }
  return out;
}

/** Pods across ready clusters; null while no cluster has reported, so the UI never shows a made-up 0. */
export function podCount(ts: Territory[]): number | null {
  const ready = ts.filter((t) => t.state === "ready");
  return ready.length === 0 ? null : ready.reduce((n, t) => n + t.total, 0);
}

/** Bands and rows in display order, with the inspector right after the `inspect` row when it's shown. */
export function flatten(ts: Territory[], inspect: RowRef | null = null): FlatItem[] {
  const out: FlatItem[] = [];
  for (const t of ts) {
    const provider = t.cluster.provider;
    out.push({ type: "band", t });
    const here = inspect !== null && inspect.clusterId === t.cluster.id;
    for (const row of t.rows) {
      out.push({ type: "row", row, provider });
      if (here && row.uid === inspect.uid) out.push({ type: "inspector", row, provider });
    }
  }
  return out;
}

/** Compact age: 45s, 12m, 3h, 9d. "—" when the creation time is unknown. */
export function formatAge(createdAt: string | null, now: Date): string {
  if (!createdAt) return "—";
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
