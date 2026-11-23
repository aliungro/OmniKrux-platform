// Explore (X1): one-off questions without building a dashboard. Pick a project and one of its
// sources, type a query, and the result redraws as you type; each query that held is kept in a
// trail to jump back to. The page's state (project, source, query, time) lives in the tab's view,
// written with `replace` after a pause, so a reload or another tab brings it back.
// Under the chart, the log lines of the same time line (X3): a window dragged on the chart narrows them.

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { pressed } from "../../features/chrome/shortcuts";
import { getProject } from "../api/client";
import { projectKey, useMonitoringTree } from "../api/hooks";
import { RecommendationBar } from "../build/RecommendationBar";
import { firstMetric, isLogQlMetric, logSelector, quickCheck } from "../build/promql";
import { guessUnit, humanTitle } from "../build/writeQuery";
import { useOwnerCatalog } from "../catalog/merge";
import { browseMetrics } from "../catalog/metrics";
import { PANEL_COPY } from "../dashboards/grid/PanelState";
import { usePrefersReducedMotion } from "../dashboards/motion";
import { pageLetter } from "../dashboards/page/keys";
import { TimeRangePicker } from "../dashboards/page/TimeRangePicker";
import type { DashboardOwner } from "../dashboards/runPanel";
import type { PanelSpec, TimeSpec } from "../dashboards/schema";
import { resolveTime, timeLabel } from "../dashboards/time";
import { readRecent } from "../home/recent";
import type { MonitoringPageProps } from "../MonitoringApp";
import { isQueryable } from "../sources/sourceLabels";
import { keyboardIsFree } from "../pages/Gone";
import { equalMonitoringView, type ExploreView, type MonitoringView } from "../shell/tabState";
import { DEFAULT_EXPLORE_TIME, defaultExploreProject, defaultExploreSource, exploreTime } from "./exploreDefaults";
import { AddToDashboard, type Added } from "./AddToDashboardDialog";
import { BrowseList } from "./BrowseList";
import { builderActive, builderQuery, builderReducer, EMPTY_BUILDER, metricMatch, writableLabel, type BuilderAction, type ExploreBuilder } from "./builderState";
import { LabelChips } from "./LabelChips";
import { LinkedLogs } from "./LinkedLogs";
import { linkedLogSelector, logMarks } from "./logLinks";
import { FAILED_TITLE, MetaLine, QueryBar } from "./QueryBar";
import { Trail, trailKey } from "./Trail";
import { clearTrail, pushTrail, readTrail, TRAIL_SHOWN, type TrailEntry } from "./trailStore";
import { EXPLORE_DEBOUNCE_MS, explorePanel, linesKey, useExploreRun, useLinesRun } from "./useExploreRun";
import s from "./ExplorePage.module.css";

const ChartView = lazy(() => import("../charts"));

/** A run that answered and whose text stayed this long goes into the trail. */
const TRAIL_SETTLE_MS = 2000;
const SOURCE_WORDS = { prometheus: "Prometheus-compatible", loki: "Loki", alertmanager: "Alertmanager" } as const;
/** Under this width the list folds away behind a button. */
const NARROW_QUERY = "(max-width: 959px)";
const ADD_FIRST = "Run a query first.";
const DEFAULT_PANEL_TITLE = "Explore query";

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

function Explore({ explore, write, nav, tabId, replaceTabView, openInNewTab }: ExploreProps) {
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
  // The point-and-click builder (X2) and the list that feeds it.
  const [builder, setBuilder] = useState<ExploreBuilder>(EMPTY_BUILDER);
  const [narrow, setNarrow] = useState(() => (typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY).matches : false));
  const [browseOpen, setBrowseOpen] = useState(false);
  // The Logs query field: `null` follows the Only chips; any edit makes it the user's own text.
  const [logsText, setLogsText] = useState<string | null>(explore.logs ?? null);
  // A window chosen on the chart, for the lines text, place and range it was chosen on.
  const [windowSel, setWindowSel] = useState<{ key: string; range: { start: number; end: number } } | null>(null);

  // Add to dashboard (X5): the dialog, and what the last add said.
  const [addOpen, setAddOpen] = useState(false);
  const [added, setAdded] = useState<Added | null>(null);
  const [addSeq, setAddSeq] = useState(0);
  const addButton = useRef<HTMLButtonElement>(null);
  const openAdd = useRef<() => void>(() => {});

  const heading = useRef<HTMLHeadingElement>(null);
  const queryField = useRef<HTMLTextAreaElement>(null);
  const timeButton = useRef<HTMLButtonElement>(null);
  const chartBox = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLElement>(null);
  const listBox = useRef<HTMLDivElement>(null);
  // `b` asked for the list while it was folded away: it takes the keyboard once it exists.
  const wantList = useRef(false);
  const linesBox = useRef<HTMLElement>(null);
  const linesHeading = useRef<HTMLHeadingElement>(null);
  const showAll = useRef<HTMLButtonElement>(null);

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
  const { run, state } = useExploreRun({ project: projectOut, source, expr, range, kind, panelId, timeText: timeLabel(time), split: builder.split });
  const runNow = useCallback(() => { setTick((n) => n + 1); run(true); }, [run]);

  // --- the view: written a pause after a change; a replace keeps the keyboard where it is ---------
  const ready = tree.data !== undefined && (project === null || projectOut !== null);
  // The view change waiting for its pause, the last view written (or opened), and this page's tab.
  const pending = useRef<ExploreView | null>(null);
  const written = useRef<MonitoringView>(explore);
  const mountedTab = useRef(tabId);
  const logs = logsText ?? undefined;
  useEffect(() => {
    if (!ready) return;
    const next: ExploreView = { page: "explore", time };
    if (project) next.project = project;
    if (source) next.source = source.source_id;
    if (expr) next.expr = expr;
    if (logs) next.logs = logs;
    pending.current = next;
    const timer = setTimeout(() => {
      pending.current = null;
      written.current = next;
      write(next);
    }, EXPLORE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [ready, project, source, expr, time, logs, write]);
  // Leaving before the pause is over (another tab, another app): the last change still goes to this
  // tab's own view, and only if that view is still the one this page wrote (not a page opened since).
  useEffect(() => () => {
    if (pending.current) replaceTabView?.(mountedTab.current, pending.current, written.current);
  }, [replaceTabView]);

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
    // Another source has another list; the same one keeps its chips, now detached.
    if (entry.sourceId !== source?.source_id) setBuilder(EMPTY_BUILDER);
    else if (builderActive(builder)) setBuilder((b) => builderReducer(b, { type: "typed" }));
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
      } else if (pressed("exploreBrowse", e)) {
        e.preventDefault();
        if (listBox.current) listBox.current.focus();
        else if (!e.repeat) { wantList.current = true; setBrowseOpen(true); }
      } else if (pressed("exploreAdd", e)) {
        e.preventDefault();
        if (!e.repeat) openAdd.current();
      } else if (pressed("exploreLogs", e) && linesBox.current) {
        e.preventDefault();
        // The line the list keeps active, else the section's heading: never <body>.
        const row = linesBox.current.querySelector<HTMLElement>('[role="listitem"][tabindex="0"]');
        (row ?? linesHeading.current)?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  useLayoutEffect(() => {
    if (wantList.current && listBox.current) {
      wantList.current = false;
      listBox.current.focus({ preventScroll: true });
    }
  });

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
  const { catalog, loading: catalogLoading, error: catalogError, refresh: refreshCatalog } = useOwnerCatalog(owner);
  const recPanel = useMemo<PanelSpec>(() => {
    const p = explorePanel(panelId, expr, source, kind);
    // Explore draws lines it can't restyle: the stacking suggestion never applies here.
    return p.type === "timeseries" ? { ...p, options: { ...p.options, style: "area" } } : p;
  }, [panelId, expr, source, kind]);
  const recContext = useMemo(
    () => {
      // Only an answer about exactly this text, project and source: never one being replaced.
      const fresh = state.status === "done" && state.expr === expr && state.projectId === project && state.sourceId === (source?.source_id ?? null);
      return { panel: recPanel, data: fresh ? state.data : null, catalog, stepSeconds: fresh ? (state.step ?? 0) : 0 };
    },
    [recPanel, state.status, state.expr, state.projectId, state.sourceId, state.data, state.step, expr, project, source, catalog],
  );
  const applyRec = (apply: (p: PanelSpec) => PanelSpec): string | void => {
    const next = apply(recPanel).queries[0]?.expr;
    if (next === undefined || next === expr) return;
    // The hand-written text stays in the trail.
    if (source) record({ expr, sourceId: source.source_id });
    setExpr(next);
    if (builderActive(builder)) setBuilder((b) => builderReducer(b, { type: "typed" }));
    runNow();
  };

  // --- browse: the list and the chips write the text through the builder ------------------------
  const browseMode = source?.source_type === "loki" ? "streams" : "metrics";
  const metrics = useMemo(
    () => (catalog && browseMode === "metrics" ? browseMetrics(catalog).filter((m) => m.sourceId === null || m.sourceId === source?.source_id) : []),
    [catalog, browseMode, source?.source_id],
  );
  const streams = useMemo(
    () => (catalog && browseMode === "streams"
      ? catalog.streams.filter((st) => (st.sourceId === null || st.sourceId === source?.source_id) && writableLabel(st.name))
      : []),
    [catalog, browseMode, source?.source_id],
  );
  const applyBuilder = (action: BuilderAction) => {
    const next = builderReducer(builder, action);
    const text = builderQuery(next, metrics, streams);
    // A name the writers refuse leaves the text alone.
    if (text === null) return;
    // Text the chips didn't write is kept in the trail before they replace it.
    if (source && text !== expr && quickCheck(expr) === null && (builder.detached || !builderActive(builder))) {
      record({ expr, sourceId: source.source_id });
    }
    setBuilder(next);
    // The same text again (a Split chip in logs) has nothing to run.
    if (text === expr) return;
    setExpr(text);
    runNow();
  };
  const onType = (text: string) => {
    setExpr(text);
    if (builderActive(builder)) setBuilder((b) => builderReducer(b, { type: "typed" }));
  };
  const pickedMetric = builder.metric === null ? null : (metrics.find((m) => m.name === builder.metric) ?? null);
  const chipLabels = builder.stream ? streams.map((st) => st.name) : (pickedMetric?.labels.filter((l) => l !== "le" && l !== "quantile") ?? []);
  const chipsShown = builder.stream || pickedMetric !== null;
  // Label values are read for a range that stays put while the text changes.
  const labelRange = useMemo(
    () => resolveTime(time, Math.floor(Date.now() / 1000)) ?? (resolveTime(DEFAULT_EXPLORE_TIME, Math.floor(Date.now() / 1000)) as { start: number; end: number }),
    [time.from, time.to, builder.metric, project, source?.source_id],
  );
  const matchText = pickedMetric ? metricMatch(pickedMetric) : null;
  const read = project && source && matchText !== null && !builder.stream
    ? { projectId: project, sourceId: source.source_id, match: matchText, start: labelRange.start, end: labelRange.end }
    : null;
  const known = builder.stream ? Object.fromEntries(streams.map((st) => [st.name, st.values])) : null;

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const refreshList = () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    refreshCatalog().then(
      () => { if (alive.current) setRefreshing(false); },
      (err: unknown) => { if (alive.current) { setRefreshing(false); setRefreshError(failure(err, "try again")); } },
    );
  };

  // --- the log lines on the same time line (X3) ------------------------------------------------
  const logsMode = source?.source_type === "loki";
  const linesSource = logsMode ? source : (projectOut?.links.find((l) => l.source_type === "loki") ?? null);
  const lokiLabels = useMemo(
    () => (catalog && linesSource
      ? catalog.streams.filter((st) => st.sourceId === null || st.sourceId === linesSource.source_id).map((st) => st.name)
      : []),
    [catalog, linesSource],
  );
  // The Only chips' labels that Loki has, written by the Task 5 writer (F16).
  const linked = !logsMode && builder.metric !== null ? linkedLogSelector(builder.only, lokiLabels) : null;
  const fieldText = logsText ?? linked ?? "";
  // An emptied field (or one of only spaces) follows the chips again.
  const editLogs = (text: string) => setLogsText(text.trim() === "" ? null : text);
  const linesText = logsMode ? expr : fieldText;
  const metricQuery = linesText.trim() !== "" && isLogQlMetric(linesText);
  const linesQuery = metricQuery ? "" : linesText;
  const selector = linesQuery.trim() === "" ? null : (logSelector(linesQuery) ?? linesQuery.trim());
  // The lines' whole range stays put while only the metric text changes; a new lines text, place or
  // explicit run reads "now" again, so the lines always cover the time their label names.
  const linesRange = useMemo(
    () => resolveTime(time, Math.floor(Date.now() / 1000)) ?? (resolveTime(DEFAULT_EXPLORE_TIME, Math.floor(Date.now() / 1000)) as { start: number; end: number }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [time.from, time.to, tick, project, linesSource?.source_id, linesQuery],
  );
  const linesFor = linesKey({ project: projectOut, source: linesSource, query: linesQuery, range: linesRange });
  // A window belongs to the text, place and range it was chosen on: any change shows all again.
  const chosen = windowSel !== null && windowSel.key === linesFor ? windowSel.range : null;
  const { state: lines, retry: retryLines } = useLinesRun({
    project: projectOut, source: linesSource, query: linesQuery, range: linesRange, window: chosen, timeText: timeLabel(time),
  });
  const linesCurrent = lines.key === linesFor
    && (lines.window === null ? chosen === null : chosen !== null && lines.window.start === chosen.start && lines.window.end === chosen.end);
  // No Loki in the project: no section and no ticks.
  const linesShown = projectOut !== null && linesSource !== null;
  const linesOn = linesShown && selector !== null;
  const marks = useMemo(
    () => (linesShown && lines.marksFor === linesFor ? logMarks(lines.marks) : []),
    [linesShown, lines.marksFor, lines.marks, linesFor],
  );
  // A window from the keyboard leaves it on the chart: more Shift+arrows adjust it, and Esc shows
  // all again. The lines' status line says which window is shown.
  const onSelectWindow = useCallback((range: { start: number; end: number } | null) => {
    if (range === null) { setWindowSel(null); return; }
    setWindowSel({ key: linesFor, range });
  }, [linesFor]);
  const showAllLines = () => {
    // Show all leaves with the click: the keyboard goes to the chart, never <body>.
    (chartTarget() ?? linesHeading.current)?.focus({ preventScroll: true });
    setWindowSel(null);
  };

  // --- add to dashboard -------------------------------------------------------------------------
  // Only a text that reads as a query can be added. What the builder wrote names the panel.
  const canAdd = source !== null && expr.trim() !== "" && quickCheck(expr) === null && !(state.shown === "invalid" && state.expr === expr);
  const builderWrote = builderActive(builder) && !builder.detached;
  const panelKind = kind;
  const defaultPanelTitle = (() => {
    if (panelKind === "logs") return `Logs from ${logSelector(expr) ?? expr.trim()}`.slice(0, 120);
    const metric = builderWrote && pickedMetric ? pickedMetric.name : firstMetric(expr);
    return metric ? humanTitle(metric) : DEFAULT_PANEL_TITLE;
  })();
  openAdd.current = () => { if (canAdd && !addOpen) setAddOpen(true); };
  // A new text is another question: what was said about the last add no longer fits.
  useEffect(() => { setAdded(null); }, [expr]);

  // --- what is drawn -------------------------------------------------------------------------
  const drawPanel = useMemo(
    () => state.panel ?? explorePanel(panelId, state.expr ?? expr, source, state.kind ?? kind),
    [state.panel, panelId, state.expr, expr, source, state.kind, kind],
  );
  const lastGoodPanel = state.lastGood?.panel ?? null;
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
            <ChartView panel={drawPanel} data={state.data} range={state.range} animate={!reduced} changeId={state.runId}
              selection={linesOn ? chosen : undefined} onSelect={linesOn ? onSelectWindow : undefined} marks={linesShown ? marks : undefined}
              step={state.step ?? undefined} />
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
  const queryable = projectOut ? projectOut.links.filter((l) => isQueryable(l.source_type)) : [];
  const noSources = projectOut !== null && queryable.length === 0;
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
                onChange={(e) => { setProjectId(e.target.value); setSourceId(undefined); setBuilder(EMPTY_BUILDER); setLogsText(null); }}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {working && projectOut && (
              <label className={s.field}>
                <span className={s.fieldLabel}>Source</span>
                <select className={s.select} value={source?.source_id ?? ""} onChange={(e) => { setSourceId(e.target.value); setBuilder(EMPTY_BUILDER); }}>
                  {queryable.map((l) => (
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
              <button ref={addButton} type="button" className={s.add} aria-keyshortcuts="a" aria-disabled={canAdd ? undefined : "true"}
                title={canAdd ? undefined : ADD_FIRST} onClick={() => openAdd.current()}>
                Add to dashboard
              </button>
            )}
            {working && (
              <span className={s.addStatus} role="status">
                {added && (
                  // Keyed by the add, so each new message settles in; the empty region never does.
                  <span key={addSeq} className={s.addMessage}>
                    <span>{`Added to "${added.title}".`}</span>
                    <button type="button" className={s.addOpen} onClick={() => openInNewTab({ page: "dashboard", id: added.id })}>Open dashboard</button>
                  </span>
                )}
              </span>
            )}
          </div>
        )}
      </header>

      {addOpen && projectOut && source && (
        <AddToDashboard project={projectOut} source={source} expr={expr} kind={panelKind} defaultTitle={defaultPanelTitle}
          unit={builderWrote && pickedMetric ? guessUnit(pickedMetric) : "none"} restoreFocusTo={addButton}
          onCancel={() => setAddOpen(false)}
          onAdded={(done) => {
            // The query that was added is worth keeping in the trail.
            record({ expr, sourceId: source.source_id });
            setAdded(done);
            setAddSeq((n) => n + 1);
            setAddOpen(false);
          }} />
      )}

      {tree.data === undefined && <p className={s.note} role="status">{tree.isError ? "Couldn't load your projects. Try again from the sidebar." : "Loading projects…"}</p>}

      {noProjects && (
        <div className={s.empty}>
          <p className={s.emptyText}>Explore reads the sources of a project. Set up a project first.</p>
          <button type="button" className={s.primary} onClick={() => nav.navigate({ page: "setup" }, "push")}>Set up a project</button>
        </div>
      )}

      {noSources && projectOut && (
        <div className={s.empty}>
          <p className={s.emptyText}>{projectOut.links.length === 0 ? `${projectOut.name} has no sources yet. Add one on the project page.` : `${projectOut.name} has no source Explore can query. Add a Prometheus-compatible or Loki source on the project page.`}</p>
          <button type="button" className={s.primary} onClick={() => nav.navigate({ page: "project", id: projectOut.id }, "push")}>
            {`Open ${projectOut.name}`}
          </button>
        </div>
      )}

      {project !== null && projectOut === null && projectQuery.isError && (
        <p className={s.note} role="alert">{`Couldn't read ${projectName || "this project"}. Pick it again, or try again later.`}</p>
      )}

      {working && (
        <div className={s.shell}>
          {narrow && (
            <button type="button" className={s.browseToggle} aria-expanded={browseOpen} aria-controls="explore-browse"
              onClick={() => setBrowseOpen((o) => !o)}>
              {browseMode === "metrics" ? "Metrics" : "Log streams"}
            </button>
          )}
          {(!narrow || browseOpen) && (
            <aside id="explore-browse" className={s.browse}>
              <BrowseList ref={listBox} mode={browseMode} projectName={projectName} metrics={metrics} streams={streams}
                selectedMetric={builder.metric} selectedStreams={builder.stream ? builder.only : {}}
                loading={catalogLoading && catalog === null} error={catalogError}
                notes={catalog ? [...catalog.problems, ...catalog.notes] : []} builtAt={catalog?.builtAt ?? null}
                refreshing={refreshing} refreshError={refreshError} onRefresh={refreshList}
                onPickMetric={(metric) => applyBuilder({ type: "pickMetric", metric })}
                onPickStream={(label, value) => applyBuilder({ type: "pickStream", label, value })} />
            </aside>
          )}
          <div className={s.work}>
          <div className={s.card}>
            <QueryBar ref={queryField} expr={expr} language={language} onChange={onType}
              onRun={() => {
                // Only a text that reads as a query is worth keeping.
                if (source && quickCheck(expr) === null) record({ expr, sourceId: source.source_id });
                runNow();
              }}
              onLeave={leaveQuery} />
            {chipsShown && (
              <LabelChips builder={builder} labels={chipLabels} loki={lokiLabels} known={known} read={read}
                onSplit={(label) => applyBuilder({ type: "split", label })}
                onOnly={(label, value) => applyBuilder({ type: "only", label, value })} />
            )}
            <MetaLine state={state} expr={expr} kind={kind} />
            <RecommendationBar context={recContext} scope={`explore:${project}`} onApply={applyRec}
              onDone={() => queryField.current?.focus()} />
            <div className={s.result}>{result}</div>
            {linesShown && linesSource && (
              <LinkedLogs ref={linesBox} headingRef={linesHeading} showAllRef={showAll}
                mode={logsMode ? "logs" : "metrics"} sourceName={linesSource.source_name}
                field={logsMode ? undefined : { value: fieldText, onChange: editLogs }}
                selector={selector} metricQuery={metricQuery} state={lines} current={linesCurrent}
                window={chosen} range={linesRange} onShowAll={showAllLines} onRetry={retryLines} />
            )}
          </div>
          <Trail entries={shown} currentKey={current} onPick={pickTrail} onClear={clearAll} />
          </div>
        </div>
      )}
    </section>
  );
}
