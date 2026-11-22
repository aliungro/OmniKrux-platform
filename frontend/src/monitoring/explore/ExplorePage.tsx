// Explore (X1): one-off questions without building a dashboard. Pick a project and one of its
// sources, type a query, and the result redraws as you type; each query that held is kept in a
// trail to jump back to. The page's state (project, source, query, time) lives in the tab's view,
// written with `replace` after a pause, so a reload or another tab brings it back.

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { pressed } from "../../features/chrome/shortcuts";
import { getProject } from "../api/client";
import { projectKey, useMonitoringTree } from "../api/hooks";
import { RecommendationBar } from "../build/RecommendationBar";
import { isLogQlMetric } from "../build/promql";
import { useOwnerCatalog } from "../catalog/merge";
import { PANEL_COPY } from "../dashboards/grid/PanelState";
import { usePrefersReducedMotion } from "../dashboards/motion";
import { pageLetter } from "../dashboards/page/keys";
import { TimeRangePicker } from "../dashboards/page/TimeRangePicker";
import type { DashboardOwner } from "../dashboards/runPanel";
import type { PanelSpec, TimeSpec } from "../dashboards/schema";
import { resolveTime, timeLabel } from "../dashboards/time";
import { readRecent } from "../home/recent";
import type { MonitoringPageProps } from "../MonitoringApp";
import { keyboardIsFree } from "../pages/Gone";
import { equalMonitoringView, type ExploreView, type MonitoringView } from "../shell/tabState";
import { DEFAULT_EXPLORE_TIME, defaultExploreProject, defaultExploreSource, exploreTime } from "./exploreDefaults";
import { FAILED_TITLE, MetaLine, QueryBar } from "./QueryBar";
// With its extension: on a case-insensitive disk, "./Trail" would also match trail.ts.
import { Trail, trailKey } from "./Trail.tsx";
import { clearTrail, pushTrail, readTrail, TRAIL_SHOWN, type TrailEntry } from "./trail";
import { EXPLORE_DEBOUNCE_MS, explorePanel, useExploreRun } from "./useExploreRun";
import s from "./ExplorePage.module.css";

const ChartView = lazy(() => import("../charts"));

/** A run that answered and whose text stayed this long goes into the trail. */
const TRAIL_SETTLE_MS = 2000;
const SOURCE_WORDS = { prometheus: "Prometheus-compatible", loki: "Loki" } as const;
const ADD_LATER = "Adding a query to a dashboard arrives in a later update.";

/**
 * The page. A view that changes under it (Back, Forward, the sidebar opening Explore on another
 * project) starts it again from that view; its own writes don't.
 */
export default function ExplorePage(props: MonitoringPageProps) {
  const { view, nav } = props;
  const written = useRef<MonitoringView | null>(null);
  const generation = useRef(0);
  if (written.current !== null && !equalMonitoringView(written.current, view)) generation.current++;
  written.current = view;
  const navRef = useRef(nav);
  navRef.current = nav;
  const write = useCallback((next: ExploreView) => {
    written.current = next;
    navRef.current.navigate(next, "replace");
  }, []);
  const explore: ExploreView = view.page === "explore" ? view : { page: "explore" };
  return <Explore key={generation.current} {...props} explore={explore} write={write} />;
}

interface ExploreProps extends MonitoringPageProps {
  explore: ExploreView;
  write(next: ExploreView): void;
}

function Explore({ explore, write, nav, tabId }: ExploreProps) {
  const tree = useMonitoringTree();
  const recent = useMemo(() => readRecent(), []);
  const reduced = usePrefersReducedMotion();
  const [projectId, setProjectId] = useState(explore.project);
  const [sourceId, setSourceId] = useState(explore.source);
  const [expr, setExpr] = useState(explore.expr ?? "");
  const [time, setTime] = useState<TimeSpec>(() => exploreTime(explore.time));
  // Bumped by an explicit run (Ctrl+Enter, Try again, the trail): "now" is read again.
  const [tick, setTick] = useState(0);
  const [timeOpen, setTimeOpen] = useState(false);

  const heading = useRef<HTMLHeadingElement>(null);
  const queryField = useRef<HTMLTextAreaElement>(null);
  const timeButton = useRef<HTMLButtonElement>(null);
  const chartBox = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLElement>(null);

  // --- project and source ---------------------------------------------------------------------
  const project = tree.data ? defaultExploreProject({ project: projectId }, tree.data, recent) : null;
  const projectQuery = useQuery({ queryKey: projectKey(project ?? ""), queryFn: () => getProject(project as string), enabled: project !== null });
  const projectOut = project !== null && projectQuery.data?.id === project ? projectQuery.data : null;
  const source = projectOut ? defaultExploreSource(projectOut, sourceId) : null;
  const language = source?.source_type === "loki" ? "LogQL" : "PromQL";
  const kind = source?.source_type === "loki" && !isLogQlMetric(expr) ? "logs" : "metrics";
  const projects = useMemo(() => [...(tree.data?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [tree.data]);
  const projectName = projects.find((p) => p.id === project)?.name ?? projectOut?.name ?? "";

  // --- the run ---------------------------------------------------------------------------------
  const range = useMemo(
    () => resolveTime(time, Math.floor(Date.now() / 1000)) ?? (resolveTime(DEFAULT_EXPLORE_TIME, Math.floor(Date.now() / 1000)) as { start: number; end: number }),
    // A new text, place or explicit run reads "now" again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [time.from, time.to, expr, project, source?.source_id, tick],
  );
  const panelId = `explore:${tabId}`;
  const { run, state } = useExploreRun({ project: projectOut, source, expr, range, kind, panelId });
  const runNow = useCallback(() => { setTick((n) => n + 1); run(true); }, [run]);

  // --- the view: written a pause after a change; a replace keeps the keyboard where it is ---------
  const ready = tree.data !== undefined && (project === null || projectOut !== null);
  const logs = explore.logs;
  useEffect(() => {
    if (!ready) return;
    const next: ExploreView = { page: "explore", time };
    if (project) next.project = project;
    if (source) next.source = source.source_id;
    if (expr) next.expr = expr;
    if (logs) next.logs = logs;
    const timer = setTimeout(() => write(next), EXPLORE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [ready, project, source, expr, time, logs, write]);

  // --- the trail -------------------------------------------------------------------------------
  const [trailVersion, setTrailVersion] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const trail = useMemo(() => (project ? readTrail(project) : []), [project, trailVersion]);
  const record = useCallback((entry: Omit<TrailEntry, "at">) => {
    if (!project || entry.expr.trim() === "") return;
    pushTrail(project, { ...entry, at: Date.now() });
    setTrailVersion((n) => n + 1);
  }, [project]);
  // A run that answered, with its text left alone for two seconds, is worth keeping.
  useEffect(() => {
    if (state.status !== "done" || state.expr !== expr || !source) return;
    const timer = setTimeout(() => record({ expr, sourceId: source.source_id }), TRAIL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [state.status, state.runId, state.expr, expr, source, record]);

  const pickTrail = (entry: TrailEntry) => {
    record(entry);
    setExpr(entry.expr);
    setSourceId(entry.sourceId);
    runNow();
  };
  const clearAll = () => {
    if (!project) return;
    clearTrail(project);
    setTrailVersion((n) => n + 1);
    queryField.current?.focus();
  };

  // --- keys outside fields: q the query, t the time menu -----------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pageLetter(e)) return;
      if (pressed("exploreQuery", e) && queryField.current) {
        e.preventDefault();
        queryField.current.focus();
      } else if (pressed("exploreTime", e) && timeButton.current) {
        e.preventDefault();
        if (!e.repeat) setTimeOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // The heading takes the keyboard when the page opens (unless the user is busy elsewhere).
  useEffect(() => { if (keyboardIsFree()) heading.current?.focus({ preventScroll: true }); }, []);

  // A part of the page that goes away with the keyboard on it (the failure's Try again, a trail
  // chip) hands it to the chart, the query or the heading: never to <body>.
  const lastFocused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const last = lastFocused.current;
    if (!last || last.isConnected || document.activeElement !== document.body) return;
    lastFocused.current = null;
    (chartTarget() ?? queryField.current ?? heading.current)?.focus({ preventScroll: true });
  });
  const chartTarget = () => {
    const box = chartBox.current;
    return box ? (box.querySelector<HTMLElement>('[tabindex="0"]') ?? box) : null;
  };
  const leaveQuery = () => (chartTarget() ?? heading.current)?.focus();

  // --- recommendations: per second and a wider window rewrite the text -------------------------
  const owner = useMemo<DashboardOwner | null>(() => (projectOut ? { kind: "project", project: projectOut } : null), [projectOut]);
  const { catalog } = useOwnerCatalog(owner);
  const recPanel = useMemo<PanelSpec>(() => {
    const p = explorePanel(panelId, expr, source, kind);
    // Explore draws lines it can't restyle: the stacking suggestion never applies here.
    return p.type === "timeseries" ? { ...p, options: { ...p.options, style: "area" } } : p;
  }, [panelId, expr, source, kind]);
  const recContext = useMemo(
    () => ({ panel: recPanel, data: state.shown === "done" ? state.data : null, catalog, stepSeconds: state.step ?? 0 }),
    [recPanel, state.shown, state.data, catalog, state.step],
  );
  const applyRec = (apply: (p: PanelSpec) => PanelSpec): string | void => {
    const next = apply(recPanel).queries[0]?.expr;
    if (next === undefined || next === expr) return;
    // The hand-written text stays in the trail.
    if (source) record({ expr, sourceId: source.source_id });
    setExpr(next);
    runNow();
  };

  // --- what is drawn -------------------------------------------------------------------------
  const drawPanel = useMemo(
    () => explorePanel(panelId, state.expr ?? expr, source, state.kind ?? kind),
    [panelId, state.expr, expr, source, state.kind, kind],
  );
  const lastGoodPanel = useMemo(
    () => (state.lastGood ? explorePanel(panelId, state.lastGood.expr, source, state.lastGood.kind) : null),
    [panelId, state.lastGood, source],
  );
  let result: ReactNode = null;
  if (state.shown === "done" && state.data && state.range) {
    const empty = state.data.state === "empty";
    result = empty ? (
      <p className={s.note}>{PANEL_COPY.empty}</p>
    ) : (
      <>
        {state.data.state === "partial" && state.data.problems[0] && <p className={s.partial}>{state.data.problems[0]}</p>}
        <div ref={chartBox} className={s.chartBox} data-explore-chart="" data-dim="false" tabIndex={-1}>
          <Suspense fallback={<p className={s.note}>{PANEL_COPY.loading}</p>}>
            <ChartView panel={drawPanel} data={state.data} range={state.range} animate={!reduced} changeId={state.runId} />
          </Suspense>
        </div>
      </>
    );
  } else if (state.shown === "invalid" && state.lastGood && lastGoodPanel) {
    result = (
      <figure className={s.lastGood} data-last-good="">
        <figcaption className={s.lastGoodCaption}>
          <span className={s.lastGoodLabel}>Last good result</span>
          <code className={s.lastGoodQuery}>{state.lastGood.expr}</code>
        </figcaption>
        <div ref={chartBox} className={`${s.chartBox} ${s.dim}`} data-explore-chart="" data-dim="true" tabIndex={-1}>
          <Suspense fallback={<p className={s.note}>{PANEL_COPY.loading}</p>}>
            <ChartView panel={lastGoodPanel} data={state.lastGood.data} range={state.lastGood.range} animate={false} changeId={0} />
          </Suspense>
        </div>
      </figure>
    );
  } else if (state.shown === "failed") {
    result = (
      <div className={s.failure} role="group" aria-labelledby="explore-failure-title">
        <h2 id="explore-failure-title" className={s.failureTitle}>{FAILED_TITLE[state.failure ?? "error"]}</h2>
        {state.message && <p className={s.failureReason}>{state.message}</p>}
        <button type="button" className={s.retry} onClick={runNow}>Try again</button>
      </div>
    );
  }

  // --- the page ------------------------------------------------------------------------------
  const noProjects = tree.data !== undefined && tree.data.projects.length === 0;
  const noSources = projectOut !== null && projectOut.links.length === 0;
  const working = projectOut !== null && !noSources;
  const shown = trail.slice(-TRAIL_SHOWN);
  const current = source ? trailKey({ expr, sourceId: source.source_id }) : "";

  return (
    <section
      ref={page}
      className={s.page}
      aria-labelledby="explore-title"
      onFocus={(e) => { lastFocused.current = e.target as HTMLElement; }}
      onBlur={(e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) lastFocused.current = null; }}
    >
      <header className={s.header}>
        <h1 id="explore-title" ref={heading} tabIndex={-1} className={s.title}>Explore</h1>
        {!noProjects && tree.data && (
          <div className={s.controls}>
            <label className={s.field}>
              <span className={s.fieldLabel}>Project</span>
              <select className={s.select} value={project ?? ""}
                onChange={(e) => { setProjectId(e.target.value); setSourceId(undefined); }}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {working && projectOut && (
              <label className={s.field}>
                <span className={s.fieldLabel}>Source</span>
                <select className={s.select} value={source?.source_id ?? ""} onChange={(e) => setSourceId(e.target.value)}>
                  {projectOut.links.map((l) => (
                    <option key={l.source_id} value={l.source_id}>{`${l.source_name} · ${SOURCE_WORDS[l.source_type]}`}</option>
                  ))}
                </select>
              </label>
            )}
            {working && (
              <TimeRangePicker time={time} open={timeOpen} buttonRef={timeButton}
                onOpen={() => setTimeOpen(true)}
                onClose={(restore) => { setTimeOpen(false); if (restore) timeButton.current?.focus(); }}
                onPick={(t) => { setTime(t); setTimeOpen(false); timeButton.current?.focus(); }} />
            )}
            {working && (
              <button type="button" className={s.add} aria-keyshortcuts="a" aria-disabled="true" aria-description={ADD_LATER} title={ADD_LATER}>
                Add to dashboard
              </button>
            )}
          </div>
        )}
      </header>

      {tree.data === undefined && <p className={s.note} role="status">{tree.isError ? "Couldn't load your projects. Try again from the sidebar." : "Loading projects…"}</p>}

      {noProjects && (
        <div className={s.empty}>
          <p className={s.emptyText}>Explore reads the sources of a project. Set up a project first.</p>
          <button type="button" className={s.primary} onClick={() => nav.navigate({ page: "setup" }, "push")}>Set up a project</button>
        </div>
      )}

      {noSources && projectOut && (
        <div className={s.empty}>
          <p className={s.emptyText}>{`${projectOut.name} has no sources yet. Add one on the project page.`}</p>
          <button type="button" className={s.primary} onClick={() => nav.navigate({ page: "project", id: projectOut.id }, "push")}>
            {`Open ${projectOut.name}`}
          </button>
        </div>
      )}

      {project !== null && projectOut === null && projectQuery.isError && (
        <p className={s.note} role="alert">{`Couldn't read ${projectName || "this project"}. Pick it again, or try again later.`}</p>
      )}

      {working && (
        <div className={s.work}>
          <div className={s.card}>
            <QueryBar ref={queryField} expr={expr} language={language} onChange={setExpr}
              onRun={() => { if (source) record({ expr, sourceId: source.source_id }); runNow(); }}
              onLeave={leaveQuery} />
            <MetaLine state={state} expr={expr} kind={kind} timeText={timeLabel(time)} />
            <RecommendationBar context={recContext} scope={`explore:${project}`} onApply={applyRec}
              onDone={() => queryField.current?.focus()} />
            <div className={s.result}>{result}</div>
          </div>
          <Trail entries={shown} currentKey={current} onPick={pickTrail} onClear={clearAll} />
        </div>
      )}
    </section>
  );
}
