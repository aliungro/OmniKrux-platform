import type { Cluster, LogSession, ShellSession } from "../../api/types";

export type SessionKind = "logs" | "shell";
export type DockLayout = "single" | "split";

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
}

export interface DockState {
  sessions: Session[];
  /** The tab that's selected; null when there are none. */
  focused: string | null;
  /** The last-focused session of each kind; split layout shows these two side by side. */
  last: Record<SessionKind, string | null>;
  layout: DockLayout;
  /** The dock's chosen height in pixels while it has sessions; drawn at most 70% of the window. */
  height: number;
}

export type DockAction =
  | { type: "open"; session: Session }
  | { type: "close"; id: string }
  | { type: "focus"; id: string }
  /** Puts a new session where an old one was (a node shell started again makes a new pod). */
  | { type: "replace"; id: string; session: Session }
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
  return { sessions: [], focused: null, last: { logs: null, shell: null }, layout: "single", height: loadHeight() };
}

/** Two sessions are the same when they'd show the same thing. */
function sameTarget(a: Session, b: Session): boolean {
  return (
    a.kind === b.kind &&
    a.cluster.id === b.cluster.id &&
    a.namespace === b.namespace &&
    a.pod === b.pod &&
    a.container === b.container &&
    (a.previous ?? false) === (b.previous ?? false) &&
    (a.selector ?? "") === (b.selector ?? "") &&
    (a.cleanupPod ?? false) === (b.cleanupPod ?? false)
  );
}

function focusOn(state: DockState, s: Session): DockState {
  return { ...state, focused: s.id, last: { ...state.last, [s.kind]: s.id } };
}

/** The newest remaining session of a kind, for when the last-focused one closes. */
function newestOf(sessions: Session[], kind: SessionKind): string | null {
  for (let i = sessions.length - 1; i >= 0; i--) if (sessions[i].kind === kind) return sessions[i].id;
  return null;
}

export function dockReducer(state: DockState, action: DockAction): DockState {
  switch (action.type) {
    case "open": {
      const existing = state.sessions.find((s) => sameTarget(s, action.session));
      if (existing) return focusOn(state, existing);
      return focusOn({ ...state, sessions: [...state.sessions, action.session] }, action.session);
    }
    case "close": {
      const at = state.sessions.findIndex((s) => s.id === action.id);
      if (at < 0) return state;
      const gone = state.sessions[at];
      const sessions = state.sessions.filter((s) => s.id !== action.id);
      const last = { ...state.last };
      if (last[gone.kind] === gone.id) last[gone.kind] = newestOf(sessions, gone.kind);
      let focused = state.focused;
      if (focused === gone.id) {
        // The neighbour takes over, as closing a browser tab does.
        const next = sessions[Math.min(at, sessions.length - 1)];
        focused = next?.id ?? null;
        if (next) last[next.kind] = next.id;
      }
      return { ...state, sessions, focused, last };
    }
    case "focus": {
      const s = state.sessions.find((x) => x.id === action.id);
      return s ? focusOn(state, s) : state;
    }
    case "replace": {
      const at = state.sessions.findIndex((s) => s.id === action.id);
      if (at < 0) return state;
      const sessions = state.sessions.slice();
      sessions[at] = action.session;
      const last = { ...state.last };
      for (const k of ["logs", "shell"] as const) if (last[k] === action.id) last[k] = null;
      const next = { ...state, sessions, last, focused: state.focused === action.id ? null : state.focused };
      return focusOn(next, action.session);
    }
    case "toggleLayout":
      return { ...state, layout: state.layout === "single" ? "split" : "single" };
    case "resize":
      return { ...state, height: clampHeight(action.height, action.viewport) };
  }
}

/**
 * What's on screen: one pane, or in split layout the last logs and the last shell side by side,
 * when there are both (the focused one is always among them).
 */
export function visibleSessions(state: DockState): Session[] {
  const focused = state.sessions.find((s) => s.id === state.focused);
  if (!focused) return [];
  if (state.layout === "single") return [focused];
  const logs = state.sessions.find((s) => s.id === state.last.logs);
  const shell = state.sessions.find((s) => s.id === state.last.shell);
  return logs && shell ? [logs, shell] : [focused];
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
