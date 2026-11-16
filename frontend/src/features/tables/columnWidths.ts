import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

const STORAGE_KEY = "omnikrux.tableColumnWidths";
/** The widest a resize handle grows a column. */
export const MAX_COLUMN_WIDTH = 800;
/**
 * The widest saved width. A responsive column already wider than MAX_COLUMN_WIDTH narrows from
 * its real width, so its saved width can exceed the cap; this only rejects nonsense.
 */
const MAX_SAVED_WIDTH = 8192;
/**
 * The most tables remembered. Every Describe section and custom kind adds one, so the least
 * recently resized go first.
 */
const MAX_TABLES = 100;

type Widths = ReadonlyMap<string, number>;
type Tables = ReadonlyMap<string, Widths>;
const empty: Widths = new Map();
const listeners = new Set<() => void>();
let committed: Tables | undefined;
/** False when the saved store has another version: it is left as it is, and widths stay in memory. */
let writable = true;

function validKey(key: unknown): key is string {
  return typeof key === "string" && key.length <= 2048 && key.trim().length > 0;
}

export function validWidth(width: unknown): width is number {
  return typeof width === "number" && Number.isInteger(width) && width > 0 && width <= MAX_SAVED_WIDTH;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function load(): Tables {
  const tables = new Map<string, Widths>();
  writable = true;
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (record(saved) && saved.version !== 1) writable = false;
    if (!record(saved) || saved.version !== 1 || !record(saved.tables)) return tables;
    for (const [table, columns] of Object.entries(saved.tables)) {
      if (!validKey(table) || !record(columns)) continue;
      const widths = new Map<string, number>();
      for (const [key, width] of Object.entries(columns)) {
        if (validKey(key) && validWidth(width)) widths.set(key, width);
      }
      if (widths.size > 0) tables.set(table, widths);
    }
  } catch {
    // Preferences are optional, including when localStorage is inaccessible.
  }
  return tables;
}

function snapshot(): Tables {
  return committed ??= load();
}

/** Another browser tab saved widths: follow them, as this tab's own commits are. */
function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  committed = load();
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function update(widths: Widths, key: string, width: number | null): Widths {
  if ((widths.get(key) ?? null) === width) return widths;
  const next = new Map(widths);
  if (width === null) next.delete(key);
  else next.set(key, width);
  return next;
}

function save(tableKey: string, key: string, width: number | null) {
  const current = snapshot();
  const widths = current.get(tableKey) ?? empty;
  const next = update(widths, key, width);
  if (widths === next) return;

  const tables = new Map(current);
  // Re-inserted, so the map runs from the least to the most recently resized table.
  tables.delete(tableKey);
  if (next.size > 0) tables.set(tableKey, next);
  for (const oldest of tables.keys()) {
    if (tables.size <= MAX_TABLES) break;
    tables.delete(oldest);
  }
  committed = tables;
  if (writable) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        tables: Object.fromEntries([...tables].map(([table, columns]) => [table, Object.fromEntries(columns)])),
      }));
    } catch {
      // Keep the in-memory preference available to other panes.
    }
  }
  listeners.forEach(listener => listener());
}

export function useColumnWidths(tableKey: string) {
  const getWidths = useCallback(() => snapshot().get(tableKey) ?? empty, [tableKey]);
  const saved = useSyncExternalStore(subscribe, getWidths, () => empty);
  const [draft, setDraft] = useState<{ tableKey: string; widths: Widths }>({ tableKey, widths: empty });
  if (draft.tableKey !== tableKey) setDraft({ tableKey, widths: empty });
  const preview = draft.tableKey === tableKey ? draft.widths : empty;

  const previewWidth = useCallback((key: string, width: number | null) => {
    if (!validKey(tableKey) || !validKey(key) || (width !== null && !validWidth(width))) return;
    setDraft(current => {
      if (current.tableKey !== tableKey) return current;
      const widths = update(current.widths, key, width);
      return widths === current.widths ? current : { tableKey, widths };
    });
  }, [tableKey]);

  const commitWidth = useCallback((key: string, width: number | null) => {
    if (!validKey(tableKey) || !validKey(key) || (width !== null && !validWidth(width))) return;
    previewWidth(key, null);
    save(tableKey, key, width);
  }, [tableKey, previewWidth]);

  const widths = useMemo(() => preview.size === 0 ? saved : new Map([...saved, ...preview]), [saved, preview]);
  return { widths, previewWidth, commitWidth };
}
