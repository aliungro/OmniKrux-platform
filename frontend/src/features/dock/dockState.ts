import type { Cluster, LogSession, ShellSession } from "../../api/types";

export type SessionKind = "logs" | "shell";
export type DockLayout = "single" | "split";
/** Why the follow log still shows its last pod: the selected row isn't a pod, nothing is selected, or the pod is gone. */
export type FollowHold = "notPod" | "noSelection" | "gone";

/** One tab in the dock: a log stream or a shell, always tied to its cluster. */
export interface Session {
  id: string;
  kind: SessionKind;
  cluster: Cluster;
  namespace: string;
  /** The pod; for a selector session (all of a workload's pods), the owner's name, shown on the tab. */
  pod: string;
  /** Null lets the server pick the pod's first container. */
  container: string | null;
  /** Every container in the pod (init, regular and ephemeral), for the log pane's picker. */
  containers: string[];
  /** Logs: open on the previous run. */
  previous?: boolean;
  /** Logs: every pod this label selector matches, instead of one pod. */
  selector?: string;
  /** Shells: the node-shell pod is deleted by the server when the session ends. */
  cleanupPod?: boolean;
  /** Node shells: the node, so starting again can make a new node-shell pod there. */
  node?: string;
  /** Debug shells: the container asked for as target, and the one the server attached to (null: none). */
  debug?: { requested: string | null; target: string | null };
  /** Logs: the one follow log, retargeted in place to the selected pod row. */
  follow?: boolean;
  /** Logs: opened with Shift+L (or pinned from the follow log); never retargets. */
  pinned?: boolean;
  /** The follow log only: why it still shows its last pod. */
  hold?: FollowHold;
}

export interface DockState {
  sessions: Session[];
  /** The tab that's selected; null when there are none. */
  focused: string | null;
  /** The open session focused just before the current one. */
  previous: string | null;
  layout: DockLayout;
  /** The dock's chosen height in pixels while it has sessions; drawn at most 70% of the window. */
  height: number;
}

export type DockAction =
  /**
   * `focus: false` adds the tab without taking focus from the one you're using (an open that
   * finished after a newer one). With nothing focused yet, the new tab is shown anyway.
   */
  | { type: "open"; session: Session; focus?: boolean }
  | { type: "close"; id: string }
  | { type: "closeCluster"; clusterId: string }
  | { type: "focus"; id: string }
  /**
   * Puts a new session where an old one was (a node shell started again makes a new pod). If the
   * old tab has closed meanwhile, the session is added instead: its pod needs a session to be cleaned up.
   * `focus: false` as for "open", unless the old tab is still the focused one.
   */
  | { type: "replace"; id: string; session: Session; focus?: boolean }
  /**
   * Opens the one follow log, or retargets it in place (same id and position, so its pane stays
   * mounted). `focus: false` as for "open". `retarget: true` only moves an open follow log: with
   * none (closed, or its cluster removed, while the describe was on its way) nothing opens.
   */
  | { type: "follow"; session: Session; focus?: boolean; retarget?: boolean }
  /** Sets or clears why the follow log still shows its last pod. */
  | { type: "hold"; reason: FollowHold | null }
  | { type: "toggleLayout" }
  | { type: "resize"; height: number; viewport: number };

export const MIN_HEIGHT = 120;
export const MAX_SHARE = 0.7;
export const DEFAULT_HEIGHT = 340;
export const HEIGHT_KEY = "omnikrux.dock.height";

/** Between 120 px and 70% of the viewport (but never below 120 px, however small the window). */
export function clampHeight(height: number, viewport: number): number {
  const max = Math.max(MIN_HEIGHT, Math.floor(viewport * MAX_SHARE));
  if (!Number.isFinite(height)) return Math.min(DEFAULT_HEIGHT, max);
  return Math.round(Math.min(max, Math.max(MIN_HEIGHT, height)));
}

/**
 * The saved height, or the default; storage that's missing or throws counts as nothing saved.
 * Not fitted to the window here: the dock fits it when it draws, so a window that's briefly small
 * while the page loads doesn't shrink it for good.
 */
export function loadHeight(): number {
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem(HEIGHT_KEY);
  } catch {
    // private window, blocked storage
  }
  const n = saved === null ? Number.NaN : Number(saved);
  return Math.round(Math.max(MIN_HEIGHT, Number.isFinite(n) ? n : DEFAULT_HEIGHT));
}

export function saveHeight(height: number): void {
  try {
    window.localStorage.setItem(HEIGHT_KEY, String(height));
  } catch {
    // the height just isn't remembered
  }
}

export function initialDockState(): DockState {
  return { sessions: [], focused: null, previous: null, layout: "single", height: loadHeight() };
}

/**
 * Two sessions are the same when they'd show the same thing. A pod has one pinned tab, whichever
 * container it was opened on (its picker switches containers): pinning from the follow log and
 * Shift+L on the same pod land on the same tab.
 */
function sameTarget(a: Session, b: Session): boolean {
  return (
    a.kind === b.kind &&
    a.cluster.id === b.cluster.id &&
    a.namespace === b.namespace &&
    a.pod === b.pod &&
    (a.container === b.container || (!!a.pinned && !!b.pinned)) &&
    (a.previous ?? false) === (b.previous ?? false) &&
    (a.selector ?? "") === (b.selector ?? "") &&
    (a.cleanupPod ?? false) === (b.cleanupPod ?? false) &&
    (a.follow ?? false) === (b.follow ?? false) &&
    (a.pinned ?? false) === (b.pinned ?? false)
  );
}

/** The one follow log, if it is open. */
export function followSession(state: DockState): Session | undefined {
  return state.sessions.find((s) => s.follow);
}

/** The session without its hold note. */
function unheld(s: Session): Session {
  const next = { ...s };
  delete next.hold;
  return next;
}

/** The state with one session swapped for another in the same place. */
function swap(state: DockState, old: Session, next: Session): DockState {
  return { ...state, sessions: state.sessions.map((s) => (s === old ? next : s)) };
}

function focusOn(state: DockState, s: Session): DockState {
  return state.focused === s.id ? state : { ...state, focused: s.id, previous: state.focused };
}

/** The newest other open session, when the previous one is no longer available. */
function newestOther(sessions: Session[], focused: string | null): string | null {
  for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].id !== focused) return sessions[i].id;
  return null;
}

export function dockReducer(state: DockState, action: DockAction): DockState {
  switch (action.type) {
    case "open": {
      const quiet = action.focus === false && state.focused !== null;
      const existing = state.sessions.find((s) => sameTarget(s, action.session));
      if (existing) return quiet ? state : focusOn(state, existing);
      const added = { ...state, sessions: [...state.sessions, action.session] };
      if (!quiet) return focusOn(added, action.session);
      return added;
    }
    case "close": {
      const at = state.sessions.findIndex((s) => s.id === action.id);
      if (at < 0) return state;
      const gone = state.sessions[at];
      const sessions = state.sessions.filter((s) => s.id !== action.id);
      let focused = state.focused;
      if (focused === gone.id) {
        // The neighbour takes over, as closing a browser tab does.
        const next = sessions[Math.min(at, sessions.length - 1)];
        focused = next?.id ?? null;
      }
      const previous = state.previous === focused || state.previous === gone.id
        ? newestOther(sessions, focused)
        : state.previous;
      return { ...state, sessions, focused, previous };
    }
    case "closeCluster":
      return state.sessions.reduce((next, session) => session.cluster.id === action.clusterId
        ? dockReducer(next, { type: "close", id: session.id }) : next, state);
    case "focus": {
      const s = state.sessions.find((x) => x.id === action.id);
      if (!s) return state;
      return focusOn(state, s);
    }
    case "replace": {
      const at = state.sessions.findIndex((s) => s.id === action.id);
      if (at < 0) return dockReducer(state, { type: "open", session: action.session, focus: action.focus });
      const sessions = state.sessions.slice();
      sessions[at] = action.session;
      const next = {
        ...state,
        sessions,
        focused: state.focused === action.id ? action.session.id : state.focused,
        previous: state.previous === action.id ? action.session.id : state.previous,
      };
      return action.focus === false && state.focused !== action.id ? next : focusOn(next, action.session);
    }
    case "follow": {
      const current = followSession(state);
      const quiet = action.focus === false && state.focused !== null;
      if (!current && action.retarget) return state;
      if (!current) {
        const added = unheld({ ...action.session, follow: true });
        delete added.pinned;
        const next = { ...state, sessions: [...state.sessions, added] };
        return quiet ? next : focusOn(next, added);
      }
      const t = action.session;
      const same = current.cluster.id === t.cluster.id && current.namespace === t.namespace &&
        current.pod === t.pod && current.container === t.container;
      let next = state;
      if (!same) {
        next = swap(state, current, unheld({
          ...current,
          cluster: t.cluster,
          namespace: t.namespace,
          pod: t.pod,
          container: t.container,
          containers: t.containers,
        }));
      } else if (current.hold) {
        next = swap(state, current, unheld(current));
      }
      return action.focus === false ? next : focusOn(next, current);
    }
    case "hold": {
      const current = followSession(state);
      if (!current || (current.hold ?? null) === action.reason) return state;
      return swap(state, current, action.reason ? { ...current, hold: action.reason } : unheld(current));
    }
    case "toggleLayout":
      if (state.sessions.length < 2) return state;
      return { ...state, layout: state.layout === "single" ? "split" : "single" };
    case "resize":
      return { ...state, height: clampHeight(action.height, action.viewport) };
  }
}

/**
 * One pane, or the focused and previously focused sessions side by side, in tab order.
 */
export function visibleSessions(state: DockState): Session[] {
  const focused = state.sessions.find((s) => s.id === state.focused);
  if (!focused) return [];
  if (state.layout === "single") return [focused];
  const previous = state.sessions.find((s) => s.id === state.previous && s.id !== focused.id)
    ?? state.sessions.find((s) => s.id !== focused.id);
  return state.sessions.filter((s) => s.id === focused.id || s.id === previous?.id);
}

export function toLogSession(s: Session): LogSession {
  return {
    clusterId: s.cluster.id,
    clusterName: s.cluster.name,
    provider: s.cluster.provider,
    namespace: s.namespace,
    pod: s.selector ? undefined : s.pod,
    selector: s.selector,
    container: s.container,
    containers: s.containers,
    previous: s.previous,
  };
}

export function toShellSession(s: Session): ShellSession {
  return {
    clusterId: s.cluster.id,
    clusterName: s.cluster.name,
    provider: s.cluster.provider,
    namespace: s.namespace,
    pod: s.pod,
    container: s.container,
    cleanupPod: s.cleanupPod ?? false,
  };
}

/** "cluster / namespace / pod (container)": where a session reads from or types into. */
export function identity(s: Session): string {
  const target = s.selector ? `pods matching ${s.selector}` : s.pod;
  const container = s.container ? ` (${s.container})` : "";
  return `${s.cluster.name} / ${s.namespace} / ${target}${container}`;
}
