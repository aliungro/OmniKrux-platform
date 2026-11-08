/**
 * The one list of keyboard shortcuts. The table reads its row keys here, the shortcut bar its
 * strip and the "?" sheet every group. Keys typed in a field, the editor or a terminal are never
 * shortcuts (`isEditable`).
 */

export type ShortcutId =
  | "move"
  | "details"
  | "close"
  | "filter"
  | "logs"
  | "previousLogs"
  | "shell"
  | "searchLogs"
  | "nextMatch"
  | "previousMatch"
  | "jumpLive"
  | "layout"
  | "sessionTabs"
  | "help";

export interface Shortcut {
  id: ShortcutId;
  /** Where it works, the "?" sheet's group. */
  group: "Table" | "Logs" | "Dock";
  /** As drawn on the keycaps. */
  keys: string[];
  /** `KeyboardEvent.key` values that trigger it, where something reads them from here. */
  match?: string[];
  /** For the "?" sheet. */
  label: string;
  /** For the strip along the bottom, in this order; absent: sheet only. */
  bar?: string;
  /** Acts on pod rows only (Ruling R14, until per-kind meanings arrive). */
  podsOnly?: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "move", group: "Table", keys: ["↑", "↓"], match: ["ArrowUp", "ArrowDown"], label: "Move between rows", bar: "move" },
  { id: "details", group: "Table", keys: ["Enter"], match: ["Enter", "d"], label: "Open or close the pod's details", bar: "details", podsOnly: true },
  { id: "close", group: "Table", keys: ["Esc"], match: ["Escape"], label: "Close the details" },
  { id: "filter", group: "Table", keys: ["/"], match: ["/"], label: "Filter rows", bar: "filter" },
  { id: "logs", group: "Table", keys: ["l"], match: ["l"], label: "Logs for the selected pod", bar: "logs", podsOnly: true },
  { id: "previousLogs", group: "Table", keys: ["p"], match: ["p"], label: "Previous logs (the run before the last restart)", bar: "previous logs", podsOnly: true },
  { id: "shell", group: "Table", keys: ["s"], match: ["s"], label: "Shell in the selected pod", bar: "shell", podsOnly: true },
  { id: "searchLogs", group: "Logs", keys: ["Ctrl F"], label: "Search logs", bar: "search logs" },
  { id: "nextMatch", group: "Logs", keys: ["Enter"], label: "Next match" },
  { id: "previousMatch", group: "Logs", keys: ["Shift", "Enter"], label: "Previous match" },
  { id: "jumpLive", group: "Logs", keys: ["G"], label: "Jump to live" },
  { id: "layout", group: "Dock", keys: ["Ctrl \\"], label: "Switch between one pane and side by side", bar: "layout" },
  { id: "sessionTabs", group: "Dock", keys: ["←", "→"], label: "Move between session tabs" },
  { id: "help", group: "Dock", keys: ["?"], match: ["?"], label: "Show all shortcuts" },
];

/** The strip's order: the keys you'll use most. */
const BAR_ORDER: ShortcutId[] = ["move", "details", "logs", "previousLogs", "shell", "searchLogs", "layout", "filter"];

export const BAR: readonly Shortcut[] = BAR_ORDER.map((id) => SHORTCUTS.find((s) => s.id === id)!);

export const GROUPS: readonly [group: Shortcut["group"], rows: Shortcut[]][] = (["Table", "Logs", "Dock"] as const).map(
  (g) => [g, SHORTCUTS.filter((s) => s.group === g)],
);

/** The table-row shortcut a key press means, if any (no modifiers). */
export function rowShortcut(key: string): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.group === "Table" && s.match?.includes(key));
}

/** The keys that trigger a shortcut, for listeners outside the table ("/", "?"). */
export function keysOf(id: ShortcutId): readonly string[] {
  return SHORTCUTS.find((s) => s.id === id)?.match ?? [];
}

/** Keys typed into a field (or a terminal) belong to it. */
export function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}
