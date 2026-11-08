import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { failure, getJson } from "./http";
import type { MetricsOut, Usage } from "./types";

export const METRICS_POLL_MS = 15_000;
/** Numbers older than this are hidden: a stale number looks like a live one. */
export const LIVE_FOR_MS = 45_000;

/** The part of a query result that decides whether numbers may be shown. */
export interface MetricsSnapshot {
  data: MetricsOut | undefined;
  isError: boolean;
  error?: unknown;
  /** When the last successful poll finished (ms); 0 before there was one. */
  dataUpdatedAt: number;
}

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

function outOfDate(reason: string): string {
  return `Metrics are out of date, so they're hidden: ${reason}`;
}

/** The reason every cluster's numbers are hidden right now (a failed or too-old poll), else null. */
export function hiddenWhy(q: MetricsSnapshot, now: number): string | null {
  // A failed poll hides the numbers it leaves behind: the query keeps the last good data.
  if (q.isError) return outOfDate(failure(q.error, "wait for the next try"));
  if (q.data !== undefined && now - q.dataUpdatedAt > LIVE_FOR_MS) {
    return outOfDate(`the console last heard from the server ${Math.round((now - q.dataUpdatedAt) / 1000)} s ago.`);
  }
  return null;
}

/** Why a cluster has no numbers at all (metrics-server missing or not answering), else null. */
export function clusterWhy(q: MetricsSnapshot, clusterId: string, now: number): string | null {
  const hidden = hiddenWhy(q, now);
  if (hidden) return hidden;
  const c = clusterOf(q, clusterId);
  return c && c.state !== "ok" ? c.message : null;
}

/** One item's usage if, and only if, it is live. `key` is "ns/name" for a pod, "name" for a node. */
export function liveUsage(q: MetricsSnapshot, clusterId: string, key: string, now: number): Live {
  const why = clusterWhy(q, clusterId, now);
  if (why) return { usage: null, why };
  const c = clusterOf(q, clusterId);
  if (!c || c.state !== "ok") return NOTHING;
  return { usage: c.items[key] ?? null, why: null };
}

/** The table's way to ask for a row's or a cluster's live numbers. Identity changes only with the data. */
export interface MetricsLookup {
  usage: (clusterId: string, key: string) => Live;
  why: (clusterId: string) => string | null;
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
 * Live numbers for a table. Re-renders only when a poll lands, fails, or the last good poll turns
 * 45 s old (one timer, not a clock tick), so the table isn't re-rendered for nothing.
 */
export function useLiveMetrics(kind: "pods" | "nodes", enabled: boolean): MetricsLookup | null {
  const q = useMetrics(kind, enabled);
  const { data, isError, error, dataUpdatedAt } = q;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!dataUpdatedAt) return;
    const wait = Math.max(0, dataUpdatedAt + LIVE_FOR_MS - Date.now()) + 50;
    const id = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(id);
  }, [dataUpdatedAt, isError]);
  return useMemo(() => {
    if (!enabled) return null;
    const snap: MetricsSnapshot = { data, isError, error, dataUpdatedAt };
    return {
      usage: (clusterId, key) => liveUsage(snap, clusterId, key, now),
      why: (clusterId) => clusterWhy(snap, clusterId, now),
      now,
    };
  }, [enabled, data, isError, error, dataUpdatedAt, now]);
}
