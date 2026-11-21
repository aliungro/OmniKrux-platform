// Edit mode on the panel grid (E2): every panel is a tile you can move and resize by pointer or
// keyboard, "+ Add panel" sits in the free space, and the selected panel's settings open beside
// the grid. The grid itself stays `DashboardGrid`, so panels keep running (and keep their data)
// when edit mode starts or ends.
import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject,
} from "react";
import { isDeleteKey, pressed } from "../../../features/chrome/shortcuts";
import { escapeCloses } from "../../focus";
import { freeSpot, neighbour, placePanel, type Dir } from "../layout";
import { GRID_COLUMNS, type Layout, type PanelSpec } from "../schema";
import { pageLetter } from "../page/keys";
import { AddPanelTile, cellStyle } from "./AddPanelTile";
import { editorReducer, type EditingState, type EditorAction } from "./editorState";
import s from "./EditableGrid.module.css";

export interface GridEditor {
  state: EditingState;
  dispatch(action: EditorAction): void;
  /** Esc on a tile: the keyboard goes to Save dashboard. */
  onLeave(): void;
}

/** What `PanelFrame` needs to be a tile. */
export interface TileProps {
  label: string;
  tabIndex: 0 | -1;
  selected: boolean;
  dragging: boolean;
  /** How far a dragged tile follows the pointer, in px. */
  offset: { x: number; y: number } | null;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
  onFocus(): void;
  grab: ReactNode;
  corner: ReactNode;
}

export interface GridEditing {
  layoutOf(panel: PanelSpec): Layout;
  tile(panel: PanelSpec): TileProps;
  /** Inside the grid: the drop target and the Add panel tile. */
  layer: ReactNode;
  /** Beside the grid: the selected panel's settings. */
  aside: ReactNode;
  /** The polite live region that says what a move, resize or removal did. */
  live: ReactNode;
}

const GAP = 10;
const ROW_PITCH = 30 + GAP;
const ADD_SIZE = { w: 12, h: 8 };
const ARROWS: Readonly<Record<string, Dir>> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

export const panelName = (p: PanelSpec) => p.title.trim() || "Untitled panel";
const tileLabel = (p: PanelSpec, l: Layout) => `${panelName(p)}, ${l.w} by ${l.h}, column ${l.x + 1}, row ${l.y + 1}`;
const sameLayout = (a: Layout, b: Layout) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

type Drag = {
  id: string;
  kind: "move" | "resize";
  pointer: number;
  handle: HTMLElement;
  startX: number;
  startY: number;
  start: Layout;
  /** The panels when the drag began: every preview is placed from these. */
  panels: PanelSpec[];
  colPitch: number;
  to: Layout;
  onEscape: (e: globalThis.KeyboardEvent) => void;
};
type Preview = { id: string; kind: "move" | "resize"; panels: PanelSpec[]; target: Layout; offset: { x: number; y: number } | null };
type Settings = { open: boolean; focus: "tab" | "query"; seq: number };

const movedWords = (id: string) => (n: EditingState) => {
  const p = panelIn(n, id);
  return p ? `Moved "${panelName(p)}" to column ${p.layout.x + 1}, row ${p.layout.y + 1}.` : null;
};
const resizedWords = (id: string) => (n: EditingState) => {
  const p = panelIn(n, id);
  return p ? `Resized "${panelName(p)}" to ${p.layout.w} by ${p.layout.h}.` : null;
};
const byReading = (a: PanelSpec, b: PanelSpec) => a.layout.y - b.layout.y || a.layout.x - b.layout.x;
const panelIn = (st: EditingState, id: string | null) => (id === null ? undefined : st.draft.panels.find((p) => p.id === id));

/** Edit mode for `DashboardGrid`; null outside edit mode. `gridRef` is the grid element (its width sets the cell size). */
export function useEditableGrid(editor: GridEditor | null, gridRef: RefObject<HTMLDivElement | null>): GridEditing | null {
  const editing = editor !== null;
  const latest = useRef(editor);
  latest.current = editor;
  const [current, setCurrent] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>({ open: false, focus: "tab", seq: 0 });
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const drag = useRef<Drag | null>(null);
  /** A tile id (or "add") to put the keyboard on after the next render. */
  const refocus = useRef<string | null>(null);

  const focusTile = useCallback((id: string) => {
    const root = gridRef.current;
    if (!root) return false;
    const el = id === "add"
      ? root.querySelector<HTMLElement>("[data-add-tile]")
      : Array.from(root.querySelectorAll<HTMLElement>("[data-tile-id]")).find((t) => t.dataset.tileId === id);
    el?.focus({ preventScroll: false });
    return !!el;
  }, [gridRef]);

  /** Dispatches `action` and says what it did; returns the state it makes. */
  const act = useCallback((action: EditorAction, say?: (next: EditingState) => string | null) => {
    const ed = latest.current;
    if (!ed) return null;
    const next = editorReducer(ed.state, action);
    ed.dispatch(action);
    if (next.mode !== "edit") return null;
    if (say && next !== ed.state) {
      const words = say(next);
      if (words) setMessage(words);
    }
    return next;
  }, []);

  const openSettings = useCallback((id: string, focus: Settings["focus"]) => {
    setCurrent(id);
    setSettings((was) => ({ open: true, focus, seq: was.seq + 1 }));
  }, []);

  const add = useCallback(() => {
    const ed = latest.current;
    if (!ed) return;
    const at = freeSpot(ed.state.draft.panels, ADD_SIZE.w, ADD_SIZE.h);
    const next = act({ type: "addPanel", panelType: "timeseries", at });
    if (next?.selected) openSettings(next.selected, "query");
  }, [act, openSettings]);

  const remove = (panel: PanelSpec, panels: PanelSpec[]) => {
    const to = (["right", "left", "down", "up"] as const).map((d) => neighbour(panels, panel.id, d)).find((id) => id !== null) ?? null;
    refocus.current = to ?? "add";
    setCurrent(to);
    if (latest.current?.state.selected === panel.id) setSettings((was) => ({ ...was, open: false }));
    act({ type: "removePanel", id: panel.id }, () => `Removed "${panelName(panel)}". Discard brings it back.`);
  };

  const closeSettings = useCallback(() => {
    setSettings((was) => ({ ...was, open: false }));
    const id = latest.current?.state.selected;
    if (id) focusTile(id);
  }, [focusTile]);

  // --- pointer: move by the ⋮⋮ handle, resize by the corner --------------------------------------

  const finish = useCallback((d: Drag, apply: boolean) => {
    drag.current = null;
    window.removeEventListener("keydown", d.onEscape, true);
    try { d.handle.releasePointerCapture?.(d.pointer); } catch { /* already released */ }
    setPreview(null);
    refocus.current = d.id;
    focusTile(d.id);
    if (apply && !sameLayout(d.to, d.start)) {
      act({ type: "place", id: d.id, to: d.to }, d.kind === "move" ? movedWords(d.id) : resizedWords(d.id));
    }
  }, [act, focusTile]);

  const startDrag = (panel: PanelSpec, kind: Drag["kind"]) => (e: PointerEvent<HTMLButtonElement>) => {
    const ed = latest.current;
    if (e.button !== 0 || drag.current || !ed) return;
    e.preventDefault();
    const width = gridRef.current?.getBoundingClientRect().width ?? 0;
    const onEscape = (k: globalThis.KeyboardEvent) => {
      if (k.key !== "Escape" || drag.current === null) return;
      k.preventDefault();
      k.stopPropagation();
      finish(drag.current, false);
    };
    drag.current = {
      id: panel.id, kind, pointer: e.pointerId, handle: e.currentTarget, startX: e.clientX, startY: e.clientY,
      start: panel.layout, panels: ed.state.draft.panels, colPitch: width > 0 ? (width + GAP) / GRID_COLUMNS : ROW_PITCH,
      to: panel.layout, onEscape,
    };
    window.addEventListener("keydown", onEscape, true);
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    setCurrent(panel.id);
  };
  const dragFor = (e: PointerEvent<HTMLButtonElement>) => (drag.current?.pointer === e.pointerId ? drag.current : null);
  const moveDrag = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragFor(e);
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const cols = Math.round(dx / d.colPitch);
    const rows = Math.round(dy / ROW_PITCH);
    d.to = d.kind === "move"
      ? { ...d.start, x: d.start.x + cols, y: d.start.y + rows }
      : { ...d.start, w: d.start.w + cols, h: d.start.h + rows };
    const placed = placePanel(d.panels, d.id, d.to);
    const target = placed.find((p) => p.id === d.id)?.layout ?? d.start;
    setPreview({ id: d.id, kind: d.kind, panels: placed, target, offset: d.kind === "move" ? { x: dx, y: dy } : null });
  };
  const endDrag = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragFor(e);
    if (d) finish(d, true);
  };
  const cancelDrag = (e: PointerEvent<HTMLButtonElement>) => {
    const d = dragFor(e);
    if (d) finish(d, false);
  };

  // --- entering and leaving edit mode, and where the keyboard goes ------------------------------

  const wasEditing = useRef(editing);
  useLayoutEffect(() => {
    if (editing && !wasEditing.current) {
      // The Edit button went away under the keyboard: it goes to the first tile.
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) {
        const first = latest.current ? [...latest.current.state.draft.panels].sort(byReading)[0] : undefined;
        refocus.current = first?.id ?? "add";
      }
    }
    if (!editing && wasEditing.current) {
      const d = drag.current;
      if (d) window.removeEventListener("keydown", d.onEscape, true);
      drag.current = null;
      setPreview(null);
      setSettings((was) => ({ ...was, open: false }));
      setMessage("");
      setCurrent(null);
    }
    wasEditing.current = editing;
  }, [editing]);

  useLayoutEffect(() => {
    const want = refocus.current;
    if (want === null) return;
    refocus.current = null;
    const active = document.activeElement;
    const there = want !== "add" && active instanceof HTMLElement && active.dataset.tileId === want;
    if (!there) focusTile(want);
  });

  useEffect(() => () => {
    const d = drag.current;
    if (d) window.removeEventListener("keydown", d.onEscape, true);
  }, []);

  // `a` adds a panel from anywhere on the page while editing (never from a field).
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!pageLetter(e) || !pressed("panelAdd", e) || drag.current) return;
      e.preventDefault();
      add();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing, add]);

  if (!editor) return null;
  const { state } = editor;
  const panels = state.draft.panels;
  const ordered = [...panels].sort(byReading);
  const has = (id: string | null) => id !== null && panels.some((p) => p.id === id);
  const roving = has(current) ? current : has(state.selected) ? state.selected : (ordered[0]?.id ?? null);

  const onTileKey = (panel: PanelSpec) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || drag.current) return;
    const dir = ARROWS[e.key];
    // Most modifiers first: `pressed` lets a plain arrow shortcut match with Shift (F6).
    if (dir && pressed("panelResize", e)) {
      e.preventDefault();
      refocus.current = panel.id;
      act({ type: "grow", id: panel.id, dir }, resizedWords(panel.id));
    } else if (dir && pressed("panelMove", e)) {
      e.preventDefault();
      refocus.current = panel.id;
      act({ type: "nudge", id: panel.id, dir }, movedWords(panel.id));
    } else if (dir && pressed("panelFocus", e)) {
      e.preventDefault();
      const to = neighbour(panels, panel.id, dir);
      if (to) {
        setCurrent(to);
        focusTile(to);
      }
    } else if (pressed("panelSettings", e)) {
      e.preventDefault();
      act({ type: "select", id: panel.id });
      act({ type: "sideTab", tab: "query" });
      openSettings(panel.id, "tab");
    } else if (isDeleteKey(e)) {
      e.preventDefault();
      remove(panel, panels);
    } else if (pressed("panelLeave", e)) {
      e.preventDefault();
      editor.onLeave();
    }
  };

  const shown = (panel: PanelSpec): Layout => {
    if (!preview) return panel.layout;
    if (preview.kind === "move" && preview.id === panel.id) return panel.layout;
    return preview.panels.find((p) => p.id === panel.id)?.layout ?? panel.layout;
  };

  const handle = (panel: PanelSpec, kind: Drag["kind"]) => (
    <button type="button" tabIndex={-1} className={kind === "move" ? s.grab : s.corner}
      aria-label={`${kind === "move" ? "Move" : "Resize"} ${panelName(panel)}`}
      aria-keyshortcuts={kind === "move" ? "Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown" : "Control+Shift+ArrowRight Control+Shift+ArrowDown"}
      onPointerDown={startDrag(panel, kind)} onPointerMove={moveDrag} onPointerUp={endDrag}
      onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
      onClick={() => { if (!drag.current) focusTile(panel.id); }}>
      <span aria-hidden="true">{kind === "move" ? "⋮⋮" : ""}</span>
    </button>
  );

  const addAt = freeSpot(preview ? preview.panels : panels, ADD_SIZE.w, ADD_SIZE.h);
  const selected = panelIn(state, state.selected);

  return {
    layoutOf: shown,
    tile: (panel) => ({
      label: tileLabel(panel, preview?.id === panel.id ? preview.target : shown(panel)),
      tabIndex: panel.id === roving ? 0 : -1,
      selected: state.selected === panel.id,
      dragging: preview?.id === panel.id,
      offset: preview?.id === panel.id ? preview.offset : null,
      onKeyDown: onTileKey(panel),
      onFocus: () => setCurrent(panel.id),
      grab: handle(panel, "move"),
      corner: handle(panel, "resize"),
    }),
    layer: (
      <>
        {preview && <div data-testid="drop-target" className={s.target} style={cellStyle(preview.target)} aria-hidden="true" />}
        <AddPanelTile at={addAt} size={ADD_SIZE} onAdd={add} />
      </>
    ),
    aside: settings.open && selected
      ? <PanelSettings key={selected.id} panel={selected} focus={settings.focus} seq={settings.seq} dispatch={editor.dispatch} onClose={closeSettings} />
      : null,
    live: <p className={s.live} role="status" aria-live="polite">{message}</p>,
  };
}

/**
 * The selected panel's settings, beside the grid: its queries for now. The full side panel
 * (Query, Chart, Options, Alert) replaces this.
 */
function PanelSettings({ panel, focus, seq, dispatch, onClose }: {
  panel: PanelSpec;
  focus: Settings["focus"];
  seq: number;
  dispatch(action: EditorAction): void;
  onClose(): void;
}) {
  const base = useId();
  const tab = useRef<HTMLButtonElement>(null);
  const fields = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (focus === "query") fields.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    else tab.current?.focus();
  }, [focus, seq]);
  const setExpr = (ref: string, expr: string) => dispatch({
    type: "updatePanel", id: panel.id,
    update: (p) => ({ ...p, queries: p.queries.map((q) => (q.ref === ref ? { ...q, expr } : q)) }),
  });
  return (
    <aside className={s.settings} aria-label="Panel settings" onKeyDown={escapeCloses(onClose)}>
      <div className={s.settingsHead}>
        <h2 className={s.settingsTitle}>{panelName(panel)}</h2>
        <button type="button" className={s.close} aria-label="Close panel settings" onClick={onClose}><span aria-hidden="true">✕</span></button>
      </div>
      <div role="tablist" aria-label="Panel settings" className={s.tabs}>
        <button ref={tab} id={`${base}-tab`} type="button" role="tab" aria-selected="true" aria-controls={`${base}-panel`} className={s.tab}>Query</button>
      </div>
      <div ref={fields} id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab`} className={s.fields}>
        {panel.queries.map((q) => (
          <label key={q.ref} className={s.field}>
            <span className={s.fieldLabel}>Query {q.ref}</span>
            <textarea className={s.query} spellCheck={false} rows={3} value={q.expr} onChange={(e) => setExpr(q.ref, e.target.value)} />
          </label>
        ))}
      </div>
    </aside>
  );
}
