// Explore's run: the query text runs 300 ms after the last change (at once on request), one batch
// item per run on the project, so its filter always applies. A newer run aborts the older one and
// an older answer is dropped. Honest states: a query the tool can't read (or a field with several
// queries) is `invalid` and keeps the last good result (drawn dimmed and labelled); any other
// failure is `failed` and draws nothing. A log query has no chart: the page turns this run off
// (`enabled: false`) and shows only its lines.
//
// `useLinesRun` is the log lines (X3): one batch item of at most 1000 lines, newest first, on the
// project, for the whole range or a chosen window. It has its own honest states: a text the tool
// refuses is `invalid` (fixing it is the way on, so no Try again), any other failure is `failed`;
// both clear the lines, and an answer for an older window or text is dropped.

import { useCallback, useEffect, useRef, useState } from "react";
import { failure } from "../../api/http";
import type { LinkOut, ProjectOut, QueryErrorCode, QueryRequest } from "../api/types";
import { ONE_QUERY, quickCheck, severalQueries } from "../build/promql";
import { DashboardRequestError } from "../dashboards/api";
import { interpolate, VariableError } from "../dashboards/interpolate";
import { buildPanelRun, mergePanelResults, runRequests, type ChartLogLine, type PanelData, type PanelRun } from "../dashboards/runPanel";
import { GRID_COLUMNS, newPanel, type PanelSpec } from "../dashboards/schema";
import { stepFor } from "../dashboards/time";
import { LINES_LIMIT } from "./logLinks";
import { isQueryable } from "../sources/sourceLabels";

export const EXPLORE_DEBOUNCE_MS = 300;

export type ExploreKind = "metrics" | "logs";
type Range = { start: number; end: number };
/** An outcome a run ended with; `idle` is "nothing to run". */
export type ExploreOutcome = "idle" | "done" | "invalid" | "failed";

export interface ExploreLastGood {
  expr: string;
  data: PanelData;
  /** The run's aligned range: the dimmed chart's x axis. */
  range: Range;
  step: number;
  /** Logs or a chart: how it is drawn. */
  kind: ExploreKind;
  /** The panel the run drew. */
  panel: PanelSpec;
}

export type ExploreRunState = {
  status: "idle" | "waiting" | "running" | "done" | "invalid" | "failed";
  data: PanelData | null;
  lastGood: ExploreLastGood | null;
  message: string | null;
  tookMs: number | null;
  runId: number;
  /** How the last run ended: what the page draws while the next one waits or runs. */
  shown: ExploreOutcome;
  /** The text the last run read. */
  expr: string | null;
  /** For `failed`: the tool didn't answer (`unreachable`) or refused the request (`error`). */
  failure: "unreachable" | "error" | null;
  /** The last answered run's aligned range and step (the chart's axis; the recommendations' step). */
  range: Range | null;
  step: number | null;
  /** What the last run asked for (always a chart: a log query's run is off). */
  kind: ExploreKind | null;
  /** The panel the last run drew. */
  panel: PanelSpec | null;
  /** When the last run ended (ms since the epoch). */
  at: number | null;
  /** The time range the last run read, in words ("Last 1 hour"). */
  timeText: string | null;
  /** The project and source the last run read. A change of either starts over from INITIAL. */
  projectId: string | null;
  sourceId: string | null;
  /** The request whose answer is shown (set when a run ends `done`): what an empty answer is asked about. */
  request: QueryRequest | null;
};

export interface ExploreRunInput {
  project: ProjectOut | null;
  source: LinkOut | null;
  expr: string;
  range: Range;
  kind: ExploreKind;
  /** The synthetic panel's id (stable per tab). */
  panelId?: string;
  /** The range in words, kept with the run that read it. */
  timeText?: string;
  /** False for a log query (its lines are the result): nothing runs and the state stays idle. */
  enabled?: boolean;
}

const INITIAL: ExploreRunState = {
  status: "idle", data: null, lastGood: null, message: null, tookMs: null, runId: 0,
  shown: "idle", expr: null, failure: null, range: null, step: null, kind: null, panel: null, at: null,
  timeText: null, projectId: null, sourceId: null, request: null,
};

/** The tool couldn't answer: the same family M2 calls unreachable. */
const UNREACHABLE = new Set<QueryErrorCode | "network">(["unreachable", "timeout", "unauthorized", "too_large", "tool_error", "network"]);
/** Codes that mean "the query text is wrong": fixing it is the way on, and the last good result stays. */
const INVALID = new Set<string>(["bad_query", "bad_request"]);
/** What a text says before anything is sent: unreadable, or several queries; `null` when it can run. */
const refuseText = (expr: string): string | null => quickCheck(expr) ?? (severalQueries(expr) ? ONE_QUERY : null);
const NO_ANSWER = "This query didn't answer. Try again.";
/** After a text that can't run: the way on is fixing it, never trying it again. */
export const FIX_QUERY = "Fix the query to run it again.";
/** A refusal that came without words of its own. The lines' note adds `FIX_QUERY` itself. */
const REFUSED = "The source couldn't read this query.";
const REFUSED_RUN = `${REFUSED} ${FIX_QUERY}`;

/** The panel Explore runs and draws: full width, one query on the chosen source. */
export function explorePanel(id: string, expr: string, source: Pick<LinkOut, "source_id" | "source_type"> | null, kind: ExploreKind): PanelSpec {
  const panel = newPanel(kind === "logs" ? "logs" : "timeseries", id, { x: 0, y: 0, w: GRID_COLUMNS, h: 8 });
  panel.title = "Query result";
  panel.queries[0] = {
    ...panel.queries[0],
    expr,
    source: { type: source && isQueryable(source.source_type) ? source.source_type : (kind === "logs" ? "loki" : "prometheus"), id: source?.source_id ?? null },
  };
  return panel;
}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

export function useExploreRun(input: ExploreRunInput): { run(now?: boolean): void; state: ExploreRunState } {
  const [state, setState] = useState<ExploreRunState>(INITIAL);
  const latest = useRef(input);
  latest.current = input;
  const runIds = useRef(0);
  const controller = useRef<AbortController | null>(null);
  // `run()` bumps the nonce; `run(true)` also marks that nonce to run at once.
  const nonces = useRef(0);
  const [nonce, setNonce] = useState(0);
  const immediate = useRef(-1);

  const fire = useCallback(async () => {
    const { project, source, expr, range, kind, panelId = "explore", timeText = null, enabled = true } = latest.current;
    if (!enabled) return;
    controller.current?.abort();
    controller.current = null;
    const runId = ++runIds.current;
    const end = (patch: Partial<ExploreRunState>) =>
      setState((s) => ({
        ...s, runId, expr, kind, at: Date.now(), timeText,
        projectId: project?.id ?? null, sourceId: source?.source_id ?? null, ...patch,
      }));
    const invalid = (message: string) =>
      end({ status: "invalid", shown: "invalid", data: null, message, failure: null, tookMs: null, request: null });

    if (!project || !source || expr.trim() === "") {
      end({ status: "idle", shown: "idle", data: null, message: null, failure: null, tookMs: null, at: null, request: null });
      return;
    }
    const refused = refuseText(expr);
    if (refused) { invalid(refused); return; }

    const panel = explorePanel(panelId, expr, source, kind);
    const run = buildPanelRun({ panel, owner: { kind: "project", project }, vars: {}, range, ownerName: project.name });
    // Without variables nothing is skipped; if something is, it is the text's fault.
    if (run.skipped.length > 0) { invalid(run.skipped[0].message); return; }
    if (run.requests.length === 0) {
      end({ status: "idle", shown: "idle", data: null, message: null, failure: null, tookMs: null, at: null, request: null });
      return;
    }

    const ctl = new AbortController();
    controller.current = ctl;
    setState((s) => ({ ...s, status: "running", runId }));
    try {
      const results = await runRequests(run.requests, ctl.signal);
      if (runId !== runIds.current) return;
      const first = results[0];
      // The item's own code says which: a text the tool refused, or a tool that didn't answer.
      if (!first?.ok || !first.response) {
        const code = first?.error?.code ?? "unreachable";
        const message = first?.error?.message || NO_ANSWER;
        if (INVALID.has(code)) invalid(first?.error?.message || REFUSED_RUN);
        // A failure replaces the chart for good: a later typo never brings back what came before it.
        else end({ status: "failed", shown: "failed", data: null, lastGood: null, message, failure: UNREACHABLE.has(code) ? "unreachable" : "error", tookMs: null, request: null });
        return;
      }
      const data = mergePanelResults(panel, run, results, "project");
      end({
        status: "done", shown: "done", data, message: null, failure: null, tookMs: data.summary.tookMs, panel, request: run.requests[0],
        lastGood: { expr, data, range: run.range, step: run.step, kind, panel }, range: run.range, step: run.step,
      });
    } catch (err) {
      if (isAbort(err) || ctl.signal.aborted || runId !== runIds.current) return;
      const code = err instanceof DashboardRequestError ? err.code : "network";
      if (INVALID.has(code)) { invalid((err as Error).message || REFUSED_RUN); return; }
      end({
        status: "failed", shown: "failed", data: null, lastGood: null, message: failure(err, "try again") || NO_ANSWER,
        failure: UNREACHABLE.has(code as QueryErrorCode) ? "unreachable" : "error", tookMs: null, request: null,
      });
    } finally {
      if (controller.current === ctl) controller.current = null;
    }
  }, []);

  // Another project or source: nothing read before is about it, the last good result included.
  // Reset while rendering, so no frame ever draws the old results under the new names.
  const scope = JSON.stringify([input.project?.id ?? null, input.source?.source_id ?? null]);
  const [scopeSeen, setScopeSeen] = useState(scope);
  if (scopeSeen !== scope) {
    setScopeSeen(scope);
    controller.current?.abort();
    controller.current = null;
    runIds.current++;
    setState((s) => ({ ...INITIAL, runId: s.runId }));
  }

  const enabled = input.enabled ?? true;
  const key = JSON.stringify([
    input.project?.id ?? null, input.source?.source_id ?? null, input.source?.source_type ?? null,
    input.expr, input.range.start, input.range.end, input.kind, input.panelId ?? null,
    enabled,
  ]);
  // The input and request an immediate run already went out for (StrictMode runs effects twice).
  const firedFor = useRef<string | null>(null);
  useEffect(() => {
    const at = `${nonce}|${key}`;
    if (firedFor.current === at) return;
    firedFor.current = null;
    // Whatever was on its way is about older input: drop it.
    controller.current?.abort();
    controller.current = null;
    if (!enabled) {
      // Turned off (a log query): nothing runs, and nothing an earlier run read is kept.
      runIds.current++;
      immediate.current = -1;
      setState((s) => (s.status === "idle" && s.shown === "idle" && s.lastGood === null && s.data === null
        ? s
        : { ...INITIAL, runId: s.runId }));
      return;
    }
    const nothing = !latest.current.project || !latest.current.source || latest.current.expr.trim() === "";
    if (immediate.current === nonce || nothing) {
      immediate.current = -1;
      firedFor.current = at;
      void fire();
      return;
    }
    runIds.current++;
    setState((s) => (s.status === "waiting" ? s : { ...s, status: "waiting" }));
    const timer = setTimeout(() => void fire(), EXPLORE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, nonce, fire, enabled]);

  useEffect(() => () => {
    controller.current?.abort();
    runIds.current++;
  }, []);

  const run = useCallback((now = false) => {
    const next = ++nonces.current;
    if (now) immediate.current = next;
    setNonce(next);
  }, []);

  return { run, state };
}

// --- the log lines under the chart (X3) ---------------------------------------------------------

export type LinesRunState = {
  status: "idle" | "waiting" | "running" | "done" | "failed" | "invalid";
  /** How the last run ended: what is said while the next one waits or runs. */
  shown: ExploreOutcome;
  /** When the last run ended (ms since the epoch). */
  at: number | null;
  /** The lines of the last answered run, newest first; never another text's, window's or place's. */
  lines: ChartLogLine[];
  /** For `failed` and `invalid`: why, in words. */
  message: string | null;
  /** The window the shown lines are for; `null` is the whole range. */
  window: Range | null;
  /** The range in words the shown lines read. */
  timeText: string | null;
  /** The whole range's lines (the chart's ticks) and the run they answer (`linesKey`). */
  marks: ChartLogLine[];
  marksFor: string | null;
  /** The text, place and range (`linesKey`) the shown state is about; `null` before any. */
  key: string | null;
  runId: number;
  /** The request whose lines are shown (set on `done`; its window included): what empty lines are asked about. */
  request: QueryRequest | null;
};

export interface LinesRunInput {
  project: ProjectOut | null;
  /** The Loki source the lines come from. */
  source: LinkOut | null;
  /** A LogQL log query (never a metric query); empty is "nothing to list". */
  query: string;
  range: Range;
  /** A chosen window inside `range`: the lines are read for exactly it. */
  window: Range | null;
  timeText?: string;
}

const LINES_INITIAL: LinesRunState = {
  status: "idle", shown: "idle", at: null, lines: [], message: null, window: null, timeText: null, marks: [], marksFor: null, key: null, runId: 0,
  request: null,
};
const NO_LINES = "The log lines didn't answer. Try again.";

/** What the ticks belong to: one text on one source of one project over one whole range. */
export function linesKey(input: Pick<LinesRunInput, "project" | "source" | "query" | "range">): string {
  return JSON.stringify([input.project?.id ?? null, input.source?.source_id ?? null, input.query, input.range.start, input.range.end]);
}

export function useLinesRun(input: LinesRunInput): { state: LinesRunState; retry(): void } {
  const [state, setState] = useState<LinesRunState>(LINES_INITIAL);
  const latest = useRef(input);
  latest.current = input;
  const runIds = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const fire = useCallback(async () => {
    const { project, source, query, range, window, timeText = null } = latest.current;
    controller.current?.abort();
    controller.current = null;
    const runId = ++runIds.current;
    const forKey = linesKey(latest.current);
    if (!project || !source || query.trim() === "") {
      setState((s) => ({ ...LINES_INITIAL, runId, key: forKey, marks: s.marksFor === forKey ? s.marks : [], marksFor: s.marksFor === forKey ? s.marksFor : null }));
      return;
    }
    // A text that can't run says so and clears the lines.
    const invalid = (message: string) =>
      setState({ ...LINES_INITIAL, status: "invalid", shown: "invalid", at: Date.now(), message, window, timeText, key: forKey, runId });
    const refused = refuseText(query);
    if (refused) { invalid(refused); return; }
    const span = window ?? range;
    const seconds = span.end - span.start;
    const step = stepFor(seconds, GRID_COLUMNS);
    let text: string;
    try {
      // No variables in Explore: only the builtins, so a batch never carries `$__interval` (F20).
      text = interpolate(query, {}, { stepSeconds: step, rangeSeconds: seconds });
    } catch (err) {
      if (!(err instanceof VariableError)) throw err;
      invalid(err.message);
      return;
    }
    const request: QueryRequest = {
      source_id: source.source_id, project_id: project.id, kind: "range", query: text,
      start: span.start, end: span.end, step, limit: LINES_LIMIT, direction: "backward",
    };
    const panel = newPanel("logs", "explore:lines", { x: 0, y: 0, w: GRID_COLUMNS, h: 8 });
    panel.title = "Log lines";
    if (panel.type === "logs") panel.options = { ...panel.options, limit: LINES_LIMIT, order: "newest" };
    const run: PanelRun = {
      requests: [request], skipped: [], ownerKind: "project", range: { ...span }, step,
      parts: [{ queryRef: "A", projectId: project.id, projectName: project.name, sourceName: source.source_name }],
    };

    const ctl = new AbortController();
    controller.current = ctl;
    setState((s) => ({ ...s, status: "running", runId }));
    const failed = (message: string) => setState((s) => ({
      ...LINES_INITIAL, status: "failed", shown: "failed", at: Date.now(), message, window, timeText, key: forKey, runId,
      // A failed window keeps the whole range's ticks; a failed whole range has none.
      marks: window && s.marksFor === forKey ? s.marks : [], marksFor: window && s.marksFor === forKey ? forKey : null,
    }));
    try {
      const results = await runRequests([request], ctl.signal);
      if (runId !== runIds.current) return;
      const first = results[0];
      if (!first?.ok || !first.response) {
        // A text the tool refused is the text's to fix; anything else can be tried again.
        if (INVALID.has(first?.error?.code ?? "")) invalid(first?.error?.message || REFUSED);
        else failed(first?.error?.message || NO_LINES);
        return;
      }
      const lines = mergePanelResults(panel, run, results, "project").logs;
      setState((s) => ({
        status: "done", shown: "done", at: Date.now(), lines, message: null, window, timeText, key: forKey, runId, request,
        marks: window ? (s.marksFor === forKey ? s.marks : []) : lines,
        marksFor: window ? (s.marksFor === forKey ? forKey : null) : forKey,
      }));
    } catch (err) {
      if (isAbort(err) || ctl.signal.aborted || runId !== runIds.current) return;
      if (err instanceof DashboardRequestError && INVALID.has(err.code)) invalid(err.message || REFUSED);
      else failed(failure(err, "try again") || NO_LINES);
    } finally {
      if (controller.current === ctl) controller.current = null;
    }
  }, []);

  // Another project or source: nothing read before is about it. Reset while rendering, so no frame
  // ever shows the old lines or ticks under the new names.
  const scope = JSON.stringify([input.project?.id ?? null, input.source?.source_id ?? null]);
  const [scopeSeen, setScopeSeen] = useState(scope);
  if (scopeSeen !== scope) {
    setScopeSeen(scope);
    controller.current?.abort();
    controller.current = null;
    runIds.current++;
    setState((s) => ({ ...LINES_INITIAL, runId: s.runId }));
  }

  const base = linesKey(input);
  const key = JSON.stringify([base, input.window?.start ?? null, input.window?.end ?? null]);
  const [nonce, setNonce] = useState(0);
  // The text and range the last run went out for: a new window on them runs at once.
  const firedBase = useRef<string | null>(null);
  const firedFor = useRef<string | null>(null);
  useEffect(() => {
    const at = `${nonce}|${key}`;
    if (firedFor.current === at) return;
    firedFor.current = null;
    controller.current?.abort();
    controller.current = null;
    const nothing = !latest.current.project || !latest.current.source || latest.current.query.trim() === "";
    if (nothing || firedBase.current === base) {
      firedBase.current = base;
      firedFor.current = at;
      void fire();
      return;
    }
    // A new text waits for the typing to rest; nothing old is shown meanwhile.
    runIds.current++;
    setState((s) => (s.status === "waiting" ? s : { ...s, status: "waiting" }));
    const timer = setTimeout(() => {
      firedBase.current = base;
      firedFor.current = at;
      void fire();
    }, EXPLORE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, base, nonce, fire]);

  useEffect(() => () => {
    controller.current?.abort();
    runIds.current++;
  }, []);

  const retry = useCallback(() => {
    firedBase.current = linesKey(latest.current);
    setNonce((n) => n + 1);
  }, []);
  return { state, retry };
}
