// Explore's run: the query text runs 300 ms after the last change (at once on request), one batch
// item per run on the project, so its filter always applies. A newer run aborts the older one and
// an older answer is dropped. Honest states: a query the tool can't read is `invalid` and keeps the
// last good result (drawn dimmed and labelled); any other failure is `failed` and draws nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import { failure } from "../../api/http";
import type { LinkOut, ProjectOut, QueryErrorCode } from "../api/types";
import { quickCheck } from "../build/promql";
import { DashboardRequestError } from "../dashboards/api";
import { buildPanelRun, mergePanelResults, runRequests, type PanelData } from "../dashboards/runPanel";
import { GRID_COLUMNS, newPanel, type PanelSpec } from "../dashboards/schema";

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
  /** What the last run asked for: a chart or log lines. */
  kind: ExploreKind | null;
  /** When the last run ended (ms since the epoch). */
  at: number | null;
  /** The time range the last run read, in words ("Last 1 hour"). */
  timeText: string | null;
  /** The project and source the last run read. A change of either starts over from INITIAL. */
  projectId: string | null;
  sourceId: string | null;
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
}

const INITIAL: ExploreRunState = {
  status: "idle", data: null, lastGood: null, message: null, tookMs: null, runId: 0,
  shown: "idle", expr: null, failure: null, range: null, step: null, kind: null, at: null,
  timeText: null, projectId: null, sourceId: null,
};

/** The tool couldn't answer: the same family M2 calls unreachable. */
const UNREACHABLE = new Set<QueryErrorCode | "network">(["unreachable", "timeout", "unauthorized", "too_large", "tool_error", "network"]);
/** Codes that mean "the query text is wrong": the last good result stays. */
const INVALID = new Set<string>(["bad_query", "bad_request"]);
const NO_ANSWER = "This query didn't answer. Try again.";

/** The panel Explore runs and draws: full width, one query on the chosen source. */
export function explorePanel(id: string, expr: string, source: Pick<LinkOut, "source_id" | "source_type"> | null, kind: ExploreKind): PanelSpec {
  const panel = newPanel(kind === "logs" ? "logs" : "timeseries", id, { x: 0, y: 0, w: GRID_COLUMNS, h: 8 });
  panel.title = "Query result";
  panel.queries[0] = {
    ...panel.queries[0],
    expr,
    source: { type: source?.source_type ?? (kind === "logs" ? "loki" : "prometheus"), id: source?.source_id ?? null },
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
    const { project, source, expr, range, kind, panelId = "explore", timeText = null } = latest.current;
    controller.current?.abort();
    controller.current = null;
    const runId = ++runIds.current;
    const end = (patch: Partial<ExploreRunState>) =>
      setState((s) => ({
        ...s, runId, expr, kind, at: Date.now(), timeText,
        projectId: project?.id ?? null, sourceId: source?.source_id ?? null, ...patch,
      }));
    const invalid = (message: string) =>
      end({ status: "invalid", shown: "invalid", data: null, message, failure: null, tookMs: null });

    if (!project || !source || expr.trim() === "") {
      end({ status: "idle", shown: "idle", data: null, message: null, failure: null, tookMs: null, at: null });
      return;
    }
    const unreadable = quickCheck(expr);
    if (unreadable) { invalid(unreadable); return; }

    const panel = explorePanel(panelId, expr, source, kind);
    const run = buildPanelRun({ panel, owner: { kind: "project", project }, vars: {}, range, ownerName: project.name });
    // Without variables nothing is skipped; if something is, it is the text's fault.
    if (run.skipped.length > 0) { invalid(run.skipped[0].message); return; }
    if (run.requests.length === 0) {
      end({ status: "idle", shown: "idle", data: null, message: null, failure: null, tookMs: null, at: null });
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
        if (INVALID.has(code)) invalid(message);
        // A failure replaces the chart for good: a later typo never brings back what came before it.
        else end({ status: "failed", shown: "failed", data: null, lastGood: null, message, failure: UNREACHABLE.has(code) ? "unreachable" : "error", tookMs: null });
        return;
      }
      const data = mergePanelResults(panel, run, results, "project");
      end({
        status: "done", shown: "done", data, message: null, failure: null, tookMs: data.summary.tookMs,
        lastGood: { expr, data, range: run.range, step: run.step, kind }, range: run.range, step: run.step,
      });
    } catch (err) {
      if (isAbort(err) || ctl.signal.aborted || runId !== runIds.current) return;
      const code = err instanceof DashboardRequestError ? err.code : "network";
      end({
        status: "failed", shown: "failed", data: null, lastGood: null, message: failure(err, "try again") || NO_ANSWER,
        failure: UNREACHABLE.has(code as QueryErrorCode) ? "unreachable" : "error", tookMs: null,
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

  const key = JSON.stringify([
    input.project?.id ?? null, input.source?.source_id ?? null, input.source?.source_type ?? null,
    input.expr, input.range.start, input.range.end, input.kind, input.panelId ?? null,
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
  }, [key, nonce, fire]);

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
