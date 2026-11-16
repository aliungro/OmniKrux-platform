import { APPS } from "../shell/apps";
/**
 * The one list of keyboard shortcuts. The table reads its row keys here, the inspector its tool
 * keys, the palette its keycaps, the dock and the log pane their keys, the shortcut bar its strip
 * and the "?" sheet every group. A key can mean something else on another kind (`s` is a shell on
 * a pod, scale on a deployment, a node shell on a node), so row keys name their kinds. Keys typed
 * in a field, the editor or a terminal are never shortcuts (`isEditable`).
 */

export type ShortcutId =
  | "apps" | "newTab" | "closeTab" | "nextTab" | "previousTab" | "back" | "forward"
  | "move"
  | "moveKind"
  | "details"
  | "close"
  | "yaml"
  | "edit"
  | "delete"
  | "logs"
  | "previousLogs"
  | "shell"
  | "portForward"
  | "scale"
  | "restart"
  | "workloadLogs"
  | "cordon"
  | "uncordon"
  | "drain"
  | "nodeShell"
  | "reveal"
  | "filter"
  | "kinds"
  | "palette"
  | "help"
  | "searchLogs"
  | "nextMatch"
  | "previousMatch"
  | "jumpLive"
  | "layout"
  | "closeLog"
  | "leaveLogs"
  | "sessionTabs";

export interface Shortcut {
  id: ShortcutId;
  /** As drawn on the keycaps. */
  keys: string[];
  /** For the "?" sheet. */
  label: string;
  /**
   * Where it works: on a table row (and in its open details), anywhere on the page, in a log pane,
   * or in the dock. Also the "?" sheet's group.
   */
  scope: "row" | "global" | "logs" | "dock" | "shell";
  /** The kinds it acts on; absent: every kind (a row key still needs the row to offer it). */
  kinds?: string[];
  /** `KeyboardEvent.key` values that trigger it, where something reads them from here. */
  match?: string[];
  /** `KeyboardEvent.code` values that trigger it too (Ctrl \ on layouts where \ needs AltGr). */
  code?: string[];
  /** Needs Ctrl (or Cmd) held; every other shortcut works only without them. */
  ctrl?: boolean;
  /** Needs Alt held exactly; Ctrl+Alt (AltGr) never matches an Alt-only shortcut. */
  alt?: boolean;
  /** For the strip along the bottom; absent: sheet only. */
  bar?: string;
}

const SCALABLE = ["deployments.apps", "statefulsets.apps", "replicasets.apps"];
const RESTARTABLE = ["deployments.apps", "statefulsets.apps", "daemonsets.apps"];

export const SHORTCUTS: readonly Shortcut[] = [
  { id:"apps",scope:"shell",keys:["Alt 1–9"],label:`Switch app (${APPS.map(a=>`${a.label} ${a.key}`).join(", ")})`,alt:true },
  { id:"newTab",scope:"shell",keys:["Alt T"],label:"New tab",code:["KeyT"],alt:true },
  { id:"closeTab",scope:"shell",keys:["Alt W"],label:"Close tab",code:["KeyW"],alt:true },
  { id:"nextTab",scope:"shell",keys:["Alt PgDn"],label:"Next tab",match:["PageDown"],alt:true },
  { id:"previousTab",scope:"shell",keys:["Alt PgUp"],label:"Previous tab",match:["PageUp"],alt:true },
  { id:"back",scope:"shell",keys:["Alt ←"],label:"Back in this tab",match:["ArrowLeft"],alt:true },
  { id:"forward",scope:"shell",keys:["Alt →"],label:"Forward in this tab",match:["ArrowRight"],alt:true },
  { id:"moveKind",scope:"shell",keys:["←","→"],label:"Move between kinds",match:["ArrowLeft","ArrowRight"] },
  // Rows: moving and the details, on every kind.
  { id: "move", scope: "row", keys: ["↑", "↓"], match: ["ArrowUp", "ArrowDown"], label: "Move between rows", bar: "move" },
  { id: "details", scope: "row", keys: ["Enter"], match: ["Enter", "d"], label: "Open or close the details (d too)", bar: "details" },
  { id: "close", scope: "row", keys: ["Esc"], match: ["Escape"], label: "Close the details" },
  { id: "yaml", scope: "row", keys: ["y"], match: ["y"], label: "Open the details on the YAML tab" },
  { id: "edit", scope: "row", keys: ["e"], match: ["e"], label: "Edit the YAML" },
  { id: "delete", scope: "row", keys: ["Ctrl D"], match: ["d", "D"], ctrl: true, label: "Delete" },
  // Rows: what each kind's keys mean.
  { id: "logs", scope: "row", kinds: ["pods"], keys: ["l"], match: ["l"], label: "Logs of the selected pod", bar: "logs" },
  { id: "previousLogs", scope: "row", kinds: ["pods"], keys: ["p"], match: ["p"], label: "Previous logs (the run before the last restart)", bar: "previous logs" },
  { id: "shell", scope: "row", kinds: ["pods"], keys: ["s"], match: ["s"], label: "Shell in the selected pod", bar: "shell" },
  { id: "scale", scope: "row", kinds: SCALABLE, keys: ["s"], match: ["s"], label: "Scale", bar: "scale" },
  { id: "restart", scope: "row", kinds: RESTARTABLE, keys: ["r"], match: ["r"], label: "Restart every pod", bar: "restart" },
  { id: "workloadLogs", scope: "row", kinds: RESTARTABLE, keys: ["l"], match: ["l"], label: "Logs of all its pods", bar: "logs" },
  { id: "portForward", scope: "row", kinds: ["pods", "services"], keys: ["f"], match: ["f"], label: "Port-forward", bar: "port-forward" },
  { id: "cordon", scope: "row", kinds: ["nodes"], keys: ["c"], match: ["c"], label: "Cordon the node", bar: "cordon" },
  { id: "uncordon", scope: "row", kinds: ["nodes"], keys: ["u"], match: ["u"], label: "Uncordon the node" },
  { id: "drain", scope: "row", kinds: ["nodes"], keys: ["r"], match: ["r"], label: "Drain the node", bar: "drain" },
  { id: "nodeShell", scope: "row", kinds: ["nodes"], keys: ["s"], match: ["s"], label: "Shell on the node", bar: "node shell" },
  // Ruling R38: on a secret's row, x opens the Describe tab on its first key; on a key, x reveals it.
  { id: "reveal", scope: "row", kinds: ["secrets"], keys: ["x"], match: ["x"], label: "Go to the secret's keys, then reveal the focused one", bar: "reveal" },
  // Anywhere outside a field, the editor or a terminal.
  { id: "kinds", scope: "global", keys: [":"], match: [":"], label: "Jump to any kind", bar: "kinds" },
  { id: "palette", scope: "global", keys: ["Ctrl K"], match: ["k", "K"], ctrl: true, label: "Commands: kinds, views and the selected row's actions", bar: "commands" },
  { id: "filter", scope: "global", keys: ["/"], match: ["/"], label: "Filter rows", bar: "filter" },
  { id: "help", scope: "global", keys: ["?"], match: ["?"], label: "Show all shortcuts" },
  // In a log pane.
  { id: "searchLogs", scope: "logs", keys: ["Ctrl F"], match: ["f", "F"], ctrl: true, label: "Search logs", bar: "search logs" },
  { id: "nextMatch", scope: "logs", keys: ["Enter"], label: "Next match" },
  { id: "previousMatch", scope: "logs", keys: ["Shift", "Enter"], label: "Previous match" },
  { id: "jumpLive", scope: "logs", keys: ["G"], match: ["G"], label: "Jump to live" },
  // In the dock.
  { id: "closeLog", scope: "dock", keys: ["Esc"], match: ["Escape"], label: "Close the focused log" },
  { id: "leaveLogs", scope: "dock", keys: ["Alt ↑"], match: ["ArrowUp"], alt: true, label: "Return to the workspace" },
  { id: "layout", scope: "dock", keys: ["Ctrl \\"], match: ["\\"], code: ["Backslash"], ctrl: true, label: "Switch the bottom dock between one pane and side by side" },
  { id: "sessionTabs", scope: "dock", keys: ["←", "→"], label: "Move between open logs and shells (bottom dock)" },
];

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

function byId(id: ShortcutId): Shortcut {
  return BY_ID.get(id)!;
}

/** Whether a shortcut acts on rows of this kind. */
function appliesTo(s: Shortcut, kindKey: string): boolean {
  return s.kinds === undefined || s.kinds.includes(kindKey);
}

/** Every shortcut that means something while this kind is on screen, in the registry's order. */
export function shortcutsFor(kindKey: string): Shortcut[] {
  return SHORTCUTS.filter((s) => appliesTo(s, kindKey));
}

/** The strip along the bottom: moving and details, this kind's keys, then the page's own. */
const BAR_TAIL: ShortcutId[] = ["searchLogs", "kinds", "palette", "filter"];

export function barFor(kindKey: string): Shortcut[] {
  const rows = shortcutsFor(kindKey).filter((s) => s.scope === "row" && s.bar !== undefined);
  return [...rows, ...BAR_TAIL.map(byId)];
}

export type ShortcutGroup = readonly [title: string, rows: readonly Shortcut[]];

const GROUP_TITLES: Record<Shortcut["scope"], string> = { shell:"Apps and tabs", row: "Rows", global: "Anywhere", logs: "Logs", dock: "Logs and shells (bottom dock)" };

/** The "?" sheet: every group, each with its shortcuts; `kindKey` narrows the row keys to that kind's. */
export function allGroups(kindKey?: string): ShortcutGroup[] {
  return (["shell", "row", "global", "logs", "dock"] as const).map((scope) => [
    GROUP_TITLES[scope],
    SHORTCUTS.filter((s) => s.scope === scope && (kindKey === undefined || appliesTo(s, kindKey))),
  ]);
}

/** Every group with every shortcut, whatever the kind. */
export const ALL_GROUPS: readonly ShortcutGroup[] = allGroups();

type Pressed = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey?: boolean };

/** Match the key or physical code, with Alt and Ctrl (or Cmd) held exactly when required. */
export function pressed(id: ShortcutId, e: Pressed): boolean {
  const s = byId(id);
  if (e.altKey !== !!s.alt || !!s.ctrl !== (e.ctrlKey || e.metaKey) || (s.alt && e.shiftKey)) return false;
  return (s.match?.includes(e.key) ?? false) || (e.code !== undefined && (s.code?.includes(e.code) ?? false));
}

/**
 * The row shortcut a key press means on a row of this kind, among the actions the row offers
 * (`available`); moving and closing are always there. `s` scales a deployment and opens a shell in
 * a pod: only one of them is ever available.
 */
export function rowShortcut(e: Pressed, kindKey: string, available: readonly string[]): ShortcutId | undefined {
  return SHORTCUTS.find(
    (s) =>
      s.scope === "row" &&
      appliesTo(s, kindKey) &&
      (s.id === "move" || s.id === "close" || available.includes(s.id)) &&
      pressed(s.id, e),
  )?.id;
}

/**
 * The change tool a key press means, among the tools the open details offer (`r` restarts a
 * deployment and drains a node). Ctrl D is the one with a modifier.
 */
export function toolShortcut(e: Pressed, available: readonly ShortcutId[]): ShortcutId | undefined {
  return available.find((id) => pressed(id, e));
}

/** The keycaps drawn for a shortcut, e.g. ["Ctrl D"]. */
export function capsOf(id: ShortcutId): readonly string[] {
  return byId(id).keys;
}

/** A terminal (xterm): every key typed there is the shell's, Ctrl K and Ctrl F included. */
export function inTerminal(el: EventTarget | null): boolean {
  return el instanceof Element && el.closest(".xterm") !== null;
}

/** Keys typed into a field, the YAML editor (contenteditable) or a terminal belong to it. */
export function isEditable(el: EventTarget | null): boolean {
  if (inTerminal(el)) return true;
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.isContentEditable || el.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !== null;
}

/** Whether a page-wide key may act: not typed into something, not under a modal dialog. */
export function pageKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || isEditable(e.target) || isEditable(document.activeElement)) return false;
  return document.querySelector('[aria-modal="true"]') === null;
}
