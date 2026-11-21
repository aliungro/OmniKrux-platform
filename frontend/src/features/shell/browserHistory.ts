import { useCallback, useEffect, useMemo, useRef } from "react";
import { hashFor, parseHash } from "../../route";
import { equalMonitoringView, monitoringLeaveHeld, sameMonitoringView, type MonitoringView } from "../../monitoring/shell/tabState";
import { kindView, sameView, workspaceReducer, type KubeView, type Tab, type Workspace, type WorkspaceAction } from "./workspace";

type Move<V> = V | ((view: V) => V);
type Mode = "push" | "replace";
type Direction = "back" | "forward";

export interface TabNav<V> {
  view: V;
  navigate(view: Move<V>, mode: Mode): void;
  back(): void;
  forward(): void;
  canBack: boolean;
  canForward: boolean;
  setScroll(top: number): void;
  scrollTop: number;
}

/**
 * Browsers rate-limit history writes (WebKit throws, Chromium drops them), so a refused write
 * leaves the in-app history as the only history rather than breaking navigation.
 */
function write(kind: "pushState" | "replaceState", entry: number, hash: string): void {
  try {
    history[kind]({ omnikrux: entry }, "", hash);
  } catch {
    // Throttled: the browser's Back and Forward lag behind until the next write lands.
  }
}

export function useWorkspaceNav(ws: Workspace, dispatch: (action: WorkspaceAction) => void) {
  const current = useRef(ws);
  current.current = ws;
  const seq = useRef(Number.isFinite(history.state?.omnikrux) ? history.state.omnikrux as number : 0);

  // Only a changed address or entry number is written: a row move or filter keystroke that
  // keeps the tab needs no browser write at all.
  const replace = useCallback(() => {
    const state = current.current;
    const hash = hashFor(state.app, state.app === "monitoring" ? state.monitoring.active : state.kubernetes.active);
    if (location.hash === hash && history.state?.omnikrux === seq.current) return;
    write("replaceState", seq.current, hash);
  }, []);

  const applyLink = useCallback(() => {
    const target = parseHash(location.hash);
    const state = current.current;
    if (!target) return;
    if ("legacyKind" in target) {
      dispatch({ type: "switchApp", app: "kubernetes" });
      const tab = state.kubernetes.tabs.find((t) => t.id === state.kubernetes.active)!;
      const view = kindView(tab.view, target.legacyKind);
      if (tab.view.page === "kind") dispatch({ type: "navigate", id: tab.id, view, mode: "push" });
      else dispatch({ type: "newTab", view });
      return;
    }
    dispatch({ type: "switchApp", app: target.app });
    if (target.app === "kubernetes" && target.tab && state.kubernetes.tabs.some((t) => t.id === target.tab)) {
      dispatch({ type: "activateTab", id: target.tab });
    }
    if (target.app === "monitoring" && target.tab && state.monitoring.tabs.some((t) => t.id === target.tab)) {
      dispatch({ type: "monitoring", action: { type: "activateTab", id: target.tab } });
    }
  }, [dispatch]);

  useEffect(() => {
    applyLink();
    replace();
    const onPopState = (e: PopStateEvent) => {
      const n = e.state?.omnikrux;
      if (typeof n !== "number" || !Number.isFinite(n)) {
        applyLink();
        seq.current++;
      } else {
        const state = current.current;
        if (state.app === "kubernetes" && n !== seq.current) {
          const action = { type: n < seq.current ? "back" : "forward", id: state.kubernetes.active } as const;
          current.current = workspaceReducer(state, action);
          dispatch(action);
        }
        if (state.app === "monitoring" && n !== seq.current) {
          const action = { type: "monitoring", action: { type: n < seq.current ? "back" : "forward", id: state.monitoring.active } } as const;
          current.current = workspaceReducer(state, action);
          dispatch(action);
        }
        seq.current = n;
      }
      replace();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyLink, dispatch, replace]);

  useEffect(() => { replace(); }, [ws.app, ws.kubernetes.active, ws.monitoring.active, replace]);

  const navigate = useCallback((id: string, view: Move<KubeView>, mode: Mode) => {
    const state = current.current;
    const tab = state.kubernetes.tabs.find((t) => t.id === id);
    if (!tab) return;
    const next = typeof view === "function" ? view(tab.view) : view;
    if (sameView(tab.view, next)) return;
    const action = { type: "navigate", id, view: next, mode } as const;
    current.current = workspaceReducer(state, action);
    dispatch(action);
    if (state.app !== "kubernetes" || id !== state.kubernetes.active) return;
    if (mode === "push") write("pushState", ++seq.current, hashFor("kubernetes", id));
    else replace();
  }, [dispatch, replace]);

  const step = useCallback((id: string, type: Direction) => {
    const state = current.current;
    const action = { type, id };
    current.current = workspaceReducer(state, action);
    dispatch(action);
    if (state.app === "kubernetes" && id === state.kubernetes.active) replace();
  }, [dispatch, replace]);

  // Monitoring tabs: the same browser entries, written only while Monitoring is shown.
  const monitoringView = useCallback((id: string): MonitoringView | undefined => current.current.monitoring.tabs.find((t) => t.id === id)?.view, []);

  /**
   * A push to the same place is dropped; a replace lands whenever the view state differs. Going
   * somewhere else asks the app's leave check first; a held move changes nothing (returns true).
   */
  const navigateMonitoring = useCallback((id: string, view: MonitoringView, mode: Mode): boolean => {
    const state = current.current;
    const tab = state.monitoring.tabs.find((t) => t.id === id);
    if (!tab) return false;
    const same = sameMonitoringView(tab.view, view);
    if (mode === "push" ? same : equalMonitoringView(tab.view, view)) return false;
    const inner = { type: "navigate", id, view, mode } as const;
    if (!same && monitoringLeaveHeld(inner)) return true;
    const action = { type: "monitoring", action: inner } as const;
    current.current = workspaceReducer(state, action);
    dispatch(action);
    if (state.app !== "monitoring" || id !== state.monitoring.active) return false;
    if (mode === "push") write("pushState", ++seq.current, hashFor("monitoring", id));
    else replace();
    return false;
  }, [dispatch, replace]);

  /** Back or Forward in a Monitoring tab, after the leave check when there is somewhere to go. */
  const stepMonitoring = useCallback((id: string, direction: Direction): boolean => {
    const state = current.current;
    const tab = state.monitoring.tabs.find((t) => t.id === id);
    if (tab && (direction === "back" ? tab.back : tab.forward).length && monitoringLeaveHeld({ type: direction, id })) return true;
    const action = { type: "monitoring", action: { type: direction, id } } as const;
    current.current = workspaceReducer(state, action);
    dispatch(action);
    if (state.app === "monitoring" && id === state.monitoring.active) replace();
    return false;
  }, [dispatch, replace]);

  const monitoringScrolls = useRef(new Map<string, { top: number; timer: ReturnType<typeof setTimeout> }>());
  const flushMonitoringScroll = useCallback((id: string) => {
    const entry = monitoringScrolls.current.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    monitoringScrolls.current.delete(id);
    dispatch({ type: "monitoring", action: { type: "scroll", id, top: entry.top } });
  }, [dispatch]);
  const setMonitoringScroll = useCallback((id: string, top: number) => {
    clearTimeout(monitoringScrolls.current.get(id)?.timer);
    monitoringScrolls.current.set(id, { top, timer: setTimeout(() => flushMonitoringScroll(id), 200) });
  }, [flushMonitoringScroll]);

  const pending = useRef(new Map<string, { top: number; timer: ReturnType<typeof setTimeout> }>());
  const flushScroll = useCallback((id: string) => {
    const entry = pending.current.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.current.delete(id);
    dispatch({ type: "scroll", id, top: entry.top });
  }, [dispatch]);
  const setScroll = useCallback((id: string, top: number) => {
    clearTimeout(pending.current.get(id)?.timer);
    pending.current.set(id, { top, timer: setTimeout(() => flushScroll(id), 200) });
  }, [flushScroll]);

  return useMemo(() => ({
    navigate, step, setScroll, flushScroll,
    monitoringView, navigateMonitoring, stepMonitoring, setMonitoringScroll, flushMonitoringScroll,
  }), [navigate, step, setScroll, flushScroll, monitoringView, navigateMonitoring, stepMonitoring, setMonitoringScroll, flushMonitoringScroll]);
}

export type WorkspaceNav = ReturnType<typeof useWorkspaceNav>;

export function usePaneNav(history: WorkspaceNav, tab: Tab<KubeView>, flushOnUnmount = true): TabNav<KubeView> {
  const id = tab.id;
  const commands = useMemo(() => ({
    navigate: (view: Move<KubeView>, mode: Mode) => history.navigate(id, view, mode),
    back: () => history.step(id, "back"),
    forward: () => history.step(id, "forward"),
    setScroll: (top: number) => history.setScroll(id, top),
  }), [history, id]);
  useEffect(() => {
    if (flushOnUnmount) return () => history.flushScroll(id);
  }, [history, id, flushOnUnmount]);
  return {
    view: tab.view, canBack: tab.back.length > 0, canForward: tab.forward.length > 0,
    scrollTop: tab.scrollTop, ...commands,
  };
}

export function useTabNav(ws: Workspace, dispatch: (action: WorkspaceAction) => void): TabNav<KubeView> {
  const history = useWorkspaceNav(ws, dispatch);
  return usePaneNav(history, ws.kubernetes.tabs.find((t) => t.id === ws.kubernetes.active)!);
}

/** A Monitoring tab's navigation; a function view is resolved against the tab's latest view first. */
export function useMonitoringNav(history: WorkspaceNav, tab: Tab<MonitoringView>): TabNav<MonitoringView> {
  const id = tab.id;
  const commands = useMemo(() => ({
    navigate: (view: Move<MonitoringView>, mode: Mode) => {
      const from = history.monitoringView(id);
      if (!from) return;
      history.navigateMonitoring(id, typeof view === "function" ? view(from) : view, mode);
    },
    back: () => history.stepMonitoring(id, "back"),
    forward: () => history.stepMonitoring(id, "forward"),
    setScroll: (top: number) => history.setMonitoringScroll(id, top),
  }), [history, id]);
  useEffect(() => () => history.flushMonitoringScroll(id), [history, id]);
  return {
    view: tab.view, canBack: tab.back.length > 0, canForward: tab.forward.length > 0,
    scrollTop: tab.scrollTop, ...commands,
  };
}
