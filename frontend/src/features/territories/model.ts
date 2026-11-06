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
  | { type: "row"; row: ResourceRow; provider: Provider };

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

export function buildTerritories(clusters: Cluster[], w: WatchState, f: Filters, now: Date): Territory[] {
  return clusters.map((cluster) => {
    const live = w.clusters[cluster.id];
    const all = Array.from(w.rows[cluster.id]?.values() ?? []);
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
  });
}

export function flatten(ts: Territory[]): FlatItem[] {
  const out: FlatItem[] = [];
  for (const t of ts) {
    out.push({ type: "band", t });
    for (const row of t.rows) out.push({ type: "row", row, provider: t.cluster.provider });
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
