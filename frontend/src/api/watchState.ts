import type { ClusterState, ResourceRow, WatchMessage } from "./types";

export interface WatchState {
  clusters: Record<string, { state: ClusterState; message: string | null }>;
  rows: Record<string, Map<string, ResourceRow>>;
  pending: Record<string, ResourceRow[]>;
  snapshotReady: ReadonlySet<string>;
  nextSnapshotPart: Readonly<Record<string, number>>;
}

export function emptyWatchState(): WatchState {
  return { clusters: {}, rows: {}, pending: {}, snapshotReady: new Set(), nextSnapshotPart: {} };
}

export function hasCurrentSnapshot(watch: WatchState, clusterId: string): boolean {
  return watch.clusters[clusterId]?.state === "ready" && watch.snapshotReady.has(clusterId);
}

export function applyMessage(s: WatchState, m: WatchMessage): WatchState {
  return applyMessages(s, [m]);
}

/**
 * Applies a batch of messages in order. Pure: neither `s` nor the messages are mutated, and
 * clusters the batch does not touch keep their objects. Each touched cluster's row Map (and
 * snapshot buffer) is copied at most once per batch, then written in place.
 */
export function applyMessages(s: WatchState, ms: readonly WatchMessage[]): WatchState {
  let { clusters, rows, pending } = s;
  let snapshotReady: Set<string> | undefined;
  let nextSnapshotPart: Record<string, number> | undefined;
  let changed = false;
  // Records and per-cluster containers created by this batch, so safe to write in place.
  let ownClusters = false;
  let ownRows = false;
  let ownPending = false;
  const ownMaps = new Set<string>();
  const ownParts = new Set<string>();

  const clustersW = () => {
    if (!ownClusters) clusters = { ...clusters };
    ownClusters = changed = true;
    return clusters;
  };
  const rowsW = () => {
    if (!ownRows) rows = { ...rows };
    ownRows = changed = true;
    return rows;
  };
  const pendingW = () => {
    if (!ownPending) pending = { ...pending };
    ownPending = changed = true;
    return pending;
  };
  const mapW = (id: string) => {
    if (ownMaps.has(id)) return rows[id];
    const next = new Map(Object.hasOwn(rows, id) ? rows[id] : []);
    rowsW()[id] = next;
    ownMaps.add(id);
    return next;
  };
  const setSnapshotReady = (id: string, ready: boolean) => {
    if ((snapshotReady ?? s.snapshotReady).has(id) === ready) return;
    snapshotReady ??= new Set(s.snapshotReady);
    changed = true;
    if (ready) snapshotReady.add(id);
    else snapshotReady.delete(id);
  };
  const setNextSnapshotPart = (id: string, part: number | undefined) => {
    const parts = nextSnapshotPart ?? s.nextSnapshotPart;
    if ((Object.hasOwn(parts, id) ? parts[id] : undefined) === part) return;
    nextSnapshotPart ??= { ...s.nextSnapshotPart };
    changed = true;
    if (part === undefined) delete nextSnapshotPart[id];
    else nextSnapshotPart[id] = part;
  };

  for (const m of ms) {
    const id = m.cluster_id;
    switch (m.type) {
      case "cluster_status": {
        if (m.state !== "ready") {
          setSnapshotReady(id, false);
          setNextSnapshotPart(id, undefined);
        }
        const prev = Object.hasOwn(clusters, id) ? clusters[id] : undefined;
        if (prev && prev.state === m.state && prev.message === m.message) break;
        clustersW()[id] = { state: m.state, message: m.message };
        break;
      }
      case "snapshot": {
        // Row buffering stays independent of the sequence required for freshness.
        const parts = nextSnapshotPart ?? s.nextSnapshotPart;
        const ordered = m.part === 0 || (Object.hasOwn(parts, id) && parts[id] === m.part);
        setSnapshotReady(id, ordered && m.last);
        setNextSnapshotPart(id, ordered && !m.last ? m.part + 1 : undefined);
        // A new part 0 discards any parts buffered from an earlier, unfinished snapshot.
        const buffered = m.part !== 0 && Object.hasOwn(pending, id) ? pending[id] : undefined;
        if (m.last) {
          const next = new Map<string, ResourceRow>();
          for (const r of buffered ?? []) next.set(r.uid, r);
          for (const r of m.rows) next.set(r.uid, r);
          rowsW()[id] = next;
          ownMaps.add(id);
          if (Object.hasOwn(pending, id)) delete pendingW()[id];
          ownParts.delete(id);
        } else if (buffered && ownParts.has(id)) {
          for (const r of m.rows) buffered.push(r);
        } else {
          pendingW()[id] = buffered ? [...buffered, ...m.rows] : [...m.rows];
          ownParts.add(id);
        }
        break;
      }
      case "upsert":
        mapW(id).set(m.row.uid, m.row);
        break;
      case "delete":
        if (Object.hasOwn(rows, id) && rows[id].has(m.uid)) mapW(id).delete(m.uid);
        break;
      case "cluster_removed":
        setSnapshotReady(id, false);
        setNextSnapshotPart(id, undefined);
        if (Object.hasOwn(clusters, id)) delete clustersW()[id];
        if (Object.hasOwn(rows, id)) delete rowsW()[id];
        if (Object.hasOwn(pending, id)) delete pendingW()[id];
        ownMaps.delete(id);
        ownParts.delete(id);
        break;
      default:
        break;
    }
  }
  return changed ? {
    clusters,
    rows,
    pending,
    snapshotReady: snapshotReady ?? s.snapshotReady,
    nextSnapshotPart: nextSnapshotPart ?? s.nextSnapshotPart,
  } : s;
}

export function resetForReconnect(s: WatchState): WatchState {
  const clusters: WatchState["clusters"] = {};
  for (const id of new Set([...Object.keys(s.clusters), ...Object.keys(s.rows)])) {
    clusters[id] = { state: "syncing", message: null };
  }
  return {
    clusters,
    rows: s.rows,
    pending: {},
    snapshotReady: s.snapshotReady.size ? new Set() : s.snapshotReady,
    nextSnapshotPart: {},
  };
}
