import type { ClusterState, ResourceRow, WatchMessage } from "./types";

export interface WatchState {
  clusters: Record<string, { state: ClusterState; message: string | null }>;
  rows: Record<string, Map<string, ResourceRow>>;
  pending: Record<string, ResourceRow[]>;
}

export function emptyWatchState(): WatchState {
  return { clusters: {}, rows: {}, pending: {} };
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const rest = { ...rec };
  delete rest[key];
  return rest;
}

export function applyMessage(s: WatchState, m: WatchMessage): WatchState {
  const id = m.cluster_id;
  switch (m.type) {
    case "cluster_status":
      return {
        ...s,
        clusters: { ...s.clusters, [id]: { state: m.state, message: m.message } },
      };
    case "snapshot": {
      const buffered = m.part === 0 ? [] : (s.pending[id] ?? []);
      const all = [...buffered, ...m.rows];
      if (!m.last) return { ...s, pending: { ...s.pending, [id]: all } };
      return {
        ...s,
        rows: { ...s.rows, [id]: new Map(all.map((r) => [r.uid, r])) },
        pending: without(s.pending, id),
      };
    }
    case "upsert": {
      const next = new Map(s.rows[id] ?? []);
      next.set(m.row.uid, m.row);
      return { ...s, rows: { ...s.rows, [id]: next } };
    }
    case "delete": {
      const prev = s.rows[id];
      if (!prev || !prev.has(m.uid)) return s;
      const next = new Map(prev);
      next.delete(m.uid);
      return { ...s, rows: { ...s.rows, [id]: next } };
    }
  }
}

export function resetForReconnect(s: WatchState): WatchState {
  const clusters: WatchState["clusters"] = {};
  for (const id of new Set([...Object.keys(s.clusters), ...Object.keys(s.rows)])) {
    clusters[id] = { state: "syncing", message: null };
  }
  return { clusters, rows: s.rows, pending: {} };
}
