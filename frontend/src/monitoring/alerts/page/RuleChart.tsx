// The rule's query over the last hour against its threshold (A2's chart). The query each target
// checks (`eval_expr`) runs through M2's batch with its project, so the project's filter applies;
// a group rule draws one series set per project. A failure says why in words and draws no chart:
// never an old answer as current. The chart comes from the lazy chart chunk.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useProjects } from "../../api/hooks";
import type { ProjectOut, QueryRequest } from "../../api/types";
import type { BatchItemOut } from "../../dashboards/api";
import { mergePanelResults, runRequests, type PanelData, type PanelRun } from "../../dashboards/runPanel";
import { newPanel, type PanelSpec } from "../../dashboards/schema";
import { alignRange } from "../../dashboards/time";
import type { RuleOut } from "../api";
import s from "./AlertsPage.module.css";

const ChartView = lazy(() => import("../../charts"));

const HOUR = 3600;
const STEP = 30;
/** The window moves on to "now" this often while the rule is shown. */
const MOVE_MS = 60_000;

export const CHART_CAPTION = "The rule's query over the last hour; the dashed line is the threshold.";
const NO_TARGET = "This rule doesn't run anywhere yet, so there is nothing to draw.";
const FAILED = "The rule's query didn't answer. Try again in a moment.";

const sourceWords = (type: RuleOut["source_type"]) => (type === "loki" ? "Loki" : "Prometheus-compatible");

/** The requests: one per target that runs (each with its project), or why one couldn't be sent. */
export function ruleChartRun(rule: RuleOut, projects: ProjectOut[], end: number): { run: PanelRun; panel: PanelSpec } {
  const aligned = alignRange(end - HOUR, end, STEP);
  const base = newPanel("timeseries", `rule:${rule.id}`, { x: 0, y: 0, w: 24, h: 6 }) as Extract<PanelSpec, { type: "timeseries" }>;
  const requests: QueryRequest[] = [];
  const parts: PanelRun["parts"] = [];
  const skipped: PanelRun["skipped"] = [];
  const queries: PanelSpec["queries"] = [];
  for (const t of rule.targets) {
    if (t.leaving || t.eval_expr.trim() === "") continue;
    queries.push({ ref: t.id, source: { type: rule.source_type, id: null }, expr: t.eval_expr, legend: "", hidden: false });
    const project = projects.find((p) => p.id === t.project_id);
    const ofType = project?.links.filter((l) => l.source_type === rule.source_type) ?? [];
    const link = rule.scope.kind === "project" && rule.source_id !== null ? ofType.find((l) => l.source_id === rule.source_id) : ofType[0];
    if (!project || !link) {
      skipped.push({ queryRef: t.id, projectName: t.project_name, message: `${t.project_name} has no ${sourceWords(rule.source_type)} source linked.`, state: "error" });
      continue;
    }
    requests.push({ source_id: link.source_id, project_id: project.id, kind: "range", query: t.eval_expr, start: aligned.start, end: aligned.end, step: STEP });
    parts.push({ queryRef: t.id, projectId: project.id, projectName: project.name, sourceName: link.source_name });
  }
  const panel = { ...base, title: rule.name, queries, options: { ...base.options, legend: rule.scope.kind === "group" ? "bottom" : "hidden", style: "lines" } } as PanelSpec;
  return { run: { requests, parts, skipped, ownerKind: rule.scope.kind, range: aligned, step: STEP }, panel };
}

export function RuleChart({ rule }: { rule: RuleOut }) {
  const projects = useProjects();
  // "Now" for the window: read again when another rule is shown, and every minute.
  const [end, setEnd] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    setEnd(Math.floor(Date.now() / 1000));
    const timer = setInterval(() => setEnd(Math.floor(Date.now() / 1000)), MOVE_MS);
    return () => clearInterval(timer);
  }, [rule.id]);

  const built = useMemo(() => (projects.data ? ruleChartRun(rule, projects.data, end) : null), [rule, projects.data, end]);
  const key = built ? JSON.stringify(built.run.requests) : "";
  const query = useQuery<BatchItemOut[], unknown>({
    queryKey: ["monitoring", "alerts", "chart", rule.id, key],
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

  // While a new window loads, the last one drawn for this rule stays; another rule's never does.
  const last = useRef<{ rule: string; data: PanelData; panel: PanelSpec; range: { start: number; end: number } } | null>(null);
  if (merged && built) last.current = { rule: rule.id, data: merged, panel: built.panel, range: built.run.range };
  const shown = last.current?.rule === rule.id ? last.current : null;

  const band = useMemo(() => ({ op: rule.condition.op, threshold: rule.condition.threshold, queryRef: rule.targets[0]?.id ?? "A" }), [rule]);

  let body;
  if (projects.isError && !projects.data) body = <p className={s.chartWords} data-tone="warn">{FAILED}</p>;
  else if (built && rule.targets.filter((t) => !t.leaving).length === 0) body = <p className={s.chartWords}>{NO_TARGET}</p>;
  else if (query.status === "error") {
    const message = query.error instanceof Error && query.error.message ? query.error.message : FAILED;
    body = <p className={s.chartWords} data-tone="warn" role="status">{message}</p>;
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
        {shown.data.state === "empty" && <p className={s.chartWords}>The query found no series in the last hour.</p>}
        {shown.data.state === "partial" && <p className={s.chartWords} data-tone="warn">{shown.data.problems.join(" ")}</p>}
      </>
    );
  }
  return (
    <figure className={s.chart}>
      {body}
      <figcaption className={s.caption}>{CHART_CAPTION}</figcaption>
    </figure>
  );
}
