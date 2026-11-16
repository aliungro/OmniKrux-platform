import { memo, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { inTerminal, pressed } from "../chrome/shortcuts";
import { LogPane } from "../logs/LogPane";
import { ConfirmDialog } from "./ConfirmDialog";
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

/**
 * The dock under the table: one tab per logs or shell session, each named and coloured by its
 * cluster. Sessions stay connected while their tab is in the background. Memoized: `useDock`'s API
 * object changes only with the dock's own state, so watch updates to the table don't re-render it.
 */
export const Dock = memo(function Dock({ dock, onFocusWorkspace }: { dock: DockApi; onFocusWorkspace: () => void }) {
  const { state, dispatch, ask, shellChoice } = dock;
  const base = useId();
  const [viewport, setViewport] = useState(() => ({ height: window.innerHeight, width: window.innerWidth }));
  const [autofocusSuppressedTab, setAutofocusSuppressedTab] = useState<string | null>(null);

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

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const close = !e.shiftKey && pressed("backToTable", e);
    if (!close && !pressed("leaveLogs", e)) return;
    const target = e.target;
    if (e.defaultPrevented || e.nativeEvent.isComposing || !(target instanceof Element) ||
        target !== document.activeElement || inTerminal(target) || target.closest("select, dialog, [role='dialog'], [role='alertdialog']") ||
        document.querySelector('[aria-modal="true"]')) return;
    const owner = target.closest<HTMLElement>("[data-dock-session]");
    const session = state.sessions.find((x) => x.id === owner?.dataset.dockSession);
    if (session?.kind !== "logs") return;

    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    onFocusWorkspace();
    if (!close) return;
    const action = { type: "close", id: session.id } as const;
    const afterClose = dockReducer(state, action);
    const survivor = afterClose.sessions.find((x) => x.id === afterClose.focused);
    if (survivor?.kind === "shell" && survivor.id !== state.focused) {
      setAutofocusSuppressedTab(tabId(base, survivor.id));
    }
    dispatch(action);
  };

  const dialog = ask
    ? <ConfirmDialog ask={ask} onConfirm={dock.confirm} onCancel={dock.cancel} />
    : shellChoice && <ShellContainerDialog choice={shellChoice} onCancel={dock.cancel} />;

  if (state.sessions.length === 0) {
    return (
      <section className={`${s.dock} ${s.empty}`} aria-label="Logs and shells" data-page-keys="off">
        {dialog}
        <p className={s.hint}>{EMPTY_DOCK}</p>
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
      data-page-keys="off"
      onKeyDown={onKeyDown}
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
              <LogPane key={x.id} session={toLogSession(x)} active={x.id === activeLogs} />
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
