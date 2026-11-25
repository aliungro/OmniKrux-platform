import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useClusters } from "../api/useClusters";
import type { TabNav } from "../features/shell/browserHistory";
import type { AppTabs } from "../features/shell/workspace";
import { useMonitoringTree, useSources } from "./api/hooks";
import type { SourceOut, TreeOut } from "./api/types";
import { pageKey, pressed } from "../features/chrome/shortcuts";
import { focusMainFrom } from "./focus";
import { readRecent, recordRecent } from "./home/recent";
import GroupForm from "./groups/GroupForm";
import GroupPage from "./groups/GroupPage";
import MonitoringHome from "./home/MonitoringHome";
import DashboardPage from "./dashboards/page/DashboardPage";
import { draftsWork, removeDraft } from "./dashboards/drafts/draftStore";
import { heldLeave } from "./dashboards/drafts/leaveGuard";
import { LeaveDialog } from "./dashboards/drafts/LeaveDialog";
import { forgetSession, keepNow } from "./dashboards/drafts/useDraft";
import { editSessions } from "./dashboards/editor/useDashboardEditor";
import { openMade, settleHeadingFocus } from "./dashboards/create/arrival";
import { currentOwner, type Owner } from "./dashboards/create/currentOwner";
import { NewDashboardDialog } from "./dashboards/create/NewDashboardDialog";
import { pageLetter } from "./dashboards/page/keys";
import { ToolReviewHost } from "./alerts/reviews/ToolReviewHost";
import { InstallReviewHost } from "./install/InstallReviewHost";
import {
  alertFormMarks, clearAlertForms, endRuleForm, FORM_LEAVE_BODY, heldFormLeave, heldRuleLeave, markAlertForm, pruneRuleForms, RULE_LEAVE_BODY,
  SETUP_LEAVE_BODY, SETUP_MARK,
} from "./alerts/rules/formSessions";
import { Gone, type GoneWhat } from "./pages/Gone";
import ProjectPage from "./projects/ProjectPage";
import SourcesPage, { SourcePage } from "./sources/SourcesPage";
import SetupPage from "./setup/SetupPage";
import { buildSearchIndex } from "./search/search";
import { pruneSetupDrafts, removeSetupDraft, setupDraftChosen } from "./setup/setupDraftStore";
import { MonitoringTabs } from "./shell/MonitoringTabs";
import {
  equalMonitoringView, MONITORING_HOME, monitoringTabLabel, setMonitoringLeaveCheck, setMonitoringSwitchCheck, type MonitoringTabAction,
  type MonitoringView,
} from "./shell/tabState";
import { DOT, Sidebar } from "./sidebar/Sidebar";
import s from "./MonitoringApp.module.css";

/** What the shell hands the Monitoring app. The shell imports this type only, so this module stays lazy. */
export interface MonitoringAppProps {
  tabs: AppTabs<MonitoringView>;
  nav: TabNav<MonitoringView>;
  /** True when the action was held: the app's leave check asks first and performs it itself. */
  dispatchTabs(action: MonitoringTabAction): boolean | void;
  onOpenSettings(): void;
  onOpenKubernetes(): void;
}

/** What every page gets: its view, the active tab's navigation, and a way to open a new tab. */
export interface MonitoringPageProps {
  view: MonitoringView;
  /** The workspace tab this page is shown in (an edit session is kept per tab). */
  tabId: string;
  nav: TabNav<MonitoringView>;
  openInNewTab(view: MonitoringView): void;
  /** Shows another workspace tab (the one editing this dashboard). */
  activateTab(id: string): void;
  onOpenSettings(): void;
  /**
   * Replaces the view of tab `tabId` (not the active one) with `view`, only while that tab still
   * shows `expected`. For a page that leaves with a view change still waiting (Explore's last keys).
   */
  replaceTabView?(tabId: string, view: MonitoringView, expected: MonitoringView): void;
  /**
   * The page's item was deleted from this tab: the tab shows Home, or closes when another tab
   * shows Home already (that one becomes active).
   */
  leaveDeleted?(): void;
}

/** Ctrl K and the top bar's box in Monitoring (Shell sends it; the same literal there). */
const MONITORING_FIND_EVENT = "omnikrux:monitoring-find";

type Page = MonitoringView["page"];

/** Explore, Alerts and the Monitoring tools are their own chunks: each loads when a tab first shows it. */
const ExplorePage = lazy(() => import("./explore/ExplorePage"));
const AlertsPage = lazy(() => import("./alerts/page/AlertsPage"));
const ToolsPage = lazy(() => import("./install/ToolsPage"));
const ImportPage = lazy(() => import("./transfer/ImportPage"));

/**
 * Every page by `view.page`.
 */
const PAGES: Record<Page, ComponentType<MonitoringPageProps>> = {
  home: MonitoringHome,
  sources: SourcesPage,
  source: SourcePage,
  setup: SetupPage,
  project: ProjectPage,
  group: GroupPage,
  newGroup: GroupForm,
  explore: ExplorePage,
  alerts: AlertsPage,
  dashboard: DashboardPage,
  tools: ToolsPage,
  import: ImportPage,
};

/** Opening a project, group or dashboard (in this tab or a new one) puts it first in Recently opened. */
function recordOpened(view: MonitoringView) {
  if (view.page === "project" || view.page === "group" || view.page === "dashboard") recordRecent({ kind: view.page, id: view.id });
}

/**
 * The same page about the same item: a replace that only changes its view state (time, variables,
 * tab). Explore and Alerts have no item: every replace on them is their own view write (Explore's
 * project, source, query and time; the Alerts tab and the selected rule).
 */
function samePageAndItem(a: MonitoringView, b: MonitoringView): boolean {
  return a.page === b.page && (a.page === "explore" || a.page === "alerts" || ("id" in a && "id" in b && a.id === b.id));
}

/** Whether a dashboard is listed in the tree, under its project (saved or ready-made) or its group. */
function listsDashboard(tree: TreeOut, id: string): boolean {
  return tree.projects.some((p) => p.dashboards.some((d) => d.id === id)) || tree.groups.some((g) => g.dashboards.some((d) => d.id === id));
}

/** Whether the item a view names is known to be gone: only once the list it belongs to has loaded. */
function goneKind(view: MonitoringView, tree: TreeOut | undefined, sources: SourceOut[] | undefined): GoneWhat | null {
  if (view.page === "project" && tree && !tree.projects.some((p) => p.id === view.id)) return "project";
  if (view.page === "group" && tree && !tree.groups.some((g) => g.id === view.id)) return "group";
  if (view.page === "source" && sources && !sources.some((x) => x.id === view.id)) return "source";
  if (view.page === "dashboard" && tree && !listsDashboard(tree, view.id)) return "dashboard";
  return null;
}

/** A list as PageView reads it: its data, and whether a newer copy is on its way. */
interface Listed<T> { data: T | undefined; fetching: boolean }

/** Renders the page for a view, after checking that what it names still exists. */
function PageView({ page, tree, sources, onHome }: { page: MonitoringPageProps; tree: Listed<TreeOut>; sources: Listed<SourceOut[]>; onHome(): void }) {
  const { view } = page;
  const id = "id" in view ? view.id : null;
  const key = `${view.page}:${id}`;
  // A list being read again may be about to name something just made: it isn't called gone until
  // that answer is in. Once a view is shown as gone, a later re-read doesn't take that back early.
  const shownGone = useRef<string | null>(null);
  let gone = goneKind(view, tree.data, sources.data);
  const fetching = view.page === "source" ? sources.fetching : tree.fetching;
  if (gone && fetching && shownGone.current !== key) gone = null;
  shownGone.current = gone ? key : null;
  if (gone) return <Gone key={key} what={gone} onHome={onHome} />;
  const Component = PAGES[view.page];
  // A page in its own chunk says it is on its way; the keyboard stays where it is meanwhile.
  return (
    <Suspense fallback={<p className={s.loadingPage} role="status">Loading…</p>}>
      <Component {...page} />
    </Suspense>
  );
}

/** A way out held by the leave check: the dialog's question, and how to go on when it's answered. */
interface Leaving {
  tabId: string;
  dashboardId: string;
  title: string;
  draftsWork: boolean;
  /** Performs the held action again, through the same path. */
  proceed(): void;
  /** Where the keyboard was: Stay returns it there. */
  from: HTMLElement | null;
  /** An alert rule being written, not a dashboard: no draft is kept, Discard ends the form. */
  rule?: boolean;
  /** A Silences or Contact points form: no draft is kept, Discard lets the page take it away. */
  form?: boolean;
  /** What leaving loses, when it isn't a dashboard's draft. */
  body?: string;
  /** Closing a tab with a setup started in it: Discard drops the tab's setup draft too. */
  setupDraft?: boolean;
}

/**
 * A tab that is gone takes its edit session with it (closed without changes, or dropped). Run as the
 * app renders, before its pages read the sessions; it only ever removes, so running again is harmless.
 */
function pruneSessions(tabs: AppTabs<MonitoringView>) {
  if (editSessions.size === 0) return;
  const ids = new Set(tabs.tabs.map((t) => t.id));
  for (const id of [...editSessions.keys()]) {
    if (ids.has(id)) continue;
    editSessions.delete(id);
    forgetSession(id);
  }
}

export default function MonitoringApp({ tabs, nav, dispatchTabs, onOpenSettings }: MonitoringAppProps) {
  pruneSessions(tabs);
  pruneRuleForms(tabs);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tree = useMonitoringTree();
  const sources = useSources();
  const clusters = useClusters().data;
  const view = nav.view;
  // A heading the page after a delete never took is dropped as the tab moves on.
  useEffect(() => { settleHeadingFocus(view); }, [view]);
  // A closed tab's setup draft goes with it.
  const tabIds = JSON.stringify(tabs.tabs.map((t) => t.id));
  useEffect(() => { pruneSetupDrafts(JSON.parse(tabIds) as string[]); }, [tabIds]);
  // After a reload, a tab not showing its setup still keeps the draft: it is marked from storage,
  // so closing it asks as it did before. A setup page on screen marks its own tab.
  useEffect(() => {
    const { tabs: t } = latest.current;
    for (const tab of t.tabs) {
      if (tab.id === t.active && tab.view.page === "setup") continue;
      if (!alertFormMarks.get(tab.id)?.has("setup") && setupDraftChosen(tab.id)) markAlertForm(tab.id, "setup", SETUP_MARK);
    }
  }, []);

  const clusterNames = useMemo(() => Object.fromEntries((clusters ?? []).map((c) => [c.id, c.name])), [clusters]);
  const index = useMemo(
    () => (tree.data ? buildSearchIndex({ tree: tree.data, sources: sources.data ?? [], clusterNames, pages: true }) : []),
    [tree.data, sources.data, clusterNames],
  );
  const names = useMemo(() => {
    const projects = new Map(tree.data?.projects.map((p) => [p.id, p]));
    const groups = new Map(tree.data?.groups.map((g) => [g.id, g.name]));
    const sourceNames = new Map(sources.data?.map((x) => [x.id, x.name]));
    const dashboards = new Map([...(tree.data?.projects ?? []), ...(tree.data?.groups ?? [])].flatMap((o) => o.dashboards.map((d) => [d.id, d.title])));
    return {
      label: (v: MonitoringView) => monitoringTabLabel(v, {
        project: (id) => projects.get(id)?.name, group: (id) => groups.get(id), source: (id) => sourceNames.get(id),
        dashboard: (id) => dashboards.get(id), cluster: (id) => (Object.hasOwn(clusterNames, id) ? clusterNames[id] : undefined),
      }),
      color: (v: MonitoringView) => {
        const p = v.page === "project" ? projects.get(v.id) : undefined;
        return p ? DOT[p.color] : "var(--focus)";
      },
    };
  }, [tree.data, sources.data, clusterNames]);

  // A page about to be replaced takes the keyboard with it: hand it to the workspace first, so it
  // never falls to <body>. The tree and Find keep their own focus.
  const handOff = useCallback(() => {
    const active = document.activeElement;
    if (active === null || active === document.body || scroller.current?.contains(active)) focusMainFrom(root.current);
  }, []);

  // --- leaving a dashboard with unsaved changes -------------------------------------------------
  // Every way out of a tab (the shell's keys and tab strip, the top bar, and this app's own
  // navigations) asks first; a held action changes nothing until the dialog is answered.
  const latest = useRef({ tabs, nav, dispatchTabs });
  latest.current = { tabs, nav, dispatchTabs };
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const asking = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const ask = useCallback((action: MonitoringTabAction, proceed: () => void): boolean => {
    const held = heldLeave(action, latest.current.tabs, editSessions);
    // An alert rule being written with changes holds its tab the same way.
    const rule = held ? null : heldRuleLeave(action, latest.current.tabs);
    // So does a Silences or Contact points form with changes (switching tabs included).
    const form = held || rule ? null : heldFormLeave(action, latest.current.tabs);
    if (!held && !rule && !form) return false;
    // Already asking: the first question stands.
    if (asking.current) return true;
    asking.current = true;
    returnFocus.current = null;
    const active = document.activeElement;
    if (rule) {
      setLeaving({
        tabId: rule.tabId, dashboardId: "", title: rule.title, draftsWork: false, rule: true, body: RULE_LEAVE_BODY, proceed,
        from: active instanceof HTMLElement && active !== document.body ? active : null,
      });
      return true;
    }
    if (form) {
      // A setup started in the tab holds only its closing. Closing it loses the whole setup (a form
      // open in it included), so the question names that, whichever mark was found.
      const setup = action.type === "closeTab" ? [...(alertFormMarks.get(form.tabId)?.values() ?? [])].find((m) => m.closeOnly) : undefined;
      setLeaving({
        tabId: form.tabId, dashboardId: "", title: setup?.title ?? form.title, draftsWork: false, form: true, proceed, setupDraft: setup !== undefined,
        body: setup ? SETUP_LEAVE_BODY : FORM_LEAVE_BODY,
        from: active instanceof HTMLElement && active !== document.body ? active : null,
      });
      return true;
    }
    if (!held) return false;
    const session = editSessions.get(held.tabId);
    setLeaving({
      ...held, proceed, draftsWork: draftsWork(),
      title: (session?.mode === "edit" && session.base.title) || "this dashboard",
      from: active instanceof HTMLElement && active !== document.body ? active : null,
    });
    return true;
  }, []);

  const pageNavRef = useRef<TabNav<MonitoringView> | null>(null);
  useEffect(() => {
    // Held by the shell: performed again through the path it came by, no longer held.
    const again = (action: MonitoringTabAction) => () => {
      const { tabs: t, nav: n, dispatchTabs: d } = latest.current;
      if (action.type === "navigate" && action.id === t.active && pageNavRef.current) pageNavRef.current.navigate(action.view, action.mode);
      else if ((action.type === "back" || action.type === "forward") && action.id === t.active) n[action.type]();
      else d(action);
    };
    setMonitoringLeaveCheck((action) => ask(action, again(action)));
    setMonitoringSwitchCheck((action) => ask(action, again(action)));
    return () => {
      setMonitoringLeaveCheck(null);
      setMonitoringSwitchCheck(null);
    };
  }, [ask]);

  const answer = useCallback((how: "stay" | "discard" | "keep") => {
    const l = leaving;
    if (!l) return;
    if (how === "stay") {
      returnFocus.current = l.from?.isConnected ? l.from : (root.current?.closest("main") ?? null);
      asking.current = false;
      setLeaving(null);
      return;
    }
    if (l.rule || l.form) {
      // The form ends first, so the action goes through when performed again.
      if (l.rule) endRuleForm(l.tabId);
      else clearAlertForms(l.tabId);
      if (l.setupDraft) removeSetupDraft(l.tabId);
      returnFocus.current = root.current?.closest("main") ?? null;
      focusMainFrom(root.current);
      asking.current = false;
      setLeaving(null);
      l.proceed();
      return;
    }
    const session = editSessions.get(l.tabId);
    if (how === "keep" && session?.mode === "edit" && !keepNow(l.tabId, session)) {
      // Storage refused the draft just now: say leaving loses the changes, and stay.
      setLeaving({ ...l, draftsWork: false });
      return;
    }
    // Only this session's draft: another tab's or window's stays.
    if (how === "discard" && session?.mode === "edit") removeDraft(l.dashboardId, session.writer);
    // The session ends first, so the action goes through when performed again.
    editSessions.delete(l.tabId);
    forgetSession(l.tabId);
    returnFocus.current = root.current?.closest("main") ?? null;
    focusMainFrom(root.current);
    asking.current = false;
    setLeaving(null);
    l.proceed();
  }, [leaving]);


  const activateTab = useCallback((id: string) => {
    handOff();
    dispatchTabs({ type: "activateTab", id });
  }, [dispatchTabs, handOff]);

  const openInNewTab = useCallback((v: MonitoringView) => {
    handOff();
    dispatchTabs({ type: "newTab", view: v });
    recordOpened(v);
  }, [dispatchTabs, handOff]);
  // The tab's navigation as pages see it: going to a project, group or dashboard records it as
  // opened. Back, Forward, switching tabs and reloading show a page without opening it again. A
  // replace that keeps the page and its item (a dashboard's time, variables or tab) changes only
  // view state: the page stays, so the keyboard stays where it is and nothing is opened again.
  // Leaving a page with unsaved changes asks first: held, nothing moves and nothing is recorded.
  const tabId = tabs.active;
  const pageNav = useMemo<TabNav<MonitoringView>>(() => ({
    ...nav,
    navigate: (move, mode) => {
      const next = typeof move === "function" ? move(nav.view) : move;
      const stays = mode === "replace" && samePageAndItem(nav.view, next);
      if (!stays && ask({ type: "navigate", id: tabId, view: next, mode }, () => pageNavRef.current?.navigate(next, mode))) return;
      if (!stays) handOff();
      nav.navigate(next, mode);
      if (!stays) recordOpened(next);
    },
  }), [nav, handOff, ask, tabId]);
  pageNavRef.current = pageNav;
  const open = useCallback((v: MonitoringView, newTab: boolean) => {
    if (newTab) openInNewTab(v);
    else pageNav.navigate(v, "push");
  }, [pageNav, openInNewTab]);
  const leave = useCallback(() => focusMainFrom(root.current), []);

  // --- New dashboard: the L1 bar, N, and the current project's or group's + in the tree --------
  // `view` changes whenever something is opened (and Recently opened with it), so the owner follows.
  const owner = useMemo(() => (tree.data ? currentOwner(view, tree.data, readRecent()) : null), [view, tree.data]);
  const canCreate = (tree.data?.projects.length ?? 0) > 0;
  const [creating, setCreating] = useState<{ owner: Owner | null } | null>(null);
  const createFrom = useRef<HTMLElement | null>(null);
  const newDashboard = useCallback((o: Owner | null, from: HTMLElement | null) => {
    createFrom.current = from ?? root.current?.closest("main") ?? null;
    setCreating({ owner: o });
  }, []);
  // N anywhere in Monitoring, outside a field, a dialog, a menu or edit mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pressed("monitoringNewDashboard", e) || !pageLetter(e)) return;
      if (editSessions.get(latest.current.tabs.active)?.mode === "edit" || creating || !canCreate) return;
      e.preventDefault();
      if (e.repeat) return;
      const active = document.activeElement;
      newDashboard(owner, active instanceof HTMLElement && active !== document.body ? active : null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [owner, canCreate, creating, newDashboard]);
  // I anywhere in Monitoring, outside a field, a dialog, a menu or edit mode: Import, for the current project or group.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pressed("monitoringImport", e) || !pageLetter(e)) return;
      if (editSessions.get(latest.current.tabs.active)?.mode === "edit" || creating) return;
      e.preventDefault();
      if (e.repeat) return;
      pageNav.navigate({ page: "import", ...(owner ? { target: { kind: owner.kind, id: owner.id } } : {}) }, "push");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [owner, pageNav, creating]);
  const goHome = useCallback(() => pageNav.navigate(MONITORING_HOME, "push"), [pageNav]);

  // --- Find: "/", Ctrl K and the top bar's box (MONITORING_FIND_EVENT) -------------------------
  const findInput = useRef<HTMLInputElement>(null);
  // The one way to Find. T22's folded sidebar drawer opens here first, before the field takes the keyboard.
  const openFind = useCallback(() => {
    findInput.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pressed("monitoringFind", e) || !pageKey(e)) return;
      e.preventDefault();
      openFind();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener(MONITORING_FIND_EVENT, openFind);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(MONITORING_FIND_EVENT, openFind);
    };
  }, [openFind]);

  // A project deleted from its own tab: Home takes the tab's place, unless a Home tab is open already.
  const leaveDeleted = useCallback(() => {
    const { tabs: t, dispatchTabs: d } = latest.current;
    const from = t.active;
    const home = t.tabs.find((x) => x.id !== from && x.view.page === "home");
    if (!home) {
      pageNavRef.current?.navigate(MONITORING_HOME, "replace");
      return;
    }
    // What was open about the deleted item has nothing left to hold the tab for.
    clearAlertForms(from);
    handOff();
    if (d({ type: "activateTab", id: home.id }) !== true) d({ type: "closeTab", id: from });
  }, [handOff]);

  // Each tab keeps where its page was scrolled.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = nav.scrollTop;
    // Only when the tab changes; scrolling itself updates nav.scrollTop.
  }, [tabId]);

  const replaceTabView = useCallback((id: string, next: MonitoringView, expected: MonitoringView) => {
    const tab = latest.current.tabs.tabs.find((t) => t.id === id);
    if (!tab || !equalMonitoringView(tab.view, expected)) return;
    latest.current.dispatchTabs({ type: "navigate", id, view: next, mode: "replace" });
  }, []);
  const page: MonitoringPageProps = { view, tabId, nav: pageNav, openInNewTab, activateTab, onOpenSettings, replaceTabView, leaveDeleted };
  return (
    <div ref={root} className={s.app}>
      {/* Install, uninstall and contact-point reviews, one at a time; around the tool review queue,
          which hands it the contact points' review (F21). */}
      <InstallReviewHost place={`${tabs.active}:${view.page}`}>
      {/* Cluster reviews of tool-run alert rules, one at a time, for every page of the app. */}
      <ToolReviewHost place={`${tabs.active}:${view.page}`}>
        <Sidebar view={view} tree={tree.data} treeFailed={tree.isError && !tree.data} onRetry={() => void tree.refetch()}
          index={index} onOpen={open} onLeave={leave} owner={owner} onNewDashboard={newDashboard} findInput={findInput} />
        <div className={s.work}>
          <MonitoringTabs tabs={tabs} labelFor={names.label} colorFor={names.color}
            onActivate={(id) => dispatchTabs({ type: "activateTab", id })}
            onClose={(id) => dispatchTabs({ type: "closeTab", id }) === true}
            onNew={() => dispatchTabs({ type: "newTab" })} />
          <div ref={scroller} className={s.page} data-monitoring-page data-monitoring-tab={tabId} onScroll={(e) => nav.setScroll(e.currentTarget.scrollTop)}>
            <PageView key={tabId} page={page} onHome={goHome}
              tree={{ data: tree.data, fetching: tree.isFetching }} sources={{ data: sources.data, fetching: sources.isFetching }} />
          </div>
        </div>
        {creating && (
          <NewDashboardDialog owner={creating.owner} restoreFocusTo={createFrom} onCancel={() => setCreating(null)}
            onCreated={(out) => { setCreating(null); openMade(out, { edit: true }, { tabId, nav: pageNav, openInNewTab }); }} />
        )}
        {leaving && (
          <LeaveDialog title={leaving.title} draftsWork={leaving.draftsWork} restoreFocusTo={returnFocus}
            body={leaving.body}
            onStay={() => answer("stay")} onDiscard={() => answer("discard")} onKeep={() => answer("keep")} />
        )}
      </ToolReviewHost>
      </InstallReviewHost>
    </div>
  );
}
