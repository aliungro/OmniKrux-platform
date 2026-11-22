// Edit mode on the panel grid (E2): every panel is a tile you can move and resize by pointer or
// keyboard, "+ Add panel" sits in the free space, and the selected panel's settings open beside
// the grid. The grid itself stays `DashboardGrid`, so panels keep running (and keep their data)
// when edit mode starts or ends. Tile props are kept per panel while nothing a tile shows changes,
// so an edit re-renders only the panel it touched (D1).
import {
  useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState,
  type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject,
} from "react";
import { isDeleteKey, pressed } from "../../../features/chrome/shortcuts";
import { freeSpot, neighbour, placePanel, type Dir } from "../layout";
import type { DashboardOwner } from "../runPanel";
import { GRID_COLUMNS, type Layout, type OwnerKind, type PanelSpec } from "../schema";
import { pageLetter } from "../page/keys";
import { AddPanelTile, cellStyle } from "./AddPanelTile";
import { editorReducer, isDraftEdit, JSON_FIRST, type EditingState, type EditorAction } from "./editorState";
import { panelName, SidePanel, type PanelLive } from "./SidePanel";
import s from "./EditableGrid.module.css";

export interface GridEditor {
  state: EditingState;
  dispatch(action: EditorAction): void;
  /** Esc on a tile (settings closed): the keyboard goes to Save dashboard. */
  onLeave(): void;
  ownerKind: OwnerKind;
}

/** What `PanelFrame` needs to be a tile. The same object while nothing it shows changes. */
export interface TileProps {
  label: string;
  tabIndex: 0 | -1;
  selected: boolean;
  dragging: boolean;
  /** How far a dragged tile follows the pointer, in px. */
  offset: { x: number; y: number } | null;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
  onFocus(): void;
  /** A click on the tile itself (not on something in it) opens its settings. */
  onClick(e: MouseEvent<HTMLElement>): void;
  /** The panel's run, for the side panel's run line and Ctrl+Enter; null when it goes away. */
  report(id: string, live: PanelLive | null): void;
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
  /** M2's Empty panel: a time series in the first free 12 by 8 spot, settings open on Query A. */
  addEmpty(): void;
  /** Says `text` in the live region. */
  announce(text: string): void;
  /** Puts the keyboard on a panel's tile (it becomes the one in the Tab order); the tile, if found. */
  focusPanel(id: string): HTMLElement | null;
}

export interface GridOptions {
  /**
   * "+ Add panel" and `a` call this (with what had the keyboard, or the tile) instead of adding
   * an empty panel themselves: the page opens its search.
   */
  onAddPanel?(opener: HTMLElement | null): void;
}

const GAP = 10;
const ROW_PITCH = 30 + GAP;
const ADD_SIZE = { w: 12, h: 8 };
const ARROWS: Readonly<Record<string, Dir>> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

const tileLabel = (p: PanelSpec, l: Layout) => `${panelName(p)}, ${l.w} by ${l.h}, column ${l.x + 1}, row ${l.y + 1}`;
const sameLayout = (a: Layout, b: Layout) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
/** Something inside a tile that takes its own clicks. */
const OWN_CLICKS = "button, a, input, select, textarea, [role='button'], [tabindex]:not([tabindex='-1'])";

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
type Settings = { open: boolean; focus: "tab" | "query" | "none"; seq: number };
/** The tile handlers, rebuilt each render; tiles call them through a ref so their props stay the same. */
type Handlers = {
  key(id: string, e: KeyboardEvent<HTMLElement>): void;
  click(id: string, e: MouseEvent<HTMLElement>): void;
  down(id: string, kind: Drag["kind"], e: PointerEvent<HTMLButtonElement>): void;
  move(e: PointerEvent<HTMLButtonElement>): void;
  up(e: PointerEvent<HTMLButtonElement>, apply: boolean): void;
};

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
export function useEditableGrid(
  editor: GridEditor | null, gridRef: RefObject<HTMLDivElement | null>, owner: DashboardOwner | null = null, options: GridOptions = {},
): GridEditing | null {
  const editing = editor !== null;
  const latest = useRef(editor);
  latest.current = editor;
  const onAddPanel = useRef(options.onAddPanel);
  onAddPanel.current = options.onAddPanel;
  const [current, setCurrent] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>({ open: false, focus: "tab", seq: 0 });
  const settingsOpen = useRef(settings.open);
  settingsOpen.current = settings.open;
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const drag = useRef<Drag | null>(null);
  /** A tile id (or "add") to put the keyboard on after the next render. */
  const refocus = useRef<string | null>(null);
  const handlers = useRef<Handlers | null>(null);
  const tiles = useRef(new Map<string, { sig: string; tile: TileProps }>());

  // Each panel's run as its frame reports it; the side panel re-renders when the selected one's changes.
  const lives = useRef(new Map<string, PanelLive>());
  const [, liveChanged] = useReducer((n: number) => n + 1, 0);
  const report = useCallback((id: string, live: PanelLive | null) => {
    if (live) lives.current.set(id, live);
    else lives.current.delete(id);
    if (latest.current?.state.selected === id) liveChanged();
  }, []);

  const findTile = useCallback((id: string) => {
    const root = gridRef.current;
    if (!root) return null;
    return (id === "add"
      ? root.querySelector<HTMLElement>("[data-add-tile]")
      : Array.from(root.querySelectorAll<HTMLElement>("[data-tile-id]")).find((t) => t.dataset.tileId === id)) ?? null;
  }, [gridRef]);
  const focusTile = useCallback((id: string) => {
    const el = findTile(id);
    el?.focus({ preventScroll: false });
    return !!el;
  }, [findTile]);
  const focusPanel = useCallback((id: string) => {
    setCurrent(id);
    const el = findTile(id);
    el?.focus({ preventScroll: false });
    return el;
  }, [findTile]);
  const announce = useCallback((text: string) => setMessage(text), []);

  /**
   * While the JSON tab holds text that doesn't apply, edits here are refused (they would drop it)
   * and the live region says why. True: refused.
   */
  const jsonBlocks = useCallback((action: EditorAction) => {
    const ed = latest.current;
    if (!ed || ed.state.jsonText === null || !isDraftEdit(action)) return false;
    setMessage(JSON_FIRST);
    return true;
  }, []);
  /** The settings' dispatch: the same refusal. */
  const settingsDispatch = useCallback((action: EditorAction) => {
    if (!jsonBlocks(action)) latest.current?.dispatch(action);
  }, [jsonBlocks]);

  /** Dispatches `action` and says what it did; returns the state it makes. */
  const act = useCallback((action: EditorAction, say?: (next: EditingState) => string | null) => {
    const ed = latest.current;
    if (!ed || jsonBlocks(action)) return null;
    const next = editorReducer(ed.state, action);
    ed.dispatch(action);
    if (next.mode !== "edit") return null;
    if (say && next !== ed.state) {
      const words = say(next);
      if (words) setMessage(words);
    }
    return next;
  }, [jsonBlocks]);

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

  /** The Add tile and `a`: the page's search when it has one, else an empty panel. */
  const openAdd = useCallback((opener: HTMLElement | null) => {
    const open = onAddPanel.current;
    if (open) open(opener);
    else add();
  }, [add]);

  const remove = (panel: PanelSpec, panels: PanelSpec[]) => {
    if (jsonBlocks({ type: "removePanel", id: panel.id })) return;
    const to = (["right", "left", "down", "up"] as const).map((d) => neighbour(panels, panel.id, d)).find((id) => id !== null) ?? null;
    refocus.current = to ?? "add";
    setCurrent(to);
    if (latest.current?.state.selected === panel.id) setSettings((was) => ({ ...was, open: false }));
    act({ type: "removePanel", id: panel.id }, () => `Removed "${panelName(panel)}". Discard brings it back.`);
  };

  /** Closes the settings; the keyboard goes to the selected tile, which keeps its highlight. */
  const closeSettings = useCallback(() => {
    setSettings((was) => ({ ...was, open: false }));
    const id = latest.current?.state.selected;
    if (id) {
      setCurrent(id);
      focusTile(id);
    }
  }, [focusTile]);

  // --- pointer: move by the ⋮⋮ handle, resize by the corner --------------------------------------

  const finish = useCallback((d: Drag, apply: boolean) => {
    drag.current = null;
    window.removeEventListener("keydown", d.onEscape, true);
    try { d.handle.releasePointerCapture?.(d.pointer); } catch { /* already released */ }
    setPreview(null);
    refocus.current = d.id;
    focusTile(d.id);
    // Back where it started (or clamped there): nothing to place and nothing to say.
    const landed = placePanel(d.panels, d.id, d.to).find((p) => p.id === d.id)?.layout ?? d.start;
    if (apply && !sameLayout(landed, d.start)) {
      act({ type: "place", id: d.id, to: d.to }, d.kind === "move" ? movedWords(d.id) : resizedWords(d.id));
    }
  }, [act, focusTile]);

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
      tiles.current.clear();
    }
    wasEditing.current = editing;
  }, [editing]);

  // The settings went away with the keyboard in them (their panel left the draft): it goes to a tile.
  const asideShown = editing && settings.open && editor !== null && panelIn(editor.state, editor.state.selected) !== undefined;
  const hadAside = useRef(asideShown);
  useLayoutEffect(() => {
    const lost = () => { const a = document.activeElement; return a === null || a === document.body || !a.isConnected; };
    if (hadAside.current && !asideShown && editing && refocus.current === null && lost()) {
      const ed = latest.current;
      const first = ed ? [...ed.state.draft.panels].sort(byReading)[0] : undefined;
      refocus.current = ed?.state.selected && panelIn(ed.state, ed.state.selected) ? ed.state.selected : (first?.id ?? "add");
    }
    hadAside.current = asideShown;
  }, [asideShown, editing]);

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
      // Esc in the search goes back to what had the keyboard: a tile, or else the Add tile.
      const had = document.activeElement;
      const opener = had instanceof HTMLElement && had !== document.body && had.isConnected ? had : findTile("add");
      openAdd(opener);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing, openAdd, findTile]);

  if (!editor) return null;
  const { state } = editor;
  const panels = state.draft.panels;
  const ordered = [...panels].sort(byReading);
  const has = (id: string | null) => id !== null && panels.some((p) => p.id === id);
  const roving = has(current) ? current : has(state.selected) ? state.selected : (ordered[0]?.id ?? null);

  handlers.current = {
    key(id, e) {
      const panel = panelIn(state, id);
      if (!panel || e.target !== e.currentTarget || drag.current) return;
      const dir = ARROWS[e.key];
      // Most modifiers first: `pressed` lets a plain arrow shortcut match with Shift (F6).
      if (dir && pressed("panelResize", e)) {
        e.preventDefault();
        refocus.current = id;
        act({ type: "grow", id, dir }, resizedWords(id));
      } else if (dir && pressed("panelMove", e)) {
        e.preventDefault();
        refocus.current = id;
        act({ type: "nudge", id, dir }, movedWords(id));
      } else if (dir && pressed("panelFocus", e)) {
        e.preventDefault();
        const to = neighbour(panels, id, dir);
        if (to) {
          setCurrent(to);
          focusTile(to);
        }
      } else if (pressed("panelSettings", e)) {
        e.preventDefault();
        act({ type: "select", id });
        act({ type: "sideTab", tab: "query" });
        openSettings(id, "tab");
      } else if (isDeleteKey(e)) {
        e.preventDefault();
        remove(panel, panels);
      } else if (pressed("panelLeave", e)) {
        e.preventDefault();
        // The settings close first; the next Esc goes to Save dashboard.
        if (settingsOpen.current) setSettings((was) => ({ ...was, open: false }));
        else editor.onLeave();
      }
    },
    click(id, e) {
      if (drag.current || e.button !== 0) return;
      const inner = e.target instanceof Element ? e.target.closest(OWN_CLICKS) : null;
      if (inner && inner !== e.currentTarget) return;
      if (state.selected === id && settingsOpen.current) return;
      act({ type: "select", id });
      openSettings(id, "none");
    },
    down(id, kind, e) {
      const panel = panelIn(state, id);
      if (e.button !== 0 || drag.current || !panel) return;
      e.preventDefault();
      const width = gridRef.current?.getBoundingClientRect().width ?? 0;
      const onEscape = (k: globalThis.KeyboardEvent) => {
        if (k.key !== "Escape" || drag.current === null) return;
        k.preventDefault();
        k.stopPropagation();
        finish(drag.current, false);
      };
      drag.current = {
        id, kind, pointer: e.pointerId, handle: e.currentTarget, startX: e.clientX, startY: e.clientY,
        start: panel.layout, panels, colPitch: width > 0 ? (width + GAP) / GRID_COLUMNS : ROW_PITCH,
        to: panel.layout, onEscape,
      };
      window.addEventListener("keydown", onEscape, true);
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
      setCurrent(id);
    },
    move(e) {
      const d = drag.current?.pointer === e.pointerId ? drag.current : null;
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
    },
    up(e, apply) {
      const d = drag.current?.pointer === e.pointerId ? drag.current : null;
      if (d) finish(d, apply);
    },
  };
  const on = () => handlers.current!;

  const shown = (panel: PanelSpec): Layout => {
    if (!preview) return panel.layout;
    if (preview.kind === "move" && preview.id === panel.id) return panel.layout;
    return preview.panels.find((p) => p.id === panel.id)?.layout ?? panel.layout;
  };

  const handle = (id: string, name: string, kind: Drag["kind"]) => (
    <button type="button" tabIndex={-1} className={kind === "move" ? s.grab : s.corner}
      aria-label={`${kind === "move" ? "Move" : "Resize"} ${name}`}
      aria-keyshortcuts={kind === "move" ? "Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown" : "Control+Shift+ArrowRight Control+Shift+ArrowDown"}
      onPointerDown={(e) => on().down(id, kind, e)} onPointerMove={(e) => on().move(e)} onPointerUp={(e) => on().up(e, true)}
      onPointerCancel={(e) => on().up(e, false)} onLostPointerCapture={(e) => on().up(e, false)}
      onClick={() => { if (!drag.current) focusTile(id); }}>
      <span aria-hidden="true">{kind === "move" ? "⋮⋮" : ""}</span>
    </button>
  );

  /** The tile's props: the same object while its label, place in the Tab order, highlight and drag don't change. */
  const tile = (panel: PanelSpec): TileProps => {
    const id = panel.id;
    const name = panelName(panel);
    const label = tileLabel(panel, preview?.id === id ? preview.target : shown(panel));
    const tabIndex: 0 | -1 = id === roving ? 0 : -1;
    const selected = state.selected === id;
    const dragging = preview?.id === id;
    const offset = dragging ? preview.offset : null;
    const sig = JSON.stringify([name, label, tabIndex, selected, dragging, offset]);
    const kept = tiles.current.get(id);
    if (kept?.sig === sig) return kept.tile;
    const made: TileProps = {
      label, tabIndex, selected, dragging, offset,
      onKeyDown: (e) => on().key(id, e),
      onFocus: () => setCurrent(id),
      onClick: (e) => on().click(id, e),
      report,
      grab: handle(id, name, "move"),
      corner: handle(id, name, "resize"),
    };
    tiles.current.set(id, { sig, tile: made });
    return made;
  };
  for (const id of tiles.current.keys()) if (!has(id)) tiles.current.delete(id);

  const addAt = freeSpot(preview ? preview.panels : panels, ADD_SIZE.w, ADD_SIZE.h);
  const selected = panelIn(state, state.selected);
  const live = selected ? lives.current.get(selected.id) ?? null : null;

  return {
    layoutOf: shown,
    tile,
    layer: (
      <>
        {preview && <div data-testid="drop-target" className={s.target} style={cellStyle(preview.target)} aria-hidden="true" />}
        <AddPanelTile at={addAt} size={ADD_SIZE} onAdd={openAdd} />
      </>
    ),
    aside: settings.open && selected
      ? (
        <SidePanel key={selected.id} state={state} dispatch={settingsDispatch} owner={owner} ownerKind={editor.ownerKind}
          panelData={live?.data ?? null} live={live} initialFocus={settings.focus} seq={settings.seq} onClose={closeSettings} />
      )
      : null,
    live: <p className={s.live} role="status" aria-live="polite">{message}</p>,
    addEmpty: add,
    announce,
    focusPanel,
  };
}
