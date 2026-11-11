import type { ResourceRow } from "../../api/types";
import { shortcutsFor, type ShortcutId } from "../chrome/shortcuts";
import { textColumn } from "../territories/model";

/** The change tools the details offer. Rollback and eviction have no shortcut. */
export type ToolId = Extract<ShortcutId, "edit" | "scale" | "restart" | "cordon" | "uncordon" | "drain" | "nodeShell" | "portForward" | "delete"> | "rollback" | "evict";

const SCALABLE = new Set(["deployments.apps", "statefulsets.apps", "replicasets.apps"]);
const RESTARTABLE = new Set(["deployments.apps", "statefulsets.apps", "daemonsets.apps"]);
/** Helm releases are Helm's Secrets: read-only in Omnikrux (Ruling R10). */
const READ_ONLY = new Set(["helm-releases"]);

export const TOOL_LABEL: Record<ToolId, string> = {
  edit: "Edit",
  scale: "Scale",
  restart: "Restart",
  rollback: "Roll back",
  cordon: "Cordon",
  uncordon: "Uncordon",
  drain: "Drain",
  nodeShell: "Node shell",
  portForward: "Port-forward",
  delete: "Delete",
  evict: "Evict",
};

/**
 * Whether a node row is cordoned: its status says "Ready, SchedulingDisabled" when it is and plain
 * "Ready" when it isn't (backend kind_rows.py). A node that isn't Ready doesn't say: null.
 */
export function cordoned(row: ResourceRow): boolean | null {
  const status = textColumn(row, "status") ?? "";
  if (status.includes("SchedulingDisabled")) return true;
  return status === "Ready" ? false : null;
}

export function canDelete(kindKey: string, verbs: readonly string[]): boolean {
  return !READ_ONLY.has(kindKey) && verbs.includes("delete");
}

/**
 * The tools a kind has, in the order the details show them. Edit needs the `update` verb and is
 * never offered for a Secret (its values never reach the browser); Delete needs `delete`. A node
 * gets the one of Cordon and Uncordon that applies, both when its row can't tell.
 */
export function toolsFor(kindKey: string, verbs: readonly string[], row?: ResourceRow): ToolId[] {
  if (READ_ONLY.has(kindKey)) return [];
  const tools: ToolId[] = [];
  if (verbs.includes("update") && kindKey !== "secrets") tools.push("edit");
  if (SCALABLE.has(kindKey)) tools.push("scale");
  if (RESTARTABLE.has(kindKey)) tools.push("restart");
  if (kindKey === "deployments.apps") tools.push("rollback");
  if (kindKey === "nodes") {
    const state = row ? cordoned(row) : null;
    if (state !== true) tools.push("cordon");
    if (state !== false) tools.push("uncordon");
    tools.push("drain", "nodeShell");
  }
  // Port-forwards read the cluster only (no plan, no diff); each start is audited.
  if (kindKey === "pods" || kindKey === "services") tools.push("portForward");
  if (kindKey === "pods") tools.push("evict");
  if (canDelete(kindKey, verbs)) tools.push("delete");
  return tools;
}

/** The tools with a key, as registry ids. */
export function keyedTools(tools: readonly ToolId[]): ShortcutId[] {
  return tools.filter((t): t is Extract<ToolId, ShortcutId> => t !== "rollback" && t !== "evict");
}

/** Everything a row offers besides its change tools: its details, and the dock's logs and shells. */
export type RowAction = ToolId | Extract<ShortcutId, "details" | "yaml" | "logs" | "previousLogs" | "shell" | "workloadLogs" | "reveal">;

/** What the page can do for a row: plan changes (inside the actions provider), open logs or shells. */
export interface RowCan {
  change: boolean;
  logs: boolean;
  shell: boolean;
  workloadLogs: boolean;
}

/**
 * The actions a row offers, in the order the palette lists them: the details, the kind's logs and
 * shells (as the shortcuts registry gives them to it), then its change tools. Port-forwards need no
 * plan, so they're offered outside the actions provider too.
 */
export function rowActions(kindKey: string, verbs: readonly string[], row: ResourceRow, can: RowCan): RowAction[] {
  const keyed = new Set(shortcutsFor(kindKey).map((x) => x.id));
  const out: RowAction[] = ["details", "yaml"];
  if (can.logs && keyed.has("logs")) out.push("logs", "previousLogs");
  if (can.shell && keyed.has("shell")) out.push("shell");
  if (can.workloadLogs && keyed.has("workloadLogs")) out.push("workloadLogs");
  // A Secret's keys (Ruling R38): its details open on them; revealing one is the next step.
  if (keyed.has("reveal")) out.push("reveal");
  out.push(...toolsFor(kindKey, verbs, row).filter((t) => can.change || t === "portForward"));
  return out;
}
