import { memo, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { LogPane } from "../logs/LogPane";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  MAX_SHARE,
  MIN_HEIGHT,
  clampHeight,
  saveHeight,
  toLogSession,
  toShellSession,
  visibleSessions,
  type Session,
} from "./dockState";
import { LazyShellPane } from "./lazyShell";
import { SessionTabs, panelId, tabId } from "./SessionTabs";
import type { DockApi } from "./useDock";
import s from "./Dock.module.css";

export const EMPTY_DOCK = "Open logs (l) or a shell (s) from a pod";
const STEP = 24; // pixels per arrow key on the grip

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

function Grip({ height, viewport, onResize }: { height: number; viewport: number; onResize: (h: number) => void }) {
  const drag = useRef<{ y: number; h: number } | null>(null);
  const max = Math.max(MIN_HEIGHT, Math.floor(viewport * MAX_SHARE));

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
    const by: Record<string, number> = { ArrowUp: height + STEP, ArrowDown: height - STEP, Home: MIN_HEIGHT, End: max };
    if (!(e.key in by)) return;
    e.preventDefault();
    onResize(by[e.key]);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the dock"
      aria-valuemin={MIN_HEIGHT}
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
export const Dock = memo(function Dock({ dock }: { dock: DockApi }) {
  const { state, dispatch, ask } = dock;
  const base = useId();
  const [viewport, setViewport] = useState(() => window.innerHeight);

  // Ctrl \ switches between one pane and side by side, even from inside a terminal.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || (e.key !== "\\" && e.code !== "Backslash")) return;
      e.preventDefault();
      e.stopPropagation();
      dispatch({ type: "toggleLayout" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dispatch]);

  // The dock is drawn within 70% of the window as it is now; the chosen height comes back when it grows.
  useEffect(() => {
    const onResize = () => setViewport(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const height = clampHeight(state.height, viewport);

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

  const dialog = ask && <ConfirmDialog ask={ask} onConfirm={dock.confirm} onCancel={dock.cancel} />;

  if (state.sessions.length === 0) {
    return (
      <section className={`${s.dock} ${s.empty}`} aria-label="Sessions">
        <p className={s.hint}>{EMPTY_DOCK}</p>
        {dialog}
      </section>
    );
  }

  const visible = visibleSessions(state);
  const split = visible.length === 2;
  // Ctrl F belongs to the one log pane on screen, never to a background tab.
  const activeLogs = visible.find((x) => x.kind === "logs")?.id ?? null;

  return (
    <section className={s.dock} style={{ height }} aria-label="Sessions">
      <Grip height={height} viewport={viewport} onResize={(h) => dispatch({ type: "resize", height: h, viewport })} />
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
            hidden={!visible.includes(x)}
            className={`${s.panel} ${x.kind === "logs" ? s.logs : s.shell}`}
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
                active={x.id === state.focused}
                onStartDebug={x.debug || x.node ? undefined : () => dock.askDebug(x)}
                onRestart={x.node ? () => dock.askRestart(x) : undefined}
                note={shellNote(x)}
              />
            )}
          </div>
        ))}
      </div>
      {dialog}
    </section>
  );
});
