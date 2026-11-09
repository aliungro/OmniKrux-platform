import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { failure, getJson } from "./http";
import type { MetricsOut, NodeSize, Usage } from "./types";

export const METRICS_POLL_MS = 15_000;
/** Numbers older than this are hidden: a stale number looks like a live one. */
export const LIVE_FOR_MS = 45_000;

/** The part of a query result that decides whether numbers may be shown. */
export interface Snapshot<T> {
  data: T | undefined;
  isError: boolean;
  error?: unknown;
  /** When the last successful poll finished (ms); 0 before there was one. */
  dataUpdatedAt: number;
  /** Old cached numbers whose refetch is on its way: neither shown nor called out of date. */
  awaiting?: boolean;
}

export type MetricsSnapshot = Snapshot<MetricsOut>;

export interface Live {
  usage: Usage | null;
  /** Why there are no numbers, in the words to show; null when nothing is wrong (or nothing yet). */
  why: string | null;
}

/** One cluster's answer; tolerant of an answer that isn't the shape we expect. */
function clusterOf(q: MetricsSnapshot, clusterId: string): MetricsOut["clusters"][string] | undefined {
  const clusters = q.data?.clusters;
  return clusters !== null && typeof clusters === "object" ? clusters[clusterId] : undefined;
}

const NOTHING: Live = { usage: null, why: null };

/** For a cluster that says it has no metrics but not why. */
const NO_MESSAGE = "Metrics not available on this cluster. Check that metrics-server is installed and running in kube-system.";

function outOfDate(reason: string): string {
  return `Metrics are out of date, so they're hidden: ${reason}`;
}

/** The reason every cluster's numbers are hidden right now (a failed or too-old poll), else null. */
export function hiddenWhy(q: Snapshot<unknown>, now: number): string | null {
  // A failed poll hides the numbers it leaves behind: the query keeps the last good data.
  if (q.isError) return outOfDate(failure(q.error, "wait for the next try"));
  if (q.awaiting) return null;
  if (q.data !== undefined && now - q.dataUpdatedAt > LIVE_FOR_MS) {
    return outOfDate(`the console last heard from the server ${Math.round((now - q.dataUpdatedAt) / 1000)} s ago.`);
  }
  return null;
}

/** Why a cluster has no numbers at all (metrics-server missing or not answering), else null. */
export function clusterWhy(q: MetricsSnapshot, clusterId: string, now: number): string | null {
  const hidden = hiddenWhy(q, now);
  if (hidden) return hidden;
  if (q.awaiting) return null;
  const c = clusterOf(q, clusterId);
  return c && c.state !== "ok" ? (c.message ?? NO_MESSAGE) : null;
}

/** One item's usage if, and only if, it is live. `key` is "ns/name" for a pod, "name" for a node. */
export function liveUsage(q: MetricsSnapshot, clusterId: string, key: string, now: number): Live {
  const why = clusterWhy(q, clusterId, now);
  if (why) return { usage: null, why };
  if (q.awaiting) return NOTHING;
  const c = clusterOf(q, clusterId);
  if (!c || c.state !== "ok") return NOTHING;
  return { usage: c.items[key] ?? null, why: null };
}

/** The table's way to ask for a row's or a cluster's live numbers. Identity changes only with the data. */
export interface MetricsLookup {
  usage: (clusterId: string, key: string) => Live;
  why: (clusterId: string) => string | null;
  /** Node capacity from this live pods answer only. */
  nodeSize: (clusterId: string, node: string) => NodeSize | null;
  /** The moment the answers are judged at (ms). */
  now: number;
}

/** Polls every cluster's usage of one kind. */
export function useMetrics(kind: "pods" | "nodes", enabled: boolean) {
  return useQuery({
    queryKey: ["metrics", kind],
    queryFn: () => getJson<MetricsOut>(`/api/metrics/${kind}`),
    refetchInterval: METRICS_POLL_MS,
    retry: false,
    enabled,
  });
}

/**
 * Judges a query's numbers against the clock without a clock tick: one timer per answer fires the
 * moment it turns 45 s old (age taken from Date.now() then, so a sleeping laptop is judged on
 * waking). `scope` names what is being watched (null: nothing); coming back to it, or moving to
 * another, restarts the judgement so a cached old answer shows as loading, not as an alarm.
 */
export function useJudged<T>(
  q: { data: T | undefined; isError: boolean; error?: unknown; dataUpdatedAt: number; isFetching: boolean },
  scope: string | null,
): { snap: Snapshot<T>; now: number } {
  const { data, isError, error, dataUpdatedAt, isFetching } = q;
  const [now, setNow] = useState(() => Date.now());
  const [since, setSince] = useState(() => Date.now());
  const [seen, setSeen] = useState(scope);
  if (seen !== scope) {
    setSeen(scope);
    if (scope !== null) setSince(Date.now());
  }
  useEffect(() => {
    setNow(Date.now());
    if (!dataUpdatedAt || scope === null) return;
    const wait = Math.max(0, dataUpdatedAt + LIVE_FOR_MS - Date.now()) + 50;
    const id = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(id);
  }, [dataUpdatedAt, isError, scope]);
  const awaiting = isFetching && !isError && data !== undefined && dataUpdatedAt < since && now - dataUpdatedAt > LIVE_FOR_MS;
  const snap = useMemo(
    () => ({ data, isError, error, dataUpdatedAt, awaiting }),
    [data, isError, error, dataUpdatedAt, awaiting],
  );
  return { snap, now };
}

/** Live numbers for a table. Its lookup changes only when a poll lands or fails, or the numbers expire. */
export function useLiveMetrics(kind: "pods" | "nodes", enabled: boolean): MetricsLookup | null {
  const q = useMetrics(kind, enabled);
  const { snap, now } = useJudged(q, enabled ? kind : null);
  return useMemo(() => {
    if (!enabled) return null;
    return {
      usage: (clusterId, key) => liveUsage(snap, clusterId, key, now),
      why: (clusterId) => clusterWhy(snap, clusterId, now),
      nodeSize: (clusterId, node) => {
        if (kind !== "pods" || snap.data?.kind !== "pods" || snap.awaiting || hiddenWhy(snap, now)) return null;
        const cluster = clusterOf(snap, clusterId);
        return cluster?.state === "ok" ? (cluster.nodes?.[node] ?? null) : null;
      },
      now,
    };
  }, [enabled, kind, snap, now]);
}
