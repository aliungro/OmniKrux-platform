// A rule's query against its threshold: the rule's details (A2's chart, the last hour) and the rule
// form (the query as written, the last 6 hours) draw the same chart. Each project's query runs
// through M2's batch with its project, so the project's filter applies; a group rule draws one
// series set per project. A failure says why in words and draws no chart: never an old answer as
// current. The chart comes from the lazy chart chunk.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { useProjects } from "../../api/hooks";
import type { ProjectOut, QueryRequest } from "../../api/types";
import type { BatchItemOut } from "../../dashboards/api";
import { mergePanelResults, runRequests, type PanelData, type PanelRun } from "../../dashboards/runPanel";
import { newPanel, type PanelSpec } from "../../dashboards/schema";
import { alignRange } from "../../dashboards/time";
import type { Op, RuleOut, ScopeKind, SourceType } from "../api";
import s from "./AlertsPage.module.css";

const ChartView = lazy(() => import("../../charts"));

const HOUR = 3600;
const STEP = 30;
/** The window moves on to "now" this often while the chart is shown. */
const MOVE_MS = 60_000;

export const CHART_CAPTION = "The rule's query over the last hour; the dashed line is the threshold.";
const NO_TARGET = "This rule doesn't run anywhere yet, so there is nothing to draw.";
const FAILED = "The rule's query didn't answer. Try again in a moment.";

const sourceWords = (type: SourceType) => (type === "loki" ? "Loki" : "Prometheus-compatible");

/** One project's query of the chart. */
export interface ChartItem {
  ref: string;
  projectId: string;
  projectName: string;
  expr: string;
}

/** What a threshold chart draws: whose queries, from which source, over how long. */
export interface ChartInput {
  /** Names the chart's data in the cache (`rule:<id>`, `form`). */
  id: string;
  title: string;
  scopeKind: ScopeKind;
  sourceType: SourceType;
  /** A project rule's named source; null: each project's first of the type. */
  sourceId: string | null;
  items: ChartItem[];
  /** The window, in seconds, and the step. */
  seconds: number;
  step: number;
}

/** The requests: one per item (each with its project), or why one couldn't be sent. */
export function chartRun(input: ChartInput, projects: ProjectOut[], end: number): { run: PanelRun; panel: PanelSpec } {
  const aligned = alignRange(end - input.seconds, end, input.step);
  const base = newPanel("timeseries", input.id, { x: 0, y: 0, w: 24, h: 6 }) as Extract<PanelSpec, { type: "timeseries" }>;
  const requests: QueryRequest[] = [];
  const parts: PanelRun["parts"] = [];
  const skipped: PanelRun["skipped"] = [];
  const queries: PanelSpec["queries"] = [];
  for (const item of input.items) {
    if (item.expr.trim() === "") continue;
    queries.push({ ref: item.ref, source: { type: input.sourceType, id: null }, expr: item.expr, legend: "", hidden: false });
    const project = projects.find((p) => p.id === item.projectId);
    const ofType = project?.links.filter((l) => l.source_type === input.sourceType) ?? [];
    const link = input.scopeKind === "project" && input.sourceId !== null ? ofType.find((l) => l.source_id === input.sourceId) : ofType[0];
    if (!project || !link) {
      skipped.push({ queryRef: item.ref, projectName: item.projectName, message: `${item.projectName} has no ${sourceWords(input.sourceType)} source linked.`, state: "error" });
      continue;
    }
    requests.push({ source_id: link.source_id, project_id: project.id, kind: "range", query: item.expr, start: aligned.start, end: aligned.end, step: input.step });
    parts.push({ queryRef: item.ref, projectId: project.id, projectName: project.name, sourceName: link.source_name });
  }
  const panel = { ...base, title: input.title, queries, options: { ...base.options, legend: input.scopeKind === "group" ? "bottom" : "hidden", style: "lines" } } as PanelSpec;
  return { run: { requests, parts, skipped, ownerKind: input.scopeKind, range: aligned, step: input.step }, panel };
}

/** The rule's requests over the last hour: one per target that runs. */
export function ruleChartRun(rule: RuleOut, projects: ProjectOut[], end: number): { run: PanelRun; panel: PanelSpec } {
  return chartRun(ruleChartInput(rule), projects, end);
}

function ruleChartInput(rule: RuleOut): ChartInput {
  return {
    id: `rule:${rule.id}`, title: rule.name, scopeKind: rule.scope.kind, sourceType: rule.source_type, sourceId: rule.source_id,
    items: rule.targets.filter((t) => !t.leaving).map((t) => ({ ref: t.id, projectId: t.project_id, projectName: t.project_name, expr: t.eval_expr })),
    seconds: HOUR, step: STEP,
  };
}

export interface ThresholdChartProps {
  input: ChartInput;
  op: Op;
  threshold: number;
  caption: string;
  /** Said instead of a chart when there is nothing to draw. */
  emptyWords: string;
  /** What the window found nothing in, for "The query found no series in {window}." */
  windowWords: string;
  /** The queries are about to change (typing): no chart of the old ones is shown meanwhile. */
  waiting?: boolean;
}

export function ThresholdChart({ input, op, threshold, caption, emptyWords, windowWords, waiting = false }: ThresholdChartProps) {
  const projects = useProjects();
  // "Now" for the window: read again when another chart is shown, and every minute.
  const [end, setEnd] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    setEnd(Math.floor(Date.now() / 1000));
    const timer = setInterval(() => setEnd(Math.floor(Date.now() / 1000)), MOVE_MS);
    return () => clearInterval(timer);
  }, [input.id]);

  const built = useMemo(() => (projects.data ? chartRun(input, projects.data, end) : null), [input, projects.data, end]);
  const key = built ? JSON.stringify(built.run.requests) : "";
  const query = useQuery<BatchItemOut[], unknown>({
    queryKey: ["monitoring", "alerts", "chart", input.id, key],
    queryFn: ({ signal }) => runRequests(built!.run.requests, signal),
    enabled: built !== null && built.run.requests.length > 0,
    retry: false,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const merged = useMemo<PanelData | null>(() => {
    if (!built) return null;
    if (built.run.requests.length === 0) return mergePanelResults(built.panel, built.run, [], built.run.ownerKind);
    return query.status === "success" ? mergePanelResults(built.panel, built.run, query.data, built.run.ownerKind) : null;
  }, [built, query.status, query.data]);

  // While a new window of the same queries loads, the last one drawn stays; other queries' never do.
  const queriesKey = `${input.id}|${input.sourceType}|${input.sourceId}|${JSON.stringify(input.items)}`;
  const last = useRef<{ key: string; data: PanelData; panel: PanelSpec; range: { start: number; end: number } } | null>(null);
  if (merged && built) last.current = { key: queriesKey, data: merged, panel: built.panel, range: built.run.range };
  const shown = last.current?.key === queriesKey ? last.current : null;

  const band = useMemo(() => ({ op, threshold, queryRef: input.items[0]?.ref ?? "A" }), [op, threshold, input.items]);

  let body;
  if (projects.isError && !projects.data) body = <p className={s.chartWords} data-tone="warn">{FAILED}</p>;
  else if (built && input.items.filter((i) => i.expr.trim() !== "").length === 0) body = <p className={s.chartWords}>{emptyWords}</p>;
  else if (waiting) body = <p className={s.chartWords} role="status">Loading…</p>;
  else if (query.status === "error") {
    body = <p className={s.chartWords} data-tone="warn" role="status">{failure(query.error, "try again")}</p>;
  } else if (!shown) body = <p className={s.chartWords} role="status">Loading…</p>;
  else if (shown.data.state === "unreachable" || shown.data.state === "error" || shown.data.state === "noQuery") {
    body = <p className={s.chartWords} data-tone="warn" role="status">{shown.data.problems.join(" ") || FAILED}</p>;
  } else {
    body = (
      <>
        <div className={s.chartBox}>
          <Suspense fallback={<p className={s.chartWords} role="status">Loading…</p>}>
            <ChartView panel={shown.panel} data={shown.data} range={shown.range} animate={false} changeId={0} alert={band} />
          </Suspense>
        </div>
        {shown.data.state === "empty" && <p className={s.chartWords}>The query found no series in {windowWords}.</p>}
        {shown.data.state === "partial" && <p className={s.chartWords} data-tone="warn">{shown.data.problems.join(" ")}</p>}
      </>
    );
  }
  return (
    <figure className={s.chart}>
      {body}
      <figcaption className={s.caption}>{caption}</figcaption>
    </figure>
  );
}

export function RuleChart({ rule }: { rule: RuleOut }) {
  const input = useMemo(() => ruleChartInput(rule), [rule]);
  return (
    <ThresholdChart input={input} op={rule.condition.op} threshold={rule.condition.threshold} caption={CHART_CAPTION}
      emptyWords={NO_TARGET} windowWords="the last hour" />
  );
}
