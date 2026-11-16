import {
  memo,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
} from "react";
import { inTerminal, isDeleteKey, isEditable, pressed } from "../chrome/shortcuts";
import { LogPane } from "../logs/LogPane";
import { ConfirmDialog } from "./ConfirmDialog";
import { holdNote } from "./follow";
import {
  MAX_SHARE,
  MIN_HEIGHT,
  clampHeight,
  dockReducer,
  saveHeight,
  toLogSession,
  toShellSession,
  visibleSessions,
  type Session,
} from "./dockState";
import { LazyShellPane } from "./lazyShell";
import { SessionTabs, panelId, tabId } from "./SessionTabs";
import { ShellContainerDialog } from "./ShellContainerDialog";
import type { DockApi } from "./useDock";
import s from "./Dock.module.css";

export const EMPTY_DOCK = "Open logs (l) or a shell (s) from a pod";
/** Alt+Down with nothing in the dock. */
export const NO_LOGS_YET = "No logs open yet: press L on a pod first.";
const NOTICE_MS = 4000;
const STEP = 24; // pixels per arrow key on the grip
const STACK_AT = 760; // same breakpoint as Dock.module.css
const PANE_MIN = 170; // header, wrapped controls, and room for log lines
const NARROW_SPLIT_PANE_MIN = 218;
const STRIP_MIN = 44; // grip and one tab row

/** What a shell is attached to, when that isn't the pod's own container. */
function shellNote(x: Session): string | undefined {
  if (x.node) return `A shell on node ${x.node}. Its pod is deleted when you close this tab.`;
  if (!x.debug) return undefined;
  const { requested, target } = x.debug;
  if (target) return `This shell runs in debug container ${x.container}, attached to ${target}'s processes.`;
  if (requested) {
    return `This shell runs in debug container ${x.container}. It isn't attached to ${requested}'s processes because ${requested} isn't running.`;
  }
  return `This shell runs in debug container ${x.container}.`;
}

function Grip({ height, minimum, max, onResize }: { height: number; minimum: number; max: number; onResize: (h: number) => void }) {
  const drag = useRef<{ y: number; h: number } | null>(null);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { y: e.clientY, h: height };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) onResize(drag.current.h + (drag.current.y - e.clientY));
  };
  const onUp = () => {
    drag.current = null;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // With a modifier the arrows are someone else's: Alt+Up leaves the logs.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const by: Record<string, number> = { ArrowUp: height + STEP, ArrowDown: height - STEP, Home: minimum, End: max };
    if (!(e.key in by)) return;
    e.preventDefault();
    onResize(by[e.key]);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the dock"
      aria-valuemin={minimum}
      aria-valuemax={max}
      aria-valuenow={height}
      tabIndex={0}
      className={s.grip}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
    />
  );
}

/** What Shell can ask of the dock: Alt+Down moves the keyboard into it. */
export interface DockHandle {
  /** Focus the selected session's log (or its shell's terminal); false, and a notice, with none open. */
  enter(): boolean;
}

/** The key's target, unless the key is not the dock's: handled, composing, or in a dialog, picker or modal. */
function dockKeyTarget(e: KeyboardEvent<HTMLElement>): Element | null {
  const target = e.target;
  if (e.defaultPrevented || e.nativeEvent.isComposing || !(target instanceof Element)) return null;
  if (target.closest("select, dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']")) return null;
  if (document.querySelector('[aria-modal="true"]')) return null;
  return target;
}

/** No modifier held: the dock's arrows act only then (Alt+arrows are history and leaving the logs). */
function plain(e: KeyboardEvent<HTMLElement>): boolean {
  return !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

/**
 * The dock under the table: one tab per logs or shell session, each named and coloured by its
 * cluster. Sessions stay connected while their tab is in the background. Memoized: `useDock`'s API
 * object changes only with the dock's own state, so watch updates to the table don't re-render it.
 *
 * The logs keyboard zone: Esc and Alt+Up go back to the table (`onFocusWorkspace`) and never close
 * anything; left and right on a log switch tabs; Ctrl+Del (Cmd+Backspace) closes the tab that has
 * the focus; Shift+L in the follow log pins its pod. Inside a terminal only Alt+Up is the dock's.
 */
export const Dock = memo(function Dock({
  dock,
  onFocusWorkspace,
  zoneActive = false,
  ref,
}: {
  dock: DockApi;
  zoneActive?: boolean;
  onFocusWorkspace: () => void;
  ref?: Ref<DockHandle>;
}) {
  const { state, dispatch, ask, shellChoice } = dock;
  const base = useId();
  const [viewport, setViewport] = useState(() => ({ height: window.innerHeight, width: window.innerWidth }));
  const [autofocusSuppressedTab, setAutofocusSuppressedTab] = useState<string | null>(null);
  /** Alt+Down's "nothing open" line, shown in the empty dock for a few seconds (`at` restarts the clock). */
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null);
  /** The session whose log (or tab button, for a shell) takes the focus once it is drawn. */
  const pendingFocus = useRef<string | null>(null);
  /** What last had the focus in the dock, to rescue the focus when a removal takes it away. */
  const lastDockFocus = useRef<Element | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const backToWorkspace = useRef(onFocusWorkspace);
  backToWorkspace.current = onFocusWorkspace;

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);

  /** Where the keyboard lands in a session: its log, or its tab button for a shell (so arrows keep working). */
  const landingOf = (id: string): HTMLElement | null => {
    const x = stateRef.current.sessions.find((s) => s.id === id);
    if (!x) return null;
    if (x.kind === "logs") {
      return document.getElementById(panelId(base, id))?.querySelector<HTMLElement>('[role="log"]') ?? null;
    }
    return document.getElementById(tabId(base, id));
  };

  useImperativeHandle(ref, () => ({
    enter() {
      const { sessions, focused } = stateRef.current;
      const x = sessions.find((s) => s.id === focused);
      if (!x) {
        setNotice((n) => ({ text: NO_LOGS_YET, at: (n?.at ?? 0) + 1 }));
        return false;
      }
      setNotice(null);
      if (x.kind === "logs") {
        landingOf(x.id)?.focus();
      } else {
        // The terminal takes the keyboard: active again (so it focuses itself once it opens), and now.
        setAutofocusSuppressedTab(null);
        document.getElementById(panelId(base, x.id))?.querySelector<HTMLElement>(".xterm textarea")?.focus();
      }
      return true;
    },
  }));

  // After a commit: focus what a key asked for, or rescue the focus a removal left on <body>.
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (id !== null) {
      pendingFocus.current = null;
      landingOf(id)?.focus();
    }
    const last = lastDockFocus.current;
    if (last && !last.isConnected && (document.activeElement === document.body || document.activeElement === null)) {
      lastDockFocus.current = null;
      backToWorkspace.current();
    }
  }, [state.sessions, state.focused]);

  // Ctrl \ switches between one pane and side by side, even from inside a terminal.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!pressed("layout", e)) return;
      e.preventDefault();
      e.stopPropagation();
      dispatch({ type: "toggleLayout" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dispatch]);

  // The dock is drawn within 70% of the window as it is now; the chosen height comes back when it grows.
  useEffect(() => {
    const onResize = () => setViewport({ height: window.innerHeight, width: window.innerWidth });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Remember the height once it settles (not on every pixel of a drag).
  const settled = useRef(state.height);
  useEffect(() => {
    if (state.height === settled.current) return;
    const t = window.setTimeout(() => {
      settled.current = state.height;
      saveHeight(state.height);
    }, 250);
    return () => window.clearTimeout(t);
  }, [state.height]);

  /** Focus another session once it is shown, keeping a shell's terminal from taking the keyboard. */
  const moveTo = (id: string) => {
    if (state.sessions.find((x) => x.id === id)?.kind === "shell") setAutofocusSuppressedTab(tabId(base, id));
    pendingFocus.current = id;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const target = dockKeyTarget(e);
    if (!target) return;
    let act: (() => void) | null = null;
    // Back to the table, from anywhere in the dock: a session or the strip's controls (grip, layout).
    if ((!e.shiftKey && pressed("backToTable", e) && !inTerminal(target)) || pressed("leaveLogs", e)) {
      act = onFocusWorkspace;
    }
    const owner = target.closest<HTMLElement>("[data-dock-session]");
    const at = state.sessions.findIndex((x) => x.id === owner?.dataset.dockSession);
    const session = state.sessions[at];
    const onLog = target.matches('[role="log"]');
    // The tab button or its close button.
    const onTab = target.closest('[role="tablist"]') !== null;

    if (act || !session) {
      // Nothing else is the strip's.
    } else if (onLog && plain(e) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      act = () => {
        const n = state.sessions.length;
        const next = state.sessions[(at + (e.key === "ArrowRight" ? 1 : n - 1)) % n];
        if (next.id === session.id) return;
        if (next.id === state.focused) {
          // Already selected (an arrow from its split peer): nothing re-renders, so focus it now
          // rather than leave a pending focus for some later change to spring on the table.
          landingOf(next.id)?.focus();
          return;
        }
        moveTo(next.id);
        dispatch({ type: "focus", id: next.id });
      };
    } else if (isDeleteKey(e) && (onLog || onTab) && !isEditable(target)) {
      act = () => {
        const action = { type: "close", id: session.id } as const;
        const next = dockReducer(state, action).focused;
        if (next) moveTo(next);
        dispatch(action);
        if (!next) onFocusWorkspace();
      };
    } else if (session.follow && (onLog || onTab) && pressed("pinFollow", e)) {
      act = dock.pinFollow;
    }
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) act();
  };

  // Where the focus is in the dock; moving it somewhere else outside the dock forgets it.
  const tracking = {
    onFocus: (e: FocusEvent<HTMLElement>) => {
      lastDockFocus.current = e.target;
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      const to = e.relatedTarget;
      if (to instanceof Node && !e.currentTarget.contains(to)) lastDockFocus.current = null;
    },
  };

  const dialog = ask
    ? <ConfirmDialog ask={ask} onConfirm={dock.confirm} onCancel={dock.cancel} />
    : shellChoice && <ShellContainerDialog choice={shellChoice} onCancel={dock.cancel} />;

  if (state.sessions.length === 0) {
    return (
      <section className={`${s.dock} ${s.empty}`} aria-label="Logs and shells" data-dock data-keyboard-zone={zoneActive ? "logs" : undefined} data-page-keys="off" {...tracking}>
        {dialog}
        {/* Always there, so a notice is announced when the text changes. */}
        <p className={s.hint} role="status">{notice?.text ?? EMPTY_DOCK}</p>
      </section>
    );
  }

  const visible = visibleSessions(state);
  const split = visible.length === 2;
  const max = Math.max(MIN_HEIGHT, Math.floor(viewport.height * MAX_SHARE));
  const paneRows = split && viewport.width <= STACK_AT ? 2 : 1;
  const paneMin = split && paneRows === 1 && viewport.width <= 1000 ? NARROW_SPLIT_PANE_MIN : PANE_MIN;
  const minimum = Math.min(max, STRIP_MIN + paneMin * paneRows);
  const height = Math.max(minimum, clampHeight(state.height, viewport.height));
  // Ctrl F belongs to the focused log pane, or the sole visible logs beside a shell.
  const activeLogs = visible.find((x) => x.kind === "logs" && x.id === state.focused)?.id
    ?? visible.find((x) => x.kind === "logs")?.id ?? null;

  return (
    <section
      className={s.dock}
      style={{ height, "--dock-pane-min": `${minimum - STRIP_MIN}px` } as CSSProperties}
      aria-label="Logs and shells"
      data-dock
      data-keyboard-zone={zoneActive ? "logs" : undefined}
      data-page-keys="off"
      onKeyDown={onKeyDown}
      {...tracking}
      onFocusCapture={(e) => {
        const tab = (e.target as HTMLElement).closest('[role="tab"]');
        // Tab navigation suppresses this session's autofocus; new sessions can still activate.
        // Moving to a close button, layout control or grip must not re-enable it.
        if (tab) setAutofocusSuppressedTab(tab.id);
      }}
    >
      {dialog}
      <Grip height={height} minimum={minimum} max={max}
        onResize={(h) => dispatch({ type: "resize", height: Math.max(minimum, h), viewport: viewport.height })} />
      <SessionTabs
        base={base}
        sessions={state.sessions}
        focused={state.focused}
        layout={state.layout}
        onFocus={(id) => dispatch({ type: "focus", id })}
        onClose={(id) => dispatch({ type: "close", id })}
        onToggleLayout={() => dispatch({ type: "toggleLayout" })}
      />
      <div className={`${s.panes}${split ? ` ${s.split}` : ""}`}>
        {state.sessions.map((x) => (
          <div
            key={x.id}
            role="tabpanel"
            id={panelId(base, x.id)}
            aria-labelledby={tabId(base, x.id)}
            data-dock-session={x.id}
            hidden={!visible.includes(x)}
            data-first-pane={split && x === visible[0] ? "true" : undefined}
            className={s.panel}
            // Always dispatched, even inside the selected pane: a focus is your choice, so it also cancels
            // any open still on its way (the reducer keeps the state as it is when nothing changes).
            onFocus={() => dispatch({ type: "focus", id: x.id })}
          >
            {x.kind === "logs" ? (
              <LogPane key={x.id} session={toLogSession(x)} active={x.id === activeLogs}
                note={x.follow ? holdNote(x) : null} />
            ) : (
              <LazyShellPane
                key={x.id}
                session={toShellSession(x)}
                active={x.id === state.focused && autofocusSuppressedTab !== tabId(base, x.id)}
                onStartDebug={x.debug || x.node ? undefined : () => dock.askDebug(x)}
                onRestart={x.node ? () => dock.askRestart(x) : undefined}
                note={shellNote(x)}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  );
});
