// One panel: its title, description, Partial badge and body. It runs its own queries, reports
// when its data was read, and keeps the keyboard off <body> when its chart goes away. In edit
// mode it is also a tile (`tile`): focusable, named by its place, with move and resize handles.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import type { ResolvedVars } from "../interpolate";
import { buildPanelRun, panelRunKey, usePanelData, type DashboardOwner, type PanelRun } from "../runPanel";
import type { Layout, PanelSpec } from "../schema";
import type { TileProps } from "../editor/EditableGrid";
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
  refreshSeq: number;
  status: PanelStatusStore;
  /** `changes[panel.id]` in edit mode (0 in view mode): the chart's `changeId` and the run's `editId`. */
  changeId?: number;
  /** Where it is drawn, when that isn't `panel.layout` (a drag in progress). */
  layout?: Layout;
  tile?: TileProps;
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

export function PanelFrame({ dashboardId, panel, owner, ownerName, vars, range, waiting, refreshSeq, status, changeId = 0, layout, tile }: Props) {
  const titleId = useId();
  const tipId = useId();
  const problemsId = useId();
  const frame = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const built = useMemo(
    () => (owner ? buildPanelRun({ panel, owner, vars, range, ownerName }) : NO_RUN),
    [panel, owner, vars, range, ownerName],
  );
  const run = useStableRun(built);
  const result = usePanelData(dashboardId, panel, run, null, owner !== null && !waiting, changeId);
  const key = panelRunKey(run);

  // A refresh whose window didn't move (the range is aligned to the step) reads it again; a new
  // window is a new key and runs by itself.
  const seen = useRef({ seq: refreshSeq, key });
  useEffect(() => {
    const before = seen.current;
    seen.current = { seq: refreshSeq, key };
    if (refreshSeq !== before.seq && key === before.key && !waiting) result.refetch();
  }, [refreshSeq, key, waiting, result]);

  const loading = waiting || result.fetching;
  const updatedAt = waiting ? null : result.updatedAt;
  useEffect(() => { status.report(panel.id, { updatedAt, loading }); }, [status, panel.id, updatedAt, loading]);
  useEffect(() => () => status.report(panel.id, null), [status, panel.id]);

  // The keyboard was inside this panel (a table header, a log line, Try again) and what held it
  // went away with a new state: it goes to the panel's title, never to <body>.
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (hadFocus.current && (active === null || active === document.body)) (tile ? frame : heading).current?.focus({ preventScroll: true });
  });

  const state = waiting ? null : result.data?.state;
  const partial = state === "partial" && result.data !== null;
  const { x, y, w, h } = layout ?? panel.layout;
  const place = {
    "--col": `${x + 1} / span ${w}`,
    "--row": `${y + 1} / span ${h}`,
    "--rows": h,
    ...(tile?.offset ? { "--dx": `${tile.offset.x}px`, "--dy": `${tile.offset.y}px` } : {}),
  } as CSSProperties;
  const named = tile ? { "aria-label": tile.label } : { "aria-labelledby": titleId };

  return (
    <section ref={frame} className={tile ? `${s.panel} ${s.tile}` : s.panel} style={place} {...named} data-state={state ?? "loading"}
      tabIndex={tile?.tabIndex} data-tile-id={tile ? panel.id : undefined} data-selected={tile?.selected || undefined}
      data-dragging={tile?.dragging || undefined} onKeyDown={tile?.onKeyDown}
      onFocus={(e) => { hadFocus.current = true; if (e.target === e.currentTarget) tile?.onFocus(); }}
      onBlur={(e) => {
        // Leaving for somewhere else ends it; an element removed under the keyboard doesn't.
        if (e.relatedTarget !== null || e.target.isConnected) hadFocus.current = e.relatedTarget instanceof Node && !!frame.current?.contains(e.relatedTarget);
      }}>
      <header className={s.panelHead}>
        <h2 id={titleId} ref={heading} tabIndex={-1} className={s.panelTitle}>{panel.title}</h2>
        {panel.description.trim() !== "" && (
          <span className={s.about}>
            <button type="button" className={s.aboutButton} aria-label={`About ${panel.title}`} aria-describedby={tipId}>ⓘ</button>
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
        {tile?.grab}
      </header>
      <div className={s.body}>
        <PanelBody panel={panel} run={run} result={result} waiting={waiting} changeId={changeId} />
      </div>
      {tile?.corner}
    </section>
  );
}
