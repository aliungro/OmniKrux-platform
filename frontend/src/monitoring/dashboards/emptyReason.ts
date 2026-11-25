// Why a query came back empty, in the words the server wrote (`POST /query/why-empty`). Asked only
// after a run answered empty, about exactly the request that ran. Nothing is ever said that the
// check didn't prove: while it runs, when it fails and when it can't tell, the generic words stay.

import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { QueryRequest } from "../api/types";
import { logSelector, scanSelectors } from "../build/promql";
import { whyEmpty, type WhyEmptyIn, type WhyEmptyOut } from "./api";
import type { PanelRun } from "./runPanel";
import type { PanelSpec } from "./schema";

export type EmptySourceType = "prometheus" | "loki";
type Range = { start: number; end: number };

/** The server's limits (`why_empty.py`): a body past them is refused, so it isn't sent. */
const MAX_METRICS = 5;
const MAX_QUERY_CHARS = 10_000;
const MAX_SELECTOR_CHARS = 2000;
const METRIC_NAME = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
const STALE_MS = 5 * 60_000;

/**
 * The check for one request: the query's metric names (unique, the first 5) for Prometheus, its
 * stream selector for Loki. `range` is the range the run read: an instant request carries only
 * its `time`, so a panel passes its run's range (F1). Null when there is nothing to check.
 */
export function emptyCheck(sourceType: EmptySourceType, request: QueryRequest, range?: Range): WhyEmptyIn | null {
  const start = range?.start ?? request.start;
  const end = range?.end ?? request.end;
  const projectId = request.project_id;
  const query = request.query;
  if (!projectId || typeof start !== "number" || typeof end !== "number" || !(end > start)) return null;
  if (query.trim() === "" || query.length > MAX_QUERY_CHARS) return null;
  const base = { source_id: request.source_id, project_id: projectId, query, start, end };
  if (sourceType === "loki") {
    const selector = logSelector(query);
    if (selector === null || selector.length > MAX_SELECTOR_CHARS) return null;
    return { ...base, metrics: [], selector };
  }
  const metrics: string[] = [];
  for (const ref of scanSelectors(query) ?? []) {
    if (ref.metric === null || !METRIC_NAME.test(ref.metric) || metrics.includes(ref.metric)) continue;
    metrics.push(ref.metric);
    if (metrics.length === MAX_METRICS) break;
  }
  return metrics.length > 0 ? { ...base, metrics } : null;
}

/** What to ask about: the request that ran and the range it read. */
export interface EmptyAsk {
  sourceType: EmptySourceType;
  request: QueryRequest;
  range?: Range;
}

/** The words to show, or null when nothing was proved. An instant query's answer doesn't depend
 * on the range, so "try a longer range" would be untrue there (F6). */
function wordsOf(out: WhyEmptyOut, kind: QueryRequest["kind"]): string | null {
  if (out.reason === "unknown" || !out.message) return null;
  if (out.reason === "nothing_matched" && kind === "instant") return null;
  return out.message;
}

/**
 * Why `input`'s empty answer was empty, or null: while the check runs (the generic words stay, so
 * nothing flashes), when it fails, and when it can't tell. One check per request and minute-rounded
 * window, kept 5 minutes. A newer window of the same query keeps the last reason until its own
 * arrives, so a refresh never blinks back to the generic words.
 */
export function useEmptyReason(input: EmptyAsk | null): string | null {
  const body = input ? emptyCheck(input.sourceType, input.request, input.range) : null;
  const kind = input?.request.kind ?? "range";
  const query = useQuery<WhyEmptyOut, unknown>({
    queryKey: body
      ? ["monitoring", "why-empty", body.source_id, body.project_id, body.query, Math.round(body.start / 60), Math.round(body.end / 60)]
      : ["monitoring", "why-empty", null],
    queryFn: ({ signal }) => whyEmpty(body as WhyEmptyIn, signal),
    enabled: body !== null,
    staleTime: STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const identity = body ? JSON.stringify([body.source_id, body.project_id, body.query, kind]) : null;
  const held = useRef<{ identity: string; words: string | null } | null>(null);
  if (identity === null) {
    held.current = null;
    return null;
  }
  if (query.status === "success") {
    const words = wordsOf(query.data, kind);
    held.current = { identity, words };
    return words;
  }
  if (query.status === "pending" && held.current?.identity === identity) return held.current.words;
  return null;
}

/** An empty panel's question: its first request, with the run's range; on a group dashboard the
 * words name the project checked (F5). */
function panelAsk(panel: PanelSpec, run: PanelRun | null): { ask: EmptyAsk; prefix: string } | null {
  if (!run) return null;
  const request = run.requests[0];
  const part = run.parts[0];
  if (!request || !part) return null;
  const type = panel.queries.find((q) => q.ref === part.queryRef)?.source.type;
  if (type !== "prometheus" && type !== "loki") return null;
  return { ask: { sourceType: type, request, range: run.range }, prefix: run.ownerKind === "group" ? `${part.projectName}: ` : "" };
}

/**
 * Why a panel's empty answer was empty. `empty`: the answer shown is empty (and nothing else is
 * said in its place). `settled`: what is shown is this run's own answer (nothing on its way), so the
 * question is about this run; while a newer run is on its way, the question stays the one whose
 * answer is shown. Call it before any early return.
 */
export function usePanelEmptyReason(panel: PanelSpec, run: PanelRun | null, empty: boolean, settled: boolean): string | null {
  const asked = useRef<{ ask: EmptyAsk; prefix: string } | null>(null);
  if (!empty) asked.current = null;
  else if (settled) asked.current = panelAsk(panel, run);
  const words = useEmptyReason(asked.current?.ask ?? null);
  return words !== null && asked.current ? `${asked.current.prefix}${words}` : null;
}
