// A dashboard, in view mode: header, Updated line, ready-made note, variables and the panel
// grid; and the JSON tab (the saved document, read-only until the JSON editor arrives). Time,
// variables, auto-refresh and the view tab live in the tab's view (replace navigations).
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { failure } from "../../../api/http";
import { pageKey, pressed } from "../../../features/chrome/shortcuts";
import type { MonitoringPageProps } from "../../MonitoringApp";
import { Gone, keyboardIsFree } from "../../pages/Gone";
import { MONITORING_HOME, type MonitoringView } from "../../shell/tabState";
import { useDashboard, useReadyMade, type DashboardOut } from "../api";
import type { VarValue } from "../interpolate";
import { dashboardJson, type RefreshSpec, type TimeSpec } from "../schema";
import { DashboardGrid } from "../grid/DashboardGrid";
import { DashboardHeader, type DashboardTab, type MenuAction } from "./DashboardHeader";
import { RefreshControl } from "./RefreshControl";
import { TimeRangePicker } from "./TimeRangePicker";
import { PROJECTS_VAR, useDashboardContext, usePanelStatus, type DashboardViewState, type PanelStatusStore } from "./useDashboardContext";
import { VariablesBar } from "./VariablesBar";
import s from "./DashboardPage.module.css";

const two = (n: number) => String(n).padStart(2, "0");
const clockTime = (ms: number) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };

/** When the data was last read: the oldest panel read of the current set, or Updating… while any loads. */
function UpdatedLine({ status }: { status: PanelStatusStore }) {
  const { updatedAt, updating } = usePanelStatus(status);
  const text = updating ? "Updating…" : updatedAt !== null ? `Updated ${clockTime(updatedAt)}` : null;
  return <p className={s.updated} data-updating={updating || undefined}>{text}</p>;
}

/** Under a ready-made view's header: where it comes from, and what its project's Prometheus lacks. */
function ReadyNote({ dashboard }: { dashboard: DashboardOut }) {
  const ready = useReadyMade(dashboard.owner_id);
  const notes = ready.data?.find((r) => r.id === dashboard.id)?.notes ?? [];
  return (
    <div className={s.readyNote}>
      <p className={s.readyLine}>Ready-made views are generated from what {dashboard.owner_name}'s Prometheus has. Copy one to change it.</p>
      {notes.map((n) => <p key={n} className={s.readyLine}>{n}</p>)}
    </div>
  );
}

/** Letter keys belong to the page only outside fields, dialogs and the page's own menus and pickers. */
function pageLetter(e: KeyboardEvent): boolean {
  if (!pageKey(e)) return false;
  const t = e.target;
  return !(t instanceof Element && t.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-dashboard-popup]'));
}

function DashboardScreen({ view, dashboard, nav, openInNewTab }: MonitoringPageProps & { view: DashboardViewState; dashboard: DashboardOut }) {
  const { spec } = dashboard;
  const ready = dashboard.ready_made;
  const ctx = useDashboardContext(view, spec, dashboard.owner_kind, dashboard.owner_id);
  const tabs: DashboardTab[] = ["dashboard", "json"];
  const tab: DashboardTab = view.tab && tabs.includes(view.tab) ? view.tab : "dashboard";

  const base = useId();
  const titleId = `${base}-title`;
  const tabIds = useCallback((t: DashboardTab) => ({ tab: `${base}-tab-${t}`, panel: `${base}-panel-${t}` }), [base]);
  const title = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<Partial<Record<DashboardTab, HTMLButtonElement | null>>>({});
  const timeButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const [timeOpen, setTimeOpen] = useState(false);

  // The page opens with the keyboard on its title, unless the user is working elsewhere (Find, the tree).
  useEffect(() => { if (keyboardIsFree()) title.current?.focus({ preventScroll: true }); }, []);

  // View state changes replace the view: Back still goes to where the user came from.
  const replace = useCallback((patch: Partial<DashboardViewState>) => {
    nav.navigate((v) => (v.page === "dashboard" && v.id === view.id ? { ...v, ...patch } : v), "replace");
  }, [nav, view.id]);
  const setVar = useCallback((name: string, value: VarValue) => {
    nav.navigate((v) => (v.page === "dashboard" && v.id === view.id ? { ...v, vars: { ...v.vars, [name]: value } } : v), "replace");
  }, [nav, view.id]);
  const selectTab = useCallback((t: DashboardTab) => {
    replace({ tab: t });
    tabRefs.current[t]?.focus();
  }, [replace]);
  const pickTime = (t: TimeSpec) => {
    setTimeOpen(false);
    replace({ time: t });
    timeButton.current?.focus();
  };
  const closeTime = useCallback((restore: boolean) => {
    setTimeOpen(false);
    if (restore) timeButton.current?.focus();
  }, []);
  const refreshNow = useCallback(() => {
    ctx.refreshNow();
    refreshButton.current?.focus();
  }, [ctx]);
  const edit = undefined as (() => void) | undefined; // Edit mode and Copy to edit arrive with the editor.

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pageLetter(e)) return;
      if (pressed("dashboardViews", e)) {
        const t = tabs[Number(e.key) - 1];
        if (!t) return;
        e.preventDefault();
        selectTab(t);
      } else if (pressed("dashboardTime", e)) {
        e.preventDefault();
        setTimeOpen(true);
      } else if (pressed("dashboardRefresh", e)) {
        e.preventDefault();
        refreshNow();
      } else if (pressed("dashboardEdit", e) && !ready) {
        e.preventDefault();
        editButton.current?.focus();
        edit?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // The owner read failed and Try again worked: its button went with the message, and the
  // keyboard goes to the title rather than <body>.
  const ownerRetry = useRef<HTMLButtonElement>(null);
  const failed = ctx.ownerFailure !== null;
  const wasFailed = useRef(failed);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (wasFailed.current && !failed && (active === null || active === document.body)) title.current?.focus({ preventScroll: true });
    wasFailed.current = failed;
  }, [failed]);

  const openPage = (target: MonitoringView, e: MouseEvent<HTMLAnchorElement>) =>
    (e.ctrlKey || e.metaKey ? openInNewTab(target) : nav.navigate(target, "push"));
  const ownerView = { page: dashboard.owner_kind, id: dashboard.owner_id } as const;
  const openOwner = (e: MouseEvent<HTMLAnchorElement>) => openPage(ownerView, e);
  const actions: MenuAction[] = ready ? [{ label: "Copy dashboard…" }] : [{ label: "Copy dashboard…" }, { label: "Delete dashboard…", danger: true }];
  const ids = tabIds(tab);

  return (
    <section className={s.page} aria-labelledby={titleId}>
      <DashboardHeader title={spec.title || dashboard.title} titleId={titleId} titleRef={title}
        ownerName={dashboard.owner_name || ctx.ownerName} onOwner={openOwner} readyMade={ready}
        tabs={tabs} tab={tab} tabIds={tabIds} onTab={selectTab} tabRefs={tabRefs}
        timeControl={<TimeRangePicker time={ctx.time} open={timeOpen} onOpen={() => setTimeOpen(true)} onClose={closeTime} onPick={pickTime} buttonRef={timeButton} />}
        refreshControl={<RefreshControl value={ctx.refresh} onRefresh={refreshNow} buttonRef={refreshButton}
          onChange={(r: RefreshSpec) => replace({ refresh: r })} />}
        editRef={editButton} onEdit={edit} moreRef={moreButton} actions={actions} />
      <UpdatedLine status={ctx.status} />
      {ready && <ReadyNote dashboard={dashboard} />}
      <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} className={s.content}>
        {tab === "dashboard" && ctx.ownerFailure && (
          <div className={s.ownerFailure} role="alert">
            <p className={s.ownerProblem}>{ctx.ownerFailure.message}</p>
            <button ref={ownerRetry} type="button" className={s.retry} aria-disabled={ctx.ownerFailure.retrying || undefined}
              onClick={() => { if (!ctx.ownerFailure?.retrying) ctx.ownerFailure?.retry(); }}>
              {ctx.ownerFailure.retrying ? "Trying again…" : "Try again"}
            </button>
          </div>
        )}
        {tab === "dashboard" && !ctx.ownerFailure && (
          <>
            <VariablesBar projects={ctx.projects} projectsLoading={ctx.owner === null} variables={ctx.variables}
              onVar={setVar} onProjects={(value) => setVar(PROJECTS_VAR, value)} onRetry={ctx.retryVariable}
              onOpenProject={(p, e) => openPage({ page: "project", id: p.id }, e)} />
            <DashboardGrid dashboardId={dashboard.id} panels={spec.panels} owner={ctx.owner} ownerName={ctx.ownerName}
              vars={ctx.vars} range={ctx.range} waiting={ctx.waiting} refreshSeq={ctx.refreshSeq} status={ctx.status} />
          </>
        )}
        {tab === "json" && <pre className={s.json} aria-label="Dashboard JSON" tabIndex={0}>{dashboardJson(spec)}</pre>}
      </div>
    </section>
  );
}

/** `PAGES.dashboard`: reads the dashboard, then shows it; a dashboard that is gone says so. */
export default function DashboardPage(props: MonitoringPageProps) {
  const id = props.view.page === "dashboard" ? props.view.id : "";
  const dash = useDashboard(id);
  if (props.view.page !== "dashboard") return null;
  const view = props.view;
  if (dash.isPending) {
    return <section className={s.page} aria-busy="true"><p className={s.pageNote}>Loading the dashboard…</p></section>;
  }
  if (dash.isError) {
    if (dash.error.code === "not_found") return <Gone what="dashboard" onHome={() => props.nav.navigate(MONITORING_HOME, "push")} />;
    return (
      <section className={s.page}>
        <p className={s.pageProblem} role="alert">{failure(dash.error, "try again")}</p>
        <button type="button" className={s.retryPage} onClick={() => void dash.refetch()}>Try again</button>
      </section>
    );
  }
  return <DashboardScreen key={view.id} {...props} view={view} dashboard={dash.data} />;
}
