// The selected panel's settings beside the grid (E2): Query, Chart, Options and Alert. Every change
// goes into the draft at once (`updatePanel`), so the JSON and the panel agree; the panel's frame
// redraws in place, and its queries run once the typing stops (D1).
import { useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { RecommendationBar } from "../../build/RecommendationBar";
import { useOwnerCatalog } from "../../catalog/merge";
import { escapeCloses } from "../../focus";
import type { DashboardOwner, PanelData } from "../runPanel";
import type { OwnerKind, PanelSpec } from "../schema";
import { AlertTab } from "./AlertTab";
import { ChartTab } from "./ChartTab";
import { JSON_FIRST, type EditingState, type EditorAction, type SideTab } from "./editorState";
import { OptionsTab } from "./OptionsTab";
import { QueryTab } from "./QueryTab";
import s from "./SidePanel.module.css";

/** A panel's run as its frame reports it while editing. */
export interface PanelLive {
  data: PanelData | null;
  /** A run for the current queries is on its way. */
  fetching: boolean;
  /** Its owner or a variable it uses is still loading. */
  waiting: boolean;
  /** The draft's queries changed and haven't run yet (the typing hasn't stopped). */
  pending: boolean;
  /** Run the draft's queries now. */
  flush(): void;
  /** The step the run used, in seconds; null when the panel has no run. */
  step: number | null;
}

/** Changes one panel of the draft; `update` gets the panel as the draft has it. */
export type PanelUpdate = (update: (p: PanelSpec) => PanelSpec) => void;

const TABS: readonly [SideTab, string][] = [["query", "Query"], ["chart", "Chart"], ["options", "Options"], ["alert", "Alert"]];

export const panelName = (p: PanelSpec) => p.title.trim() || "Untitled panel";

export interface SidePanelProps {
  state: EditingState;
  dispatch(action: EditorAction): void;
  owner: DashboardOwner | null;
  ownerKind: OwnerKind;
  panelData: PanelData | null;
  /** The panel's run besides its data: running, waiting for the typing to stop, Run now. */
  live?: Omit<PanelLive, "data"> | null;
  /** Where the keyboard goes when it opens: the active tab, the first query, or nowhere (a click). */
  initialFocus?: "tab" | "query" | "none";
  /** Changes with each opening, so the keyboard goes there again. */
  seq?: number;
  onClose(): void;
}

export function SidePanel({ state, dispatch, owner, ownerKind, panelData, live = null, initialFocus = "tab", seq = 0, onClose }: SidePanelProps) {
  const base = useId();
  const tabs = useRef<Partial<Record<SideTab, HTMLButtonElement | null>>>({});
  const body = useRef<HTMLDivElement>(null);
  const panel = state.draft.panels.find((p) => p.id === state.selected);
  const tab = state.sideTab;
  const { catalog } = useOwnerCatalog(owner);

  useLayoutEffect(() => {
    if (initialFocus === "query") body.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    else if (initialFocus === "tab") tabs.current[tab]?.focus();
    // Only on opening (not on `tab`): a tab change moves the keyboard itself.
  }, [initialFocus, seq]);

  if (!panel) return null;
  const id = panel.id;
  const update: PanelUpdate = (fn) => dispatch({ type: "updatePanel", id, update: fn });

  const select = (t: SideTab) => {
    dispatch({ type: "sideTab", tab: t });
    tabs.current[t]?.focus();
  };
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex(([t]) => t === tab);
    const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (to === null || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    select(TABS[(to + TABS.length) % TABS.length][0]);
  };

  // Apply is a draft edit, so it is refused while the JSON tab holds text that doesn't apply.
  const applyRecommendation = (apply: (p: PanelSpec) => PanelSpec) => {
    if (state.jsonText !== null) return JSON_FIRST;
    update(apply);
  };
  // The run's data is what the draft's queries answered: not while they are changing or running
  // (a query edit changes the run key, so pending and fetching cover it).
  const fresh = live !== null && !live.pending && !live.fetching && panelData !== null;

  return (
    <aside className={s.side} aria-label="Panel settings" onKeyDown={escapeCloses(onClose)}>
      <div className={s.head}>
        <h2 className={s.title}>{panelName(panel)}</h2>
        <button type="button" className={s.close} aria-label="Close panel settings" onClick={onClose}>
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <RecommendationBar
        context={{ panel, data: fresh ? panelData : null, catalog, stepSeconds: live?.step ?? 0 }}
        scope={state.dashboardId} onApply={applyRecommendation} onDone={() => select("query")} />
      <div role="tablist" aria-label="Panel settings" className={s.tabs} onKeyDown={onTabKey}>
        {TABS.map(([t, label]) => (
          <button key={t} ref={(el) => { tabs.current[t] = el; }} id={`${base}-tab-${t}`} type="button" role="tab"
            aria-selected={t === tab} aria-controls={`${base}-panel`} tabIndex={t === tab ? 0 : -1}
            className={s.tab} onClick={() => select(t)}>
            {label}
          </button>
        ))}
      </div>
      <div ref={body} id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${tab}`}
        tabIndex={tab === "alert" ? 0 : undefined} className={s.body}>
        {tab === "query" && (
          <QueryTab panel={panel} update={update} owner={owner} ownerKind={ownerKind} data={panelData} live={live} />
        )}
        {tab === "chart" && <ChartTab panel={panel} update={update} onRunNow={live?.flush} />}
        {tab === "options" && <OptionsTab panel={panel} update={update} />}
        {tab === "alert" && <AlertTab />}
      </div>
    </aside>
  );
}
