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
  | "reveal"
  | "edit"
  | "scale"
  | "restart"
  | "cordon"
  | "uncordon"
  | "drain"
  | "nodeShell"
  | "delete"
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
  group: "Table" | "Details" | "Logs" | "Dock";
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
  /** Needs Ctrl (or Cmd) held; every other shortcut works only without modifiers. */
  ctrl?: boolean;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: "move", group: "Table", keys: ["↑", "↓"], match: ["ArrowUp", "ArrowDown"], label: "Move between rows", bar: "move" },
  { id: "details", group: "Table", keys: ["Enter"], match: ["Enter", "d"], label: "Open or close the details", bar: "details" },
  { id: "close", group: "Table", keys: ["Esc"], match: ["Escape"], label: "Close the details" },
  { id: "filter", group: "Table", keys: ["/"], match: ["/"], label: "Filter rows", bar: "filter" },
  { id: "logs", group: "Table", keys: ["l"], match: ["l"], label: "Logs for the selected pod", bar: "logs", podsOnly: true },
  { id: "previousLogs", group: "Table", keys: ["p"], match: ["p"], label: "Previous logs (the run before the last restart)", bar: "previous logs", podsOnly: true },
  { id: "shell", group: "Table", keys: ["s"], match: ["s"], label: "Shell in the selected pod", bar: "shell", podsOnly: true },
  { id: "reveal", group: "Details", keys: ["x"], match: ["x"], label: "Reveal the focused secret key" },
  // The change tools: on the open row or inside its details, for the kinds that have them.
  { id: "edit", group: "Details", keys: ["e"], match: ["e"], label: "Edit the YAML" },
  { id: "scale", group: "Details", keys: ["s"], match: ["s"], label: "Scale a deployment, stateful set or replica set" },
  { id: "restart", group: "Details", keys: ["r"], match: ["r"], label: "Restart a deployment, stateful set or daemon set" },
  { id: "cordon", group: "Details", keys: ["c"], match: ["c"], label: "Cordon the node" },
  { id: "uncordon", group: "Details", keys: ["u"], match: ["u"], label: "Uncordon the node" },
  { id: "drain", group: "Details", keys: ["r"], match: ["r"], label: "Drain the node" },
  { id: "nodeShell", group: "Details", keys: ["s"], match: ["s"], label: "Shell on the node" },
  { id: "delete", group: "Details", keys: ["Ctrl D"], match: ["d", "D"], ctrl: true, label: "Delete" },
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

export const GROUPS: readonly [group: Shortcut["group"], rows: Shortcut[]][] = (["Table", "Details", "Logs", "Dock"] as const).map(
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

/**
 * The change tool a key press means, among the tools the row's kind has (`r` restarts a
 * deployment and drains a node). Ctrl D is the one with a modifier.
 */
export function toolShortcut(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  available: readonly ShortcutId[],
): ShortcutId | undefined {
  if (e.altKey) return undefined;
  const held = e.ctrlKey || e.metaKey;
  return SHORTCUTS.find((s) => available.includes(s.id) && !!s.ctrl === held && s.match?.includes(e.key))?.id;
}

/** The keycaps drawn for a shortcut, e.g. ["Ctrl D"]. */
export function capsOf(id: ShortcutId): readonly string[] {
  return SHORTCUTS.find((s) => s.id === id)?.keys ?? [];
}

/** Keys typed into a field (or a terminal) belong to it. */
export function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}
