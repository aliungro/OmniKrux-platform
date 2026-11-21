import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ComponentType } from "react";
import { useClusters } from "../api/useClusters";
import type { TabNav } from "../features/shell/browserHistory";
import type { AppTabs } from "../features/shell/workspace";
import { useMonitoringTree, useSources } from "./api/hooks";
import type { SourceOut, TreeOut } from "./api/types";
import { focusMainFrom } from "./focus";
import { recordRecent } from "./home/recent";
import GroupForm from "./groups/GroupForm";
import GroupPage from "./groups/GroupPage";
import MonitoringHome from "./home/MonitoringHome";
import { ALERTS_LATER, ComingLater, EXPLORE_LATER } from "./pages/ComingLater";
import ProjectPage from "./projects/ProjectPage";
import SourcesPage, { SourcePage } from "./sources/SourcesPage";
import SetupPage from "./setup/SetupPage";
import { buildSearchIndex } from "./search/search";
import { MonitoringTabs } from "./shell/MonitoringTabs";
import { MONITORING_HOME, monitoringTabLabel, type MonitoringTabAction, type MonitoringView } from "./shell/tabState";
import { DOT, Sidebar } from "./sidebar/Sidebar";
import s from "./MonitoringApp.module.css";

/** What the shell hands the Monitoring app. The shell imports this type only, so this module stays lazy. */
export interface MonitoringAppProps {
  tabs: AppTabs<MonitoringView>;
  nav: TabNav<MonitoringView>;
  dispatchTabs(action: MonitoringTabAction): void;
  onOpenSettings(): void;
  onOpenKubernetes(): void;
}

/** What every page gets: its view, the active tab's navigation, and a way to open a new tab. */
export interface MonitoringPageProps {
  view: MonitoringView;
  nav: TabNav<MonitoringView>;
  openInNewTab(view: MonitoringView): void;
  onOpenSettings(): void;
}

type Page = MonitoringView["page"];

const later = (name: string, text?: string): ComponentType<MonitoringPageProps> => {
  const Later = () => <ComingLater name={name} text={text} />;
  Later.displayName = `ComingLater(${name})`;
  return Later;
};

/**
 * Every page by `view.page`. A page that hasn't been built yet renders `ComingLater` with its name;
 * each later task replaces its entry (M2 adds `dashboard`).
 */
const PAGES: Record<Page, ComponentType<MonitoringPageProps>> = {
  home: MonitoringHome,
  sources: SourcesPage,
  source: SourcePage,
  setup: SetupPage,
  project: ProjectPage,
  group: GroupPage,
  newGroup: GroupForm,
  explore: later("Explore", EXPLORE_LATER),
  alerts: later("Alerts", ALERTS_LATER),
  dashboard: later("Dashboard"),
};

/** Opening a project or group (in this tab or a new one) puts it first in Recently opened. */
function recordOpened(view: MonitoringView) {
  if (view.page === "project" || view.page === "group") recordRecent({ kind: view.page, id: view.id });
}

/**
 * Whether a page may take the keyboard as it appears: only when nothing else has it (`<body>`,
 * the workspace's `<main>`, or the page area). Typing in Find or moving in the tree keeps it.
 */
function keyboardIsFree(): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || active.tagName === "MAIN") return true;
  return active.closest("[data-monitoring-page]") !== null;
}

function Gone({ what, onHome }: { what: "project" | "group" | "source"; onHome(): void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (keyboardIsFree()) button.current?.focus(); }, []);
  return (
    <section className={s.gone}>
      <p className={s.goneText}>This {what} no longer exists.</p>
      <button ref={button} type="button" className={s.primary} onClick={onHome}>Go to Home</button>
    </section>
  );
}

/** Whether the item a view names is known to be gone: only once the list it belongs to has loaded. */
function goneKind(view: MonitoringView, tree: TreeOut | undefined, sources: SourceOut[] | undefined): "project" | "group" | "source" | null {
  if (view.page === "project" && tree && !tree.projects.some((p) => p.id === view.id)) return "project";
  if (view.page === "group" && tree && !tree.groups.some((g) => g.id === view.id)) return "group";
  if (view.page === "source" && sources && !sources.some((x) => x.id === view.id)) return "source";
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
  return <Component {...page} />;
}

export default function MonitoringApp({ tabs, nav, dispatchTabs, onOpenSettings }: MonitoringAppProps) {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tree = useMonitoringTree();
  const sources = useSources();
  const clusters = useClusters().data;
  const view = nav.view;

  const clusterNames = useMemo(() => Object.fromEntries((clusters ?? []).map((c) => [c.id, c.name])), [clusters]);
  const index = useMemo(
    () => (tree.data ? buildSearchIndex({ tree: tree.data, sources: sources.data ?? [], clusterNames }) : []),
    [tree.data, sources.data, clusterNames],
  );
  const names = useMemo(() => {
    const projects = new Map(tree.data?.projects.map((p) => [p.id, p]));
    const groups = new Map(tree.data?.groups.map((g) => [g.id, g.name]));
    const sourceNames = new Map(sources.data?.map((x) => [x.id, x.name]));
    return {
      label: (v: MonitoringView) => monitoringTabLabel(v, {
        project: (id) => projects.get(id)?.name, group: (id) => groups.get(id), source: (id) => sourceNames.get(id),
      }),
      color: (v: MonitoringView) => {
        const p = v.page === "project" ? projects.get(v.id) : undefined;
        return p ? DOT[p.color] : "var(--focus)";
      },
    };
  }, [tree.data, sources.data]);

  // A page about to be replaced takes the keyboard with it: hand it to the workspace first, so it
  // never falls to <body>. The tree and Find keep their own focus.
  const handOff = useCallback(() => {
    const active = document.activeElement;
    if (active === null || active === document.body || scroller.current?.contains(active)) focusMainFrom(root.current);
  }, []);
  const openInNewTab = useCallback((v: MonitoringView) => {
    handOff();
    dispatchTabs({ type: "newTab", view: v });
    recordOpened(v);
  }, [dispatchTabs, handOff]);
  // The tab's navigation as pages see it: going to a project or group records it as opened.
  // Back, Forward, switching tabs and reloading show a page without opening it again.
  const pageNav = useMemo<TabNav<MonitoringView>>(() => ({
    ...nav,
    navigate: (move, mode) => {
      handOff();
      nav.navigate(move, mode);
      recordOpened(typeof move === "function" ? move(nav.view) : move);
    },
  }), [nav, handOff]);
  const open = useCallback((v: MonitoringView, newTab: boolean) => {
    if (newTab) openInNewTab(v);
    else pageNav.navigate(v, "push");
  }, [pageNav, openInNewTab]);
  const leave = useCallback(() => focusMainFrom(root.current), []);
  const goHome = useCallback(() => {
    focusMainFrom(root.current);
    nav.navigate(MONITORING_HOME, "push");
  }, [nav]);

  // Each tab keeps where its page was scrolled.
  const tabId = tabs.active;
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = nav.scrollTop;
    // Only when the tab changes; scrolling itself updates nav.scrollTop.
  }, [tabId]);

  const page: MonitoringPageProps = { view, nav: pageNav, openInNewTab, onOpenSettings };
  return (
    <div ref={root} className={s.app}>
      <Sidebar view={view} tree={tree.data} treeFailed={tree.isError && !tree.data} onRetry={() => void tree.refetch()}
        index={index} onOpen={open} onLeave={leave} />
      <div className={s.work}>
        <MonitoringTabs tabs={tabs} labelFor={names.label} colorFor={names.color}
          onActivate={(id) => dispatchTabs({ type: "activateTab", id })}
          onClose={(id) => dispatchTabs({ type: "closeTab", id })}
          onNew={() => dispatchTabs({ type: "newTab" })} />
        <div ref={scroller} className={s.page} data-monitoring-page onScroll={(e) => nav.setScroll(e.currentTarget.scrollTop)}>
          <PageView key={tabId} page={page} onHome={goHome}
            tree={{ data: tree.data, fetching: tree.isFetching }} sources={{ data: sources.data, fetching: sources.isFetching }} />
        </div>
      </div>
    </div>
  );
}
