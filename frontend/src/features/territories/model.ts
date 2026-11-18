import { compileColumnFilters, compareKeys, sortKey, type ColumnFilter, type SortSpec } from "./columnFilters";
import type { Cluster, ClusterState, ColumnSpec, KindInfo, KindsResponse, Provider, ResourceRow, StatusClass } from "../../api/types";
import type { WatchState } from "../../api/watchState";

export const FILTER_STATUSES = ["all", "failing", "pending", "restartedToday", "warnings"] as const;
export type FilterStatus = typeof FILTER_STATUSES[number];

export interface Filters {
  status: FilterStatus;
  columns: ColumnFilter[];
  sort: SortSpec | null;
  text: string;
  /** One namespace, or null for all of them. */
  namespace: string | null;
}

export const NO_FILTER: Filters = { status: "all", text: "", namespace: null, columns: [], sort: null };

export function isNoFilter(f: Filters): boolean {
  return f.status === "all" && f.text.trim() === "" && f.namespace === null && f.columns.length === 0 && f.sort === null;
}

export interface Territory {
  cluster: Cluster;
  state: ClusterState;
  message: string | null;
  rows: ResourceRow[];
  total: number;
  failing: number;
  pending: number;
  /**
   * Set on an absent territory when the cluster's discovery couldn't read the kind's API group:
   * the kind may well be there, so the band says that, not "doesn't serve" (Ruling R36).
   */
  discoveryFailed?: string;
}

export type FlatItem =
  | { type: "band"; t: Territory }
  | { type: "row"; row: ResourceRow; provider: Provider }
  | { type: "inspector"; row: ResourceRow; provider: Provider };

/** A row's identity across clusters; uids are only unique within one cluster. */
export interface RowRef {
  clusterId: string;
  uid: string;
}

/** The table's current row, and whether its details are open under it. Console holds it. */
export interface Selection {
  selected: RowRef | null;
  open: boolean;
}

export const NO_SELECTION: Selection = { selected: null, open: false };

/** The key a row is known by across clusters (uids are only unique within one). */
export function rowKey(clusterId: string, uid: string): string {
  return `${clusterId}/${uid}`;
}

/* Kinds -------------------------------------------------------------------------------------- */

const col = (key: string, label: string, type: ColumnSpec["type"] = "text", width: ColumnSpec["width"] = "m"): ColumnSpec =>
  ({ key, label, type, width });

/**
 * What the table shows of a kind before GET /api/kinds has answered, or when no cluster lists it:
 * the pods view as the backend defines it, and Name, Namespace and Age for anything else.
 */
export function fallbackKind(key: string): KindInfo {
  const pods = key === "pods";
  // "certificates.cert-manager.io" reads as "certificates" until the catalog names it.
  const [plural, ...group] = key.split(".");
  return {
    key,
    group: group.join("."),
    version: "v1",
    kind: pods ? "Pod" : plural,
    plural,
    label: pods ? "Pod" : plural,
    plural_label: plural,
    namespaced: true,
    short_names: [],
    columns: pods
      ? [
          col("name", "Name", "text", "l"), col("namespace", "Namespace"), col("status", "Status", "status"),
          col("ready", "Ready", "text", "s"), col("restarts", "Restarts", "number", "s"), col("cpu", "CPU", "cpu", "s"),
          col("memory", "Memory", "memory", "s"), col("node", "Node"), col("age", "Age", "age", "s"),
        ]
      : [col("name", "Name", "text", "l"), col("namespace", "Namespace"), col("age", "Age", "age", "s")],
    sort: "status",
    builtin: pods,
    verbs: [],
    clusters: [],
  };
}

export const POD_KIND = fallbackKind("pods");

/** Tab names for the everyday kinds (sentence case, as kubectl's kinds are written). */
const TITLES: Record<string, string> = {
  pods: "Pods",
  "deployments.apps": "Deployments",
  "statefulsets.apps": "StatefulSets",
  "daemonsets.apps": "DaemonSets",
  "jobs.batch": "Jobs",
  services: "Services",
  "ingresses.networking.k8s.io": "Ingresses",
  nodes: "Nodes",
  events: "Events",
  "helm-releases": "Helm releases",
};

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The kind's plural name as a title: "Deployments", "Helm releases", "Certificates". When the plural
 * is a regular plural of the API Kind, the Kind's casing is kept ("ConfigMaps", "NetworkPolicies").
 */
export function kindTitle(kind: Pick<KindInfo, "key" | "plural_label"> & Partial<Pick<KindInfo, "kind">>): string {
  const known = TITLES[kind.key];
  if (known) return known;
  const p = kind.plural_label;
  const k = kind.kind;
  if (k) {
    const lower = k.toLowerCase();
    if (p === lower) return capitalised(k);
    if (p === `${lower}s`) return `${capitalised(k)}s`;
    if (p === `${lower}es`) return `${capitalised(k)}es`;
    if (lower.endsWith("y") && p === `${lower.slice(0, -1)}ies`) return `${capitalised(k).slice(0, -1)}ies`;
  }
  return capitalised(p);
}

/** "1 pod", "48 pods", "1 Helm release", "3 deployments". */
export function countNoun(kind: Pick<KindInfo, "label" | "plural_label">, n: number): string {
  if (n !== 1) return `${n} ${kind.plural_label}`;
  // A lower-case plural ("deployments") pairs with a lower-case singular; "Helm releases" keeps its case.
  const lower = kind.plural_label.charAt(0) === kind.plural_label.charAt(0).toLowerCase();
  return `1 ${lower ? kind.label.toLowerCase() : kind.label}`;
}

export function hasStatus(kind: Pick<KindInfo, "columns">): boolean {
  return kind.columns.some((c) => c.type === "status");
}

/* Rows --------------------------------------------------------------------------------------- */

/** A string column, or null when the backend sent nothing usable. */
export function textColumn(row: ResourceRow, key: string): string | null {
  const v = row.columns[key];
  return typeof v === "string" ? v : null;
}

/**
 * The column that names a row to people: `name`, except for a Helm release, whose row is its
 * revision's Secret (the name the API knows it by) and whose `release` column names the release.
 */
export function titleColumn(row: ResourceRow): "name" | "release" {
  return row.kind === "HelmRelease" && textColumn(row, "release") ? "release" : "name";
}

/** What a row is called in titles and labels; API paths always use `row.name`. */
export function rowTitle(row: ResourceRow): string {
  return titleColumn(row) === "release" ? (textColumn(row, "release") ?? row.name) : row.name;
}

const STATUS_CLASSES: readonly string[] = ["ok", "warn", "bad", "done"];

export function statusClass(row: ResourceRow): StatusClass {
  const v = textColumn(row, "status_class");
  return v !== null && STATUS_CLASSES.includes(v) ? (v as StatusClass) : "done";
}

export function isFailing(row: ResourceRow): boolean {
  return statusClass(row) === "bad";
}

/** Pods: waiting to run. Other kinds: any warning (rolling out, not ready, unknown). */
function isPending(row: ResourceRow, kindKey: string): boolean {
  if (statusClass(row) !== "warn") return false;
  if (kindKey !== "pods") return true;
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

function matchesStatus(row: ResourceRow, status: FilterStatus, now: Date, kindKey: string): boolean {
  switch (status) {
    case "all":
      return true;
    case "failing":
      return isFailing(row);
    case "pending":
      return isPending(row, kindKey);
    case "restartedToday":
      return restartedOn(row, now);
    case "warnings":
      return statusClass(row) === "warn";
  }
}

/** A chip above the table: a status filter with its count. */
export interface ChipDef {
  status: Exclude<FilterStatus, "all">;
  label: string;
  /** Failing: the rose diamond; pending and warnings: the amber ring (the row status shapes). */
  icon?: "diamond" | "ring";
}

const FAILING: ChipDef = { status: "failing", label: "Failing", icon: "diamond" };
const PENDING: ChipDef = { status: "pending", label: "Pending", icon: "ring" };

/** The status chips a kind offers; none for a kind without a status. */
export function chipsFor(kind: Pick<KindInfo, "key" | "columns">): ChipDef[] {
  if (kind.key === "pods") return [FAILING, PENDING, { status: "restartedToday", label: "Restarted today" }];
  if (kind.key === "events") return [{ status: "warnings", label: "Warnings", icon: "ring" }];
  return hasStatus(kind) ? [FAILING, PENDING] : [];
}

/** Whether the text is in a row's title, name, namespace, node, labels or images. */
function matchesText(row: ResourceRow, q: string): boolean {
  if (rowTitle(row).toLowerCase().includes(q)) return true;
  if (row.name.toLowerCase().includes(q)) return true;
  if (row.namespace !== null && row.namespace.toLowerCase().includes(q)) return true;
  const node = textColumn(row, "node");
  if (node !== null && node.toLowerCase().includes(q)) return true;
  if (row.labels) {
    for (const k in row.labels) if (`${k}=${row.labels[k]}`.toLowerCase().includes(q)) return true;
  }
  const images = row.columns.images;
  if (Array.isArray(images)) {
    for (const image of images) if (typeof image === "string" && image.toLowerCase().includes(q)) return true;
  }
  return false;
}

export function compileFilters(f: Filters, kind: Pick<KindInfo, "key" | "columns">, now: Date): (row: ResourceRow) => boolean {
  const columns = compileColumnFilters(f.columns, kind.columns, now);
  const q = f.text.trim().toLowerCase();
  return row => matchesStatus(row, f.status, now, kind.key) && (f.namespace === null || row.namespace === f.namespace) && (q === "" || matchesText(row, q)) && columns(row);
}
export function matchesFilter(row: ResourceRow, f: Filters, now: Date, kind: Pick<KindInfo, "key" | "columns"> | string = POD_KIND): boolean {
  return compileFilters(f, typeof kind === "string" ? { key: kind, columns: [] } : kind, now)(row);
}

/** Keep each independent filter that still shows a navigation target. */
export function showingFilters(row: ResourceRow, f: Filters, kind: Pick<KindInfo, "key" | "columns">, now: Date): Filters {
  const columns = compileColumnFilters(f.columns, kind.columns, now).matching(row);
  const status = matchesStatus(row, f.status, now, kind.key) ? f.status : "all";
  const q = f.text.trim().toLowerCase();
  const text = q === "" || matchesText(row, q) ? f.text : "";
  const namespace = f.namespace === null || row.namespace === null || f.namespace === row.namespace ? f.namespace : null;
  return status === f.status && namespace === f.namespace && text === f.text && columns.length === f.columns.length
    ? f : { ...f, status, namespace, text, columns };
}

const RANK: Record<StatusClass, number> = { bad: 0, warn: 1, ok: 2, done: 2 };
const byName = new Intl.Collator(undefined, { numeric: true }).compare;

/** When something last happened to a row (`last_seen`, `updated`), else when it was made; -Infinity if never. */
function recency(row: ResourceRow): number {
  const at = textColumn(row, "last_seen") ?? textColumn(row, "updated") ?? row.created_at;
  const t = at ? new Date(at).getTime() : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

/** `status`: failing first, then pending, then the rest, by name within each. `recent`: newest first. */
function sortRows(rows: ResourceRow[], sort: KindInfo["sort"], spec: SortSpec | null, columns: readonly ColumnSpec[]): ResourceRow[] {
  const col = spec && columns.find(c => c.key === spec.key && !["cpu", "memory", "pods"].includes(c.type));
  if (col && spec) return rows.map(row => ({row, key: sortKey(row, col)})).sort((a,b) => compareKeys(a.key,b.key,spec.dir) || byName(a.row.name,b.row.name)).map(x => x.row);
  if (sort === "recent") {
    return rows
      .map((row) => ({ row, at: recency(row) }))
      .sort((a, b) => (b.at === a.at ? byName(a.row.name, b.row.name) : b.at > a.at ? 1 : -1))
      .map((x) => x.row);
  }
  return rows
    .map((row) => ({ row, rank: RANK[statusClass(row)] }))
    .sort((a, b) => a.rank - b.rank || byName(a.row.name, b.row.name))
    .map((x) => x.row);
}

/* Territories -------------------------------------------------------------------------------- */

type LiveStatus = WatchState["clusters"][string] | undefined;

/**
 * A cluster's state for a kind its watch hasn't reported on yet. The cluster list's state sums up
 * the cluster's other watches: its error holds for every kind (it can't be reached), but its
 * "ready" says nothing about this kind's rows, which haven't arrived.
 */
function notYetWatched(cluster: Cluster): { state: ClusterState; message: string | null } {
  return cluster.state === "error" ? { state: "error", message: cluster.message } : { state: "unknown", message: null };
}

function buildTerritory(
  cluster: Cluster,
  live: LiveStatus,
  rows: Map<string, ResourceRow> | undefined,
  f: Filters,
  kind: KindInfo,
  predicate: (row: ResourceRow) => boolean,
): Territory {
  const all = rows ? Array.from(rows.values()) : [];
  let failing = 0;
  let pending = 0;
  for (const row of all) {
    if (isFailing(row)) failing++;
    if (isPending(row, kind.key)) pending++;
  }
  const fallback = notYetWatched(cluster);
  return {
    cluster,
    state: live ? live.state : fallback.state,
    message: live ? live.message : fallback.message,
    rows: sortRows(all.filter(predicate), kind.sort, f.sort, kind.columns),
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
 * then by kind and filter. A watch update copies only the Maps it touches, so every other cluster hits.
 */
const cache = new WeakMap<object, Map<string, CacheEntry>>();
/** Distinct filters remembered per row Map; typing a search adds one per keystroke. */
const MAX_FILTERS_PER_ROWS = 8;

export function buildTerritories(
  clusters: Cluster[],
  w: WatchState,
  f: Filters,
  now: Date,
  kind: KindInfo = POD_KIND,
): Territory[] {
  // Relative time filters can cross their boundary at any instant.
  const minute = f.columns.some(c => c.op === "within" || c.op === "olderThan")
    ? now.getTime() : Math.floor(now.getTime() / 60_000);
  // The kind's columns are part of the key: a filter restored before /api/kinds answers can't
  // apply to the fallback columns, and must apply as soon as the real columns arrive.
  const columnKeys = kind.columns.map(c => c.key).join(",");
  const filterKey = [kind.key, kind.sort, columnKeys, f.status, f.namespace ?? "", f.text.trim().toLowerCase(), JSON.stringify(f.columns), JSON.stringify(f.sort)].join("\u0000");
  const predicate = compileFilters(f, kind, now);
  return clusters.map((cluster) => {
    const live: LiveStatus = Object.hasOwn(w.clusters, cluster.id) ? w.clusters[cluster.id] : undefined;
    const state = live ? live.state : notYetWatched(cluster).state;
    // Rows kept from before an error or a reconnect are not live: never show them as current.
    // ("unknown" only means no status frame yet; any rows present came from a fresh snapshot.)
    // An absent kind has no rows on that cluster at all.
    const hidden = state === "error" || state === "syncing" || state === "absent";
    const rows = hidden || !Object.hasOwn(w.rows, cluster.id) ? undefined : w.rows[cluster.id];

    const owner: object = rows ?? cluster;
    let byFilter = cache.get(owner);
    if (!byFilter) cache.set(owner, (byFilter = new Map()));
    const hit = byFilter.get(filterKey);
    if (hit && hit.cluster === cluster && hit.live === live && hit.minute === minute) return hit.territory;

    const territory = buildTerritory(cluster, live, rows, f, kind, predicate);
    if (!hit && byFilter.size >= MAX_FILTERS_PER_ROWS) byFilter.clear();
    byFilter.set(filterKey, { cluster, live, minute, territory });
    return territory;
  });
}

/** Chip counts by filter, over every live row whatever filter is active. */
export type FilterCounts = Partial<Record<FilterStatus, number>>;

/**
 * Pass territories built with no filter. Only ready territories count (never absent or stale ones);
 * with none ready, there are no counts at all rather than made-up zeros.
 */
export function countFilters(ts: Territory[], now: Date, kind: Pick<KindInfo, "key" | "columns"> = POD_KIND): FilterCounts {
  const chips = chipsFor(kind);
  const out: FilterCounts = {};
  if (!ts.some((t) => t.state === "ready")) return out;
  for (const c of chips) out[c.status] = 0;
  for (const t of ts) {
    if (t.state !== "ready") continue;
    for (const c of chips) {
      if (c.status === "failing") out.failing! += t.failing;
      else if (c.status === "pending") out.pending! += t.pending;
      else for (const row of t.rows) if (matchesStatus(row, c.status, now, kind.key)) out[c.status]! += 1;
    }
  }
  return out;
}

/**
 * Marks absent territories whose cluster couldn't read the kind's API group in its last discovery
 * (GET /api/kinds `failed_groups`). Returns `ts` itself when there's nothing to mark.
 */
export function withDiscoveryFailures(
  ts: Territory[],
  clusters: KindsResponse["clusters"] | undefined,
  kind: Pick<KindInfo, "group" | "plural_label">,
): Territory[] {
  if (!clusters) return ts;
  let out: Territory[] | null = null;
  ts.forEach((t, i) => {
    if (t.state !== "absent") return;
    const failed = Object.hasOwn(clusters, t.cluster.id) ? clusters[t.cluster.id].failed_groups : undefined;
    const reason = failed && Object.hasOwn(failed, kind.group) ? failed[kind.group] : undefined;
    if (reason === undefined) return;
    out ??= ts.slice();
    out[i] = { ...t, discoveryFailed: `Can't list ${kind.plural_label} on this cluster right now: ${reason}` };
  });
  return out ?? ts;
}

/** Rows across ready clusters; null while no cluster has reported, so the UI never shows a made-up 0. */
export function kindCount(ts: Territory[]): number | null {
  const ready = ts.filter((t) => t.state === "ready");
  return ready.length === 0 ? null : ready.reduce((n, t) => n + t.total, 0);
}

/** The namespaces of the rows on screen (ready clusters, before filtering), sorted. */
export function namespacesIn(ts: Territory[]): string[] {
  const seen = new Set<string>();
  for (const t of ts) {
    if (t.state !== "ready") continue;
    for (const row of t.rows) if (row.namespace !== null) seen.add(row.namespace);
  }
  return Array.from(seen).sort(byName);
}

/**
 * Pods on each node of each cluster whose pod watch is live, not counting Completed ones. A
 * cluster missing from the map has no live count (its nodes show "—", never a stale number).
 */
export function podsPerNode(w: WatchState): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const id of Object.keys(w.rows)) {
    if (w.clusters[id]?.state !== "ready") continue;
    const perNode = new Map<string, number>();
    for (const row of w.rows[id].values()) {
      const node = textColumn(row, "node");
      if (node === null || textColumn(row, "status") === "Completed") continue;
      perNode.set(node, (perNode.get(node) ?? 0) + 1);
    }
    out.set(id, perNode);
  }
  return out;
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

/** Compact age: 45s, 12m, 3h, 9d. "—" when the time is unknown. */
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

/** How long ago a moment was: "2m ago"; "—" when unknown. */
export function formatAgo(at: string | null, now: Date): string {
  const age = formatAge(at, now);
  return age === "—" ? age : `${age} ago`;
}

/** `pools` is null when the cloud couldn't list them: unknown, never "0 node pools". */
export function poolSummary(pools: number | null, nodes: number | null): string {
  const poolText = pools === null ? "node pools unknown" : `${pools} node ${pools === 1 ? "pool" : "pools"}`;
  return nodes === null ? poolText : `${poolText} · ${nodes} ${nodes === 1 ? "node" : "nodes"}`;
}

export function clusterPoolSummary(cluster: Cluster): string | null {
  const nodes = cluster.node_count ?? null;
  if (cluster.source !== "cloud") {
    const pools = cluster.node_pools?.length ?? 0;
    return pools === 0 && nodes === null ? null : poolSummary(pools, nodes);
  }
  return poolSummary(cluster.node_pools ? cluster.node_pools.length : null, nodes);
}
