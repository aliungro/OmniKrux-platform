// One panel: its title, description, Partial badge and body. It runs its own queries, reports
// when its data was read, and keeps the keyboard off <body> when its chart goes away. In edit
// mode it is also a tile (`tile`): focusable, named by its place, with move and resize handles;
// it runs its queries 300 ms after the typing stops, and its frame flashes when it is edited (D1).
// Memoised: an edit re-renders only the panel it changed. A panel with an alert wears its state in
// the corner (the worst of its targets); in edit mode a changed alert says it isn't saved yet, and
// the tile's ⋯ menu (Settings, Duplicate, Remove) sits before its ⋮⋮ handle.
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { usePanelStates } from "../../alerts/api";
import { notRefreshedWords, STATE_LABEL, STATE_READING, STATE_UNKNOWN, stateTone } from "../../alerts/format";
import { interpolateTitle, type ResolvedVars } from "../interpolate";
import { buildPanelRun, panelRunKey, usePanelData, type DashboardOwner, type PanelData, type PanelDataResult, type PanelRun } from "../runPanel";
import { sameJson } from "../sameJson";
import type { Layout, PanelAlert, PanelSpec } from "../schema";
import type { TileProps } from "../editor/EditableGrid";
import { panelName } from "../editor/SidePanel";
import { useDebouncedQueries } from "../editor/useDebouncedQueries";
import { FLASH_MS, usePrefersReducedMotion } from "../motion";
import type { PanelStatusStore } from "../page/useDashboardContext";
import { PanelBody } from "./PanelBody";
import s from "./DashboardGrid.module.css";

interface Props {
  dashboardId: string;
  panel: PanelSpec;
  owner: DashboardOwner | null;
  ownerName: string;
  vars: ResolvedVars;
  range: { start: number; end: number };
  waiting: boolean;
  /** Why it can't run (a variable it uses has no values): said as its failure, and nothing is sent. */
  blocked: string | null;
  refreshSeq: number;
  status: PanelStatusStore;
  /** `changes[panel.id]` in edit mode (0 in view mode): the chart's `changeId` and the run's `editId`. */
  changeId?: number;
  /** Where it is drawn, when that isn't `panel.layout` (a drag in progress). */
  layout?: Layout;
  tile?: TileProps;
  /** The panel's alert as saved (in view mode, its own): a draft alert that differs isn't saved yet. */
  savedAlert?: PanelAlert | null;
  /** The badge opens its rule on the Alerts page (a new workspace tab with Ctrl). */
  openRule?(ruleId: string, newTab: boolean): void;
  /** Rises when a link to this panel arrives: its frame flashes (not under reduced motion). */
  spotlight?: number;
}

export const NOT_SAVED_YET = "Alert: not saved yet";
export const badgeLabel = (name: string, label: string) => `Alert "${name}": ${label}`;

/** A panel alert's state in the corner: a pill, and a way to its rule on the Alerts page. */
function AlertBadge({ dashboardId, panelId, alert, changed, openRule }: {
  dashboardId: string;
  panelId: string;
  alert: PanelAlert;
  changed: boolean;
  openRule?(ruleId: string, newTab: boolean): void;
}) {
  const states = usePanelStates(dashboardId);
  if (changed) {
    return <span className={s.badge} data-tone="muted" role="img" aria-label={badgeLabel(alert.name, "not saved yet")}><span aria-hidden="true">● </span>{NOT_SAVED_YET}</span>;
  }
  const state = states.data?.[panelId];
  // Never shown as OK while it isn't known: waiting while it is read; unknown when the last read
  // failed, even with an earlier answer kept (its state and time are said, never shown as current).
  if (!state || states.isError) {
    const label = states.isError ? STATE_UNKNOWN : STATE_READING;
    const stale = state && states.isError ? notRefreshedWords(STATE_LABEL[state.state], states.dataUpdatedAt) : null;
    return (
      <span className={s.badge} data-tone="muted" role="img" title={stale ?? undefined}
        aria-label={`${badgeLabel(state?.name ?? alert.name, label)}${stale ? `. ${stale}` : ""}`}>
        <span aria-hidden="true">● </span>{label}
      </span>
    );
  }
  const label = STATE_LABEL[state.state];
  const open = (e: MouseEvent<HTMLButtonElement>) => openRule?.(state.rule_id, e.ctrlKey || e.metaKey);
  // Ctrl+Enter opens it in a new workspace tab, as a dashboard link in a project's list does.
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    openRule?.(state.rule_id, true);
  };
  return (
    <button type="button" className={s.badge} data-tone={stateTone(state.state)} data-state={state.state}
      aria-label={badgeLabel(state.name, label)} aria-keyshortcuts="Control+Enter" onClick={open} onKeyDown={keys}>
      <span aria-hidden="true">● </span>{label}
    </button>
  );
}

const NO_RUN: PanelRun = { requests: [], parts: [], skipped: [], ownerKind: "project", range: { start: 0, end: 1 }, step: 1 };

/** The same run object while nothing it sends or says changes, so the panel's data keeps its identity. */
function useStableRun(run: PanelRun): PanelRun {
  const last = useRef(run);
  const same = (a: PanelRun, b: PanelRun) =>
    panelRunKey(a) === panelRunKey(b) && JSON.stringify([a.skipped, a.range, a.step, a.parts]) === JSON.stringify([b.skipped, b.range, b.step, b.parts]);
  if (last.current !== run && !same(last.current, run)) last.current = run;
  return last.current;
}

/**
 * `changes` restart at 0 with each edit session, but the chart compares edit counts with the last
 * frame it drew: counts keep rising across sessions, so a later session's first edit still morphs.
 */
function useRisingCount(count: number): number {
  const seen = useRef({ base: 0, last: count });
  if (count < seen.current.last) seen.current.base += seen.current.last;
  seen.current.last = count;
  return seen.current.base + count;
}

/** True for `FLASH_MS` after each rise of `count` while editing. */
function useFlash(count: number, on: boolean): boolean {
  const [flash, setFlash] = useState(false);
  const last = useRef(count);
  useLayoutEffect(() => {
    const rose = count > last.current;
    last.current = count;
    if (!rose || !on) return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [count, on]);
  useEffect(() => { if (!on) setFlash(false); }, [on]);
  return flash && on;
}

/** A panel that can't run, as a failure: the same words in its body, its state and the Query tab. */
const blockedData = (reason: string): PanelData => ({
  state: "error", series: [], logs: [], problems: [reason], summary: { series: 0, points: 0, tookMs: 0 }, editId: 0,
});

export const PanelFrame = memo(function PanelFrame({
  dashboardId, panel, owner, ownerName, vars, range, waiting, blocked, refreshSeq, status, changeId: changes = 0, layout, tile, savedAlert,
  openRule, spotlight = 0,
}: Props) {
  const titleId = useId();
  // The tile shows the chosen values in place of `$name`; the stored title stays as written.
  const shownTitle = useMemo(
    () => interpolateTitle(panel.title, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.value]))),
    [panel.title, vars],
  );
  const tipId = useId();
  const problemsId = useId();
  const frame = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const reduced = usePrefersReducedMotion();
  const changeId = useRisingCount(changes);
  // Morphs, counts and this highlight are all off under reduced motion.
  const flash = useFlash(changes, tile !== undefined && !reduced);
  // A link to this panel arrived: it flashes once, the same way.
  const spot = useFlash(spotlight, !reduced);
  // While editing, the queries (and a logs panel's Lines) run 300 ms after the typing stops;
  // everything else applies at once.
  const debounced = useDebouncedQueries(panel, tile ? 300 : 0);
  const runPanel = useMemo(() => {
    if (debounced.queries === panel.queries && (panel.type !== "logs" || debounced.limit === panel.options.limit)) return panel;
    const p = { ...panel, queries: debounced.queries } as PanelSpec;
    return p.type === "logs" && debounced.limit !== null ? { ...p, options: { ...p.options, limit: debounced.limit } } : p;
  }, [panel, debounced.queries, debounced.limit]);
  const built = useMemo(
    () => (owner ? buildPanelRun({ panel: runPanel, owner, vars, range, ownerName }) : NO_RUN),
    [runPanel, owner, vars, range, ownerName],
  );
  const run = useStableRun(built);
  const ran = usePanelData(dashboardId, runPanel, run, null, owner !== null && !waiting && blocked === null, changeId);
  const result = useMemo<PanelDataResult>(
    () => (blocked === null || waiting ? ran : { ...ran, data: blockedData(blocked), fetching: false, stale: false, updatedAt: null, failedAt: null }),
    [ran, blocked, waiting],
  );
  const key = panelRunKey(run);

  // A refresh whose window didn't move (the range is aligned to the step) reads it again; a new
  // window is a new key and runs by itself.
  const seen = useRef({ seq: refreshSeq, key });
  useEffect(() => {
    const before = seen.current;
    seen.current = { seq: refreshSeq, key };
    if (refreshSeq !== before.seq && key === before.key && !waiting && blocked === null) result.refetch();
  }, [refreshSeq, key, waiting, blocked, result]);

  const loading = waiting || result.fetching;
  const updatedAt = waiting ? null : result.updatedAt;
  useEffect(() => { status.report(panel.id, { updatedAt, loading }); }, [status, panel.id, updatedAt, loading]);
  useEffect(() => () => status.report(panel.id, null), [status, panel.id]);

  // While editing, the side panel reads this panel's run: its data, and whether the typing stopped.
  const report = tile?.report;
  const { pending, flush } = debounced;
  useEffect(() => {
    report?.(panel.id, { data: result.data, fetching: result.fetching, waiting, pending, flush, step: owner ? run.step : null, run: owner ? run : null });
  }, [report, panel.id, result.data, result.fetching, waiting, pending, flush, owner, run]);
  useEffect(() => () => report?.(panel.id, null), [report, panel.id]);

  // The keyboard was inside this panel (a table header, a log line, Try again) and what held it
  // went away with a new state: it goes to the panel's title, never to <body>.
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (hadFocus.current && (active === null || active === document.body)) (tile ? frame : heading).current?.focus({ preventScroll: true });
  });

  const state = waiting ? null : result.data?.state;
  // The last result, kept while the answer to a changed range or changed queries is on its way.
  const stale = !waiting && blocked === null && result.stale;
  const partial = state === "partial" && result.data !== null;
  const { x, y, w, h } = layout ?? panel.layout;
  const place = {
    "--col": `${x + 1} / span ${w}`,
    "--row": `${y + 1} / span ${h}`,
    "--rows": h,
    ...(tile?.offset ? { "--dx": `${tile.offset.x}px`, "--dy": `${tile.offset.y}px` } : {}),
  } as CSSProperties;
  // The tile is named by the title it shows (the chosen values in place of `$name`), then its place.
  const stored = panelName(panel);
  const named = tile
    ? { "aria-label": tile.label.startsWith(stored) ? (shownTitle.trim() || "Untitled panel") + tile.label.slice(stored.length) : tile.label }
    : { "aria-labelledby": titleId };

  const classes = [s.panel, tile ? s.tile : "", flash ? s.flash : "", spot ? s.spot : ""].filter(Boolean).join(" ");
  const saved = savedAlert === undefined ? panel.alert : savedAlert;
  // The badge: the saved alert's state; in edit mode a draft alert that differs isn't saved yet.
  const changedAlert = tile !== undefined && !(panel.alert === saved || (panel.alert !== null && saved !== null && sameJson(panel.alert, saved)));
  const badgeAlert = changedAlert ? (panel.alert ?? saved) : saved;
  const badge = badgeAlert
    ? <AlertBadge dashboardId={dashboardId} panelId={panel.id} alert={badgeAlert} changed={changedAlert} openRule={openRule} />
    : null;

  return (
    <section ref={frame} className={classes} style={place} {...named} data-state={state ?? "loading"} data-stale={stale || undefined} aria-busy={stale || undefined} data-panel-id={panel.id} data-spot={spot || undefined}
      tabIndex={tile?.tabIndex} data-tile-id={tile ? panel.id : undefined} data-selected={tile?.selected || undefined}
      data-dragging={tile?.dragging || undefined} data-motion={tile && reduced ? "off" : undefined}
      onKeyDown={tile?.onKeyDown} onClick={tile?.onClick}
      onFocus={(e) => { hadFocus.current = true; if (e.target === e.currentTarget) tile?.onFocus(); }}
      onBlur={(e) => {
        // Leaving for somewhere else ends it; an element removed under the keyboard doesn't.
        if (e.relatedTarget !== null || e.target.isConnected) hadFocus.current = e.relatedTarget instanceof Node && !!frame.current?.contains(e.relatedTarget);
      }}>
      <header className={s.panelHead}>
        <h2 id={titleId} ref={heading} tabIndex={-1} className={s.panelTitle}>{shownTitle}</h2>
        {panel.description.trim() !== "" && (
          <span className={s.about}>
            <button type="button" className={s.aboutButton} aria-label={`About ${shownTitle}`} aria-describedby={tipId}>ⓘ</button>
            <span id={tipId} role="tooltip" className={s.tip}>{panel.description}</span>
          </span>
        )}
        {partial && (
          <span className={s.about}>
            <span className={s.partial} tabIndex={0} aria-describedby={problemsId}>Partial</span>
            <span id={problemsId} role="tooltip" className={s.tip}>
              {result.data!.problems.map((p) => <span key={p} className={s.tipLine}>{p}</span>)}
            </span>
          </span>
        )}
        {(badge || tile) && <span className={s.headEnd}>{badge}{tile?.menu}{tile?.grab}</span>}
      </header>
      {stale && <span className={s.progress} aria-hidden="true" />}
      <div className={s.body}>
        {/* Only edits animate: view mode has none, and reduced motion always jumps. */}
        <PanelBody panel={panel} run={run} result={result} waiting={waiting} changeId={changeId}
          animate={tile !== undefined && !reduced} />
      </div>
      {tile?.corner}
    </section>
  );
});
