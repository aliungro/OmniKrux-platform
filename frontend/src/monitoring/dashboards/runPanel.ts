// A panel's run: which query goes to which project and source (`buildPanelRun`), how the
// answers become one honest panel state (`mergePanelResults`), and the hook that runs it
// (`usePanelData`). The browser never talks to a tool: every request goes through
// `POST /query/batch` with its project, so the project's filter always applies.

import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GroupOut, ProjectOut, QueryRequest, QueryErrorCode } from "../api/types";
import { DashboardRequestError, runBatch, type BatchItemOut } from "./api";
import { interpolate, VariableError, type ResolvedVars } from "./interpolate";
import { legendName } from "./legend";
import type { OwnerKind, PanelSpec, PanelType, QuerySpec } from "./schema";
import { alignRange, stepFor } from "./time";

// --- Runs -------------------------------------------------------------------------------------

/** Who a dashboard belongs to; a group's `members` are already narrowed by its Projects choice. */
export type DashboardOwner =
  | { kind: "project"; project: ProjectOut }
  | { kind: "group"; group: GroupOut; members: ProjectOut[] };

/** One request's place in the panel: `requests[i]` is `parts[i]`. */
export type RunPart = { queryRef: string; projectId: string; projectName: string; sourceName: string };
/** A query (on one project, or on all when `projectName` is null) that isn't sent, and why. */
export type SkippedPart = { queryRef: string; projectName: string | null; message: string; state: "error" };

export interface PanelRun {
  requests: QueryRequest[];
  parts: RunPart[];
  skipped: SkippedPart[];
  ownerKind: OwnerKind;
  /** The range sent: aligned to the step for range queries. */
  range: { start: number; end: number };
  step: number;
}

const BATCH_SIZE = 64;
const SOURCE_WORDS: Record<QuerySpec["source"]["type"], string> = {
  prometheus: "Prometheus-compatible",
  loki: "Loki",
};

const noSource = (project: string, type: QuerySpec["source"]["type"]) => `${project} has no ${SOURCE_WORDS[type]} source.`;
const unlinked = (project: string) =>
  `This panel's source isn't linked to ${project} any more. Pick another in the panel's Query tab.`;

export function queryKindFor(type: PanelType): "range" | "instant" {
  return type === "bar" || type === "table" ? "instant" : "range";
}

/**
 * The requests for one panel: each shown, non-empty query on each project (one for a project
 * dashboard), with its variables substituted. A query whose value can't be placed safely is
 * skipped with the reason; never sent unsubstituted.
 */
export function buildPanelRun(input: {
  panel: PanelSpec;
  owner: DashboardOwner;
  vars: ResolvedVars;
  range: { start: number; end: number };
  ownerName: string;
}): PanelRun {
  const { panel, owner, vars, range } = input;
  const kind = queryKindFor(panel.type);
  const step = stepFor(range.end - range.start, panel.layout.w);
  const aligned = alignRange(range.start, range.end, step);
  const builtins = { stepSeconds: step, rangeSeconds: range.end - range.start };
  const projects = owner.kind === "project" ? [owner.project] : owner.members;
  const requests: QueryRequest[] = [];
  const parts: RunPart[] = [];
  const skipped: SkippedPart[] = [];

  for (const q of panel.queries) {
    if (q.hidden || q.expr.trim() === "") continue;
    let text: string;
    try {
      text = interpolate(q.expr, vars, builtins);
    } catch (err) {
      if (!(err instanceof VariableError)) throw err;
      skipped.push({ queryRef: q.ref, projectName: null, message: err.message, state: "error" });
      continue;
    }
    for (const project of projects) {
      const ofType = project.links.filter((l) => l.source_type === q.source.type);
      // A group's members each use their own first source; a project uses the one named.
      const named = owner.kind === "project" && q.source.id !== null;
      const link = named ? project.links.find((l) => l.source_id === q.source.id) : ofType[0];
      if (!link) {
        const message = named ? unlinked(project.name)
          : owner.kind === "project" ? `${noSource(project.name, q.source.type)} Link one on the project page.`
          : noSource(project.name, q.source.type);
        skipped.push({ queryRef: q.ref, projectName: project.name, message, state: "error" });
        continue;
      }
      let req: QueryRequest;
      if (kind === "instant") {
        req = { source_id: link.source_id, project_id: project.id, kind, query: text, time: range.end };
      } else {
        req = { source_id: link.source_id, project_id: project.id, kind, query: text, start: aligned.start, end: aligned.end, step };
        if (panel.type === "logs") {
          req.limit = panel.options.limit;
          req.direction = panel.options.order === "oldest" ? "forward" : "backward";
        }
      }
      requests.push(req);
      parts.push({ queryRef: q.ref, projectId: project.id, projectName: project.name, sourceName: link.source_name });
    }
  }
  return { requests, parts, skipped, ownerKind: owner.kind, range: kind === "instant" ? { ...range } : aligned, step };
}

/** The same requests give the same key. */
export function panelRunKey(run: Pick<PanelRun, "requests">): string {
  return JSON.stringify(run.requests);
}

// --- Merging ----------------------------------------------------------------------------------

export type PanelState = "noQuery" | "ready" | "empty" | "partial" | "unreachable" | "error";

export interface ChartSeries {
  /** Stable across runs: the query, the project and the sorted labels (colours follow it). */
  key: string;
  name: string;
  labels: Record<string, string>;
  points: [number, number | null][];
  queryRef: string;
  /** On a group dashboard, the project the series came from. */
  projectName: string | null;
}

export interface ChartLogLine {
  key: string;
  /** Nanoseconds, as the tool sent them. */
  ts: string;
  line: string;
  labels: Record<string, string>;
  projectName: string | null;
}

export interface PanelData {
  state: PanelState;
  series: ChartSeries[];
  logs: ChartLogLine[];
  /** Plain words: what failed (and where) or what is missing. */
  problems: string[];
  summary: { series: number; points: number; tookMs: number };
}

/** Failures that mean "the tool couldn't answer", not "the query is wrong". */
const UNREACHABLE = new Set<QueryErrorCode | "network">(["unreachable", "timeout", "unauthorized", "too_large", "tool_error", "network"]);

function sortedLabels(labels: Record<string, string>): [string, string][] {
  return Object.keys(labels).sort().map((k) => [k, labels[k]]);
}

/** Nanosecond strings compared as numbers (lengths first, so no BigInt is needed). */
function compareTs(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** One key per item, even when two items would share one. */
function uniqueKeys(): (key: string) => string {
  const seen = new Map<string, number>();
  return (key) => {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? key : `${key}#${n}`;
  };
}

/**
 * The panel's state from its run and the answers (`results[i]` answers `run.requests[i]`).
 * Every part failed or was skipped: `unreachable` when each failure is the tool not answering,
 * else `error`. Some failed or skipped, or an answer was cut: `partial`, saying what's missing.
 * No series and no lines: `empty`. Otherwise `ready`.
 */
export function mergePanelResults(panel: PanelSpec, run: PanelRun, results: BatchItemOut[], ownerKind: OwnerKind): PanelData {
  const group = ownerKind === "group";
  const queries = new Map(panel.queries.map((q) => [q.ref, q]));
  const series: ChartSeries[] = [];
  const logs: ChartLogLine[] = [];
  const problems: string[] = [];
  const codes: (QueryErrorCode | "network" | "skipped")[] = [];
  const seriesKey = uniqueKeys();
  const lineKey = uniqueKeys();
  let failed = run.skipped.length;
  let truncated = false;
  let points = 0;
  let tookMs = 0;
  const problem = (text: string) => { if (!problems.includes(text)) problems.push(text); };

  run.parts.forEach((part, i) => {
    const result = results[i];
    if (!result?.ok || !result.response) {
      failed++;
      const code = result?.error?.code ?? "unreachable";
      codes.push(code);
      if (code === "not_linked" || code === "not_found") problem(unlinked(part.projectName));
      else problem(`${group ? `${part.projectName}: ` : ""}${result?.error?.message ?? "This query didn't answer."}`);
      return;
    }
    const res = result.response;
    const q = queries.get(part.queryRef);
    const projectName = group ? part.projectName : null;
    truncated ||= res.truncated;
    tookMs = Math.max(tookMs, res.took_ms);
    for (const s of res.series) {
      const name = legendName(q?.legend ?? "", s.labels, q?.expr ?? part.queryRef);
      points += s.points.length;
      series.push({
        key: seriesKey(JSON.stringify([part.queryRef, part.projectId, sortedLabels(s.labels)])),
        name: group ? `${part.projectName} · ${name}` : name,
        labels: s.labels,
        points: s.points,
        queryRef: part.queryRef,
        projectName,
      });
    }
    for (const stream of res.streams) {
      const streamId = JSON.stringify([part.queryRef, part.projectId, sortedLabels(stream.labels)]);
      for (const [ts, line] of stream.entries) {
        logs.push({ key: lineKey(`${streamId}@${ts}`), ts, line, labels: stream.labels, projectName });
      }
    }
    res.warnings.forEach(problem);
  });
  for (const s of run.skipped) {
    codes.push("skipped");
    problem(s.message);
  }

  const oldest = panel.type === "logs" && panel.options.order === "oldest";
  logs.sort((a, b) => (oldest ? compareTs(a.ts, b.ts) : compareTs(b.ts, a.ts)));

  const total = run.parts.length + run.skipped.length;
  let state: PanelState;
  if (total === 0) state = "noQuery";
  else if (failed === total) state = codes.every((c) => c !== "skipped" && UNREACHABLE.has(c)) ? "unreachable" : "error";
  // Some parts failed: partial even when the rest answered empty, so the failure is never read as "no data".
  else if (failed > 0) state = "partial";
  else if (series.length === 0 && logs.length === 0) state = "empty";
  else state = truncated ? "partial" : "ready";

  return { state, series, logs, problems, summary: { series: series.length, points, tookMs } };
}

/** The panel after its whole request failed: the reason, never the previous data. */
function failedPanel(run: PanelRun, err: unknown): PanelData {
  const code = err instanceof DashboardRequestError ? err.code : "network";
  const message = err instanceof Error && err.message ? err.message : "The panel's queries didn't answer. Try again.";
  const problems = [message];
  for (const s of run.skipped) if (!problems.includes(s.message)) problems.push(s.message);
  return {
    state: UNREACHABLE.has(code as QueryErrorCode) ? "unreachable" : "error",
    series: [],
    logs: [],
    problems,
    summary: { series: 0, points: 0, tookMs: 0 },
  };
}

// --- Running ----------------------------------------------------------------------------------

/** Every request, in batches of at most 64 sent together; the answers in the order sent. */
export async function runRequests(requests: QueryRequest[], signal?: AbortSignal): Promise<BatchItemOut[]> {
  const chunks: QueryRequest[][] = [];
  for (let i = 0; i < requests.length; i += BATCH_SIZE) chunks.push(requests.slice(i, i + BATCH_SIZE));
  const answers = await Promise.all(chunks.map((chunk) => runBatch(chunk, signal)));
  return answers.flat();
}

export interface PanelDataResult {
  data: PanelData | null;
  /** A request for this panel is on its way. */
  fetching: boolean;
  /** When the data shown was read; null while a failure is shown. */
  updatedAt: number | null;
  /** When the failure shown happened; null otherwise. */
  failedAt: number | null;
  refetch(): void;
}

type Shown = { data: PanelData; updatedAt: number | null; failedAt: number | null };

/**
 * The panel's data, run on the server. Keyed by what is sent, so a new window is a new key; the
 * page owns "now" and passes `refreshMs = null` (each refresh is a new window, never the old one
 * re-sent). While a new key loads, what was shown last stays shown with `fetching: true`. A
 * failure shows its reason with no series: never the previous data.
 */
export function usePanelData(
  dashboardId: string,
  panel: PanelSpec,
  run: PanelRun,
  refreshMs: number | null,
  enabled: boolean,
): PanelDataResult {
  const key = panelRunKey(run);
  const nothing = run.requests.length === 0;
  const query = useQuery<BatchItemOut[], unknown>({
    queryKey: ["monitoring", "panel", dashboardId, panel.id, key],
    queryFn: ({ signal }) => runRequests(run.requests, signal),
    enabled: enabled && !nothing,
    retry: false,
    // Only while the page is visible (TanStack skips interval runs in a hidden page).
    refetchInterval: refreshMs ?? false,
    refetchIntervalInBackground: false,
    // Old windows are never shown again; don't keep them long.
    gcTime: 60_000,
  });
  const last = useRef<Shown | null>(null);

  const answers = query.status === "success" ? query.data : undefined;
  const merged = useMemo(
    () => (answers ? mergePanelResults(panel, run, answers, run.ownerKind) : null),
    [answers, panel, run],
  );
  const failed = useMemo(
    () => (query.status === "error" ? failedPanel(run, query.error) : null),
    [query.status, query.error, run],
  );
  const idle = useMemo(() => (nothing ? mergePanelResults(panel, run, [], run.ownerKind) : null), [nothing, panel, run]);

  let shown: Shown | null;
  if (idle) shown = { data: idle, updatedAt: null, failedAt: null };
  else if (failed) shown = { data: failed, updatedAt: null, failedAt: query.errorUpdatedAt };
  else if (merged) shown = { data: merged, updatedAt: query.dataUpdatedAt, failedAt: null };
  else shown = last.current; // this key hasn't answered yet: keep what was shown
  if (shown !== last.current && (idle || failed || merged)) last.current = shown;

  return {
    data: shown?.data ?? null,
    fetching: !nothing && query.isFetching,
    updatedAt: shown?.updatedAt ?? null,
    failedAt: shown?.failedAt ?? null,
    refetch: () => { if (!nothing) void query.refetch(); },
  };
}
