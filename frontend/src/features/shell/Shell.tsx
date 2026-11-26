import { lazy, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { clusterLifecycle } from "../../api/clusterLifecycle";
import { useClusters } from "../../api/useClusters";
import { failure } from "../../api/http";
import { useKinds } from "../../api/useKinds";
import { ActionsProvider } from "../actions/ActionDialog";
import { ViewBoundary } from "./lazyView";
import { focusTableRow } from "../chrome/pageKeys";
import { useKeyboardZone } from "../chrome/useKeyboardZone";
import { AllShortcuts, ShortcutBar } from "../chrome/ShortcutBar";
import { allGroups, isEditable, pageKey, pressed } from "../chrome/shortcuts";
import { TopBar, type ScopeCluster } from "../chrome/TopBar";
import { Dock, type DockHandle } from "../dock/Dock";
import { useDock } from "../dock/useDock";
import { KubernetesTab, type KubernetesTabProps } from "../kubernetes/KubernetesTab";
import { CommandPalette, usePaletteKeys, type PaletteMode } from "../palette/CommandPalette";
import { ForwardsMenu } from "../portforward/ForwardsMenu";
import { forgetClusterForwards, usePortForwards } from "../portforward/usePortForwards";
import { StorageSaveNotices } from "../settings/StorageSaveNotices";
import { APPS, appForKey } from "./apps";
import { useMonitoringNav, usePaneNav, useWorkspaceNav, type WorkspaceNav } from "./browserHistory";
import { Rail } from "./Rail";
import { ShellBridge, type PaletteTarget } from "./ShellBridge";
import { useWorkspace } from "./storage";
import { tabLabel } from "./tabLabel";
import { kindView, type AppId, type KubeView, type Tab } from "./workspace";
import { WorkspaceTabs } from "./WorkspaceTabs";
import type { MonitoringAppProps } from "../../monitoring/MonitoringApp";
import { monitoringLeaveHeld, type MonitoringTabAction } from "../../monitoring/shell/tabState";
import s from "./Shell.module.css";

interface PaneProps extends Omit<KubernetesTabProps, "nav" | "paneActive"> {
  tab: Tab<KubeView>;
  title: string;
  history: WorkspaceNav;
  active: boolean;
  split: boolean;
  onFocusPane(id: string): void;
  zoneActive: boolean;
  reportScope(id: string, scope: ScopeCluster[] | null): void;
  reportTarget(id: string, target: PaletteTarget | null): void;
}

function KubePane({ tab, title, history, active, split, zoneActive, onFocusPane, reportScope, reportTarget, ...props }: PaneProps) {
  const nav = usePaneNav(history, tab);
  const id = tab.id;
  const bridge = useMemo(() => ({
    setScope: (value: ScopeCluster[] | null) => reportScope(id, value),
    setPaletteTarget: (value: PaletteTarget | null) => reportTarget(id, value),
  }), [id, reportScope, reportTarget]);
  const activate = () => { if (!active) onFocusPane(id); };
  return (
    <section
      className={s.pane}
      aria-label={split ? title : undefined}
      data-active-pane={active}
      data-keyboard-zone={zoneActive ? "table" : undefined}
      tabIndex={-1}
      onFocusCapture={activate}
      onPointerDownCapture={activate}
      onContextMenuCapture={activate}
    >
      {split && <div className={s.paneTitle}>{title}</div>}
      <ShellBridge.Provider value={bridge}>
        <KubernetesTab {...props} nav={nav} paneActive={active} />
      </ShellBridge.Provider>
    </section>
  );
}

const AuditView = lazy(() => import("../audit/AuditView").then(m => ({ default: m.AuditView })));
const SettingsView = lazy(() => import("../settings/SettingsView").then(m => ({ default: m.SettingsView })));
/** Monitoring's empty-dock words (a literal here: no Monitoring module joins the initial graph). */
export const MONITORING_DOCK_HINT = "Press ? to see all keys.";
const MonitoringApp = lazy(() => import("../../monitoring/MonitoringApp"));
/** In Monitoring, Ctrl K and the top bar's box go to its Find (MonitoringApp listens; the same literal there). */
const findInMonitoring = () => window.dispatchEvent(new Event("omnikrux:monitoring-find"));
const MONITORING_FIND_BOX = { hint: "projects, dashboards, sources…", label: "Find in Monitoring", prompt: "/", keys: "/ Control+K" };

export function Shell() {
  const client = useQueryClient();
  const { ws, dispatch, loadProblem, saveProblem, dismissLoadProblem } = useWorkspace();
  const { tabs, active: activeId, closed } = ws.kubernetes;
  const active = tabs.find((t) => t.id === activeId)!;
  const history = useWorkspaceNav(ws, dispatch);
  const nav = usePaneNav(history, active, false);
  const monitoringTab = ws.monitoring.tabs.find((t) => t.id === ws.monitoring.active)!;
  const monitoringNav = useMonitoringNav(history, monitoringTab);
  const clusters = useClusters().data ?? [];
  const kindsQuery = useKinds();
  const kinds = kindsQuery.data?.kinds;
  const kindsError = kinds === undefined && kindsQuery.isError ? failure(kindsQuery.error, "retry") : null;
  const dock = useDock(clusters);
  const zone = useKeyboardZone();
  const [settingsSection, setSettingsSection] = useState<"pinned-kinds" | undefined>(undefined);
  const [scope, setScope] = useState<{ id: string; value: ScopeCluster[] } | null>(null);
  const [target, setTarget] = useState<{ id: string; value: PaletteTarget } | null>(null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [help, setHelp] = useState(false);
  const [forwardsAsk, setForwardsAsk] = useState(0);
  const forwards = usePortForwards().query.data?.length ?? 0;
  const main = useRef<HTMLElement>(null);
  const dockRef = useRef<DockHandle>(null);
  const kube = ws.app === "kubernetes";
  const monitoring = ws.app === "monitoring";
  // Outside Kubernetes no view holds a watch. Dock sessions and forwards still learn of a removed
  // cluster from clusterLifecycle: the registry poll (useClusters, every 15 s) and removals made
  // here; the server closes the removed cluster's sockets itself.
  useEffect(() => clusterLifecycle(client).subscribe(id => void forgetClusterForwards(client, id)), [client]);
  const activeScope = kube && scope?.id === activeId ? scope.value : [];
  const activeTarget = kube && target?.id === activeId ? target.value : null;
  const kind = kube && nav.view.page === "kind" ? nav.view.kind : undefined;
  const visible = ws.split ? ws.split.map((id) => tabs.find((tab) => tab.id === id)!) : [active];

  const reportScope = useCallback((id: string, value: ScopeCluster[] | null) => {
    setScope((old) => value ? { id, value } : old?.id === id ? null : old);
  }, []);
  const reportTarget = useCallback((id: string, value: PaletteTarget | null) => {
    setTarget((old) => value ? { id, value } : old?.id === id ? null : old);
  }, []);

  const focusView = useCallback(() => {
    const before = document.activeElement;
    if (isEditable(before)) return;
    requestAnimationFrame(() => {
      const target = document.activeElement;
      // A pane may claim focus as it mounts. Fall back when the prior target was removed.
      if (target === before || target === document.body) main.current?.focus({ preventScroll: true });
    });
  }, []);
  // A page load starts like an app switch: the keyboard goes to the workspace unless a
  // pane claimed it while mounting (a heading, a landing), never staying on <body>.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) main.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const switchApp = useCallback((app: AppId) => {
    setSettingsSection(undefined);
    dispatch({ type: "switchApp", app });
    focusView();
  }, [dispatch, focusView]);
  const focusPane = useCallback((id: string) => dispatch({ type: "activateTab", id }), [dispatch]);
  const activateTab = (id: string) => { focusPane(id); focusView(); };
  const newTab = () => {
    dispatch({ type: "newTab" });
    dispatch({ type: "switchApp", app: "kubernetes" });
    focusView();
  };
  const closeTab = (id = activeId) => {
    dispatch({ type: "closeTab", id });
    if (id === activeId) focusView();
  };
  // Alt+W, the tab strip's close buttons and the app's own tab actions: a way out of a page asks
  // the app's leave check first, and a held action changes nothing (returns true).
  const dispatchMonitoring = useCallback((action: MonitoringTabAction): boolean => {
    if (monitoringLeaveHeld(action)) return true;
    dispatch({ type: "monitoring", action });
    return false;
  }, [dispatch]);
  const openSettings = useCallback(() => switchApp("settings"), [switchApp]);
  const openKubernetes = useCallback(() => switchApp("kubernetes"), [switchApp]);
  const monitoringProps: MonitoringAppProps = {
    tabs: ws.monitoring, nav: monitoringNav, dispatchTabs: dispatchMonitoring, onOpenSettings: openSettings, onOpenKubernetes: openKubernetes,
  };
  const editPinned = useCallback(() => { switchApp("settings"); setSettingsSection("pinned-kinds"); }, [switchApp]);
  const openView = useCallback((view: KubeView, split?: boolean) => {
    dispatch({ type: "newTab", view, split });
    focusView();
  }, [dispatch, focusView]);
  const splitTab = (id: string) => { dispatch({ type: "splitTab", id }); focusView(); };
  const closeSplit = () => { dispatch({ type: "closeSplit" }); focusView(); };
  const onKind = (key: string) => {
    if (activeTarget) activeTarget.onKind(key);
    else {
      dispatch({ type: "switchApp", app: "kubernetes" });
      nav.navigate((v) => kindView(v, key), "push");
      focusView();
    }
  };
  /**
   * Back from the dock to the selected row, else `<main>`. A key press (`now`) lands in this tick, so
   * nothing can take the focus first; a removal waits a frame and yields to whatever claimed it.
   */
  const focusWorkspaceFromDock = useCallback((opts?: { now?: boolean }) => {
    const land = () => {
      if (document.querySelector('[aria-modal="true"]')) return;
      const pane = main.current?.querySelector<HTMLElement>('[data-active-pane="true"]');
      if (pane && focusTableRow(pane, { selectedOnly: true, revealSelected: opts?.now })) return;
      main.current?.focus({ preventScroll: true });
    };
    if (opts?.now) {
      land();
      return;
    }
    const origin = document.activeElement;
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (focused !== origin && focused !== document.body) return;
      land();
    });
  }, []);

  const focusAfterPalette = () => {
    const pane = main.current?.querySelector<HTMLElement>('[data-active-pane="true"]');
    if (pane && kube) {
      if (nav.view.page === "home") {
        const search = pane.querySelector<HTMLInputElement>('[aria-label="Search Kubernetes"]');
        if (search) { search.focus(); return; }
      } else {
        if (focusTableRow(pane)) return;
        const tab = pane.querySelector<HTMLElement>('[aria-label="Kinds"] [role="tab"][aria-selected="true"]');
        if (tab) { tab.focus(); return; }
      }
    }
    main.current?.focus({ preventScroll: true });
  };

  // In Monitoring, Ctrl K is its Find and ":" (kinds) does nothing.
  usePaletteKeys((mode) => {
    if (!monitoring) setPalette(mode);
    else if (mode === "all") findInMonitoring();
  });
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (!pageKey(e)) return;
    const app = appForKey(e);
    if (app) { e.preventDefault(); switchApp(app); return; }
    if (pressed("help", e)) { e.preventDefault(); setHelp(true); return; }
    // Alt+Down: into the logs, from any app (the dock is shared). Held, it moves in once.
    if (pressed("enterLogs", e)) { e.preventDefault(); if (!e.repeat) dockRef.current?.enter(); return; }
    if (monitoring) {
      // Monitoring's own tabs while it is shown; the Kubernetes tabs stay as they are.
      // A held key leaves the keyboard where it is: the app's leave dialog takes it.
      let held: boolean;
      if (pressed("newTab", e)) held = dispatchMonitoring({ type: "newTab" });
      else if (pressed("closeTab", e)) held = dispatchMonitoring({ type: "closeTab", id: ws.monitoring.active });
      else if (pressed("nextTab", e)) held = dispatchMonitoring({ type: "nextTab" });
      else if (pressed("previousTab", e)) held = dispatchMonitoring({ type: "previousTab" });
      else if (pressed("back", e)) held = history.stepMonitoring(ws.monitoring.active, "back");
      else if (pressed("forward", e)) held = history.stepMonitoring(ws.monitoring.active, "forward");
      else return;
      e.preventDefault();
      if (!held) focusView();
      return;
    }
    if (!kube) return;
    if (pressed("newTab", e)) newTab();
    else if (pressed("closeTab", e)) closeTab();
    else if (pressed("nextTab", e) || pressed("previousTab", e)) {
      dispatch({ type: pressed("nextTab", e) ? "nextTab" : "previousTab" });
      focusView();
    } else if (pressed("back", e)) nav.back();
    else if (pressed("forward", e)) nav.forward();
    else return;
    e.preventDefault();
  });
  useEffect(() => {
    const handle = (e: KeyboardEvent) => onKey(e);
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, []);

  return (
    <ActionsProvider>
      <div className={s.shell}>
        <Rail app={ws.app} onSelect={switchApp} />
        <div className={s.content}>
          <TopBar appName={APPS.find((a) => a.id === ws.app)?.title} clusters={activeScope}
            nav={kube ? nav : monitoring ? monitoringNav : undefined} forwards={<ForwardsMenu openRequest={forwardsAsk} />}
            onPalette={monitoring ? findInMonitoring : () => setPalette("all")} {...(monitoring && MONITORING_FIND_BOX)} />
          {!monitoring && <WorkspaceTabs app={ws.app} tabs={tabs} active={activeId} clusters={clusters} kinds={kinds}
            onActivate={activateTab} onClose={closeTab} onNew={newTab} onEditPinned={editPinned} onSplit={splitTab}
            onOpenSplit={view => openView(view, true)} split={ws.split} />}
          {ws.app !== "settings" && <StorageSaveNotices workspaceProblem={saveProblem} className={s.saveProblem} />}
          <main ref={main} className={s.main} tabIndex={-1} data-page-keys>
            {kube ? (
              <>
                {ws.split && <div className={s.splitTools}><button type="button" onClick={closeSplit}>Close split</button></div>}
                <div className={ws.split ? s.split : s.single}>
                  {visible.map((tab) => (
                    <KubePane key={tab.id} tab={tab} title={tabLabel(tab.view, { clusters, kinds })} history={history}
                      active={tab.id === activeId} zoneActive={zone === "table" && tab.id === activeId && tab.view.page === "kind"} split={ws.split !== undefined} onFocusPane={focusPane}
                      reportScope={reportScope} reportTarget={reportTarget}
                      dock={dock} closed={closed} onReopen={(index) => dispatch({ type: "reopenClosed", index })}
                      loadProblem={loadProblem} onDismissLoadProblem={dismissLoadProblem} onEditPinned={editPinned} onOpenView={openView} />
                  ))}
                </div>
              </>
            ) : monitoring ? (
              <ViewBoundary key="monitoring" label="Monitoring">
                <MonitoringApp {...monitoringProps} />
              </ViewBoundary>
            ) : ws.app === "audit" ? (
              <ViewBoundary key="audit" label="the audit log">
                <AuditView filters={ws.audit.filters} onFilters={(filters) => dispatch({ type: "auditFilters", filters })} />
              </ViewBoundary>
            ) : (
              <ViewBoundary key="settings" label="settings">
                <SettingsView kinds={kinds} saveProblem={saveProblem} section={settingsSection} />
              </ViewBoundary>
            )}
          </main>
          {/* A shell is in the dock: the dock keeps its outline, the bar says how to leave the terminal. */}
          <Dock ref={dockRef} dock={dock} zoneActive={zone === "logs" || zone === "shell"} emptyHint={monitoring ? MONITORING_DOCK_HINT : undefined} onFocusWorkspace={focusWorkspaceFromDock} />
          {(kind || zone === "logs" || zone === "shell") && <ShortcutBar kind={kind} zone={zone ?? "table"} onOpen={() => setHelp(true)} />}
        </div>
      </div>
      {help && <AllShortcuts groups={allGroups(kind, ws.app)} onClose={() => setHelp(false)} />}
      {palette && <CommandPalette mode={palette} kinds={kinds} kindsError={kindsError}
        selection={activeTarget?.selection ?? null} onKind={onKind} onRowAction={activeTarget?.onRowAction ?? (() => {})}
        onAudit={() => switchApp("audit")} onSettings={() => switchApp("settings")} onNewTab={newTab}
        onCloseTab={kube ? () => closeTab() : undefined} onForwards={forwards ? () => setForwardsAsk((n) => n + 1) : undefined}
        onClose={() => setPalette(null)} onFocusLost={focusAfterPalette} />}
    </ActionsProvider>
  );
}
