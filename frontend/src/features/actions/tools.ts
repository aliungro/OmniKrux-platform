import type { ShortcutId } from "../chrome/shortcuts";

/** The change tools the details offer; each but rollback has a key in the shortcuts registry. */
export type ToolId = Extract<ShortcutId, "edit" | "scale" | "restart" | "cordon" | "uncordon" | "drain" | "nodeShell" | "delete"> | "rollback";

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
  delete: "Delete",
};

/**
 * The tools a kind has, in the order the details show them. Edit needs the `update` verb and is
 * never offered for a Secret (its values never reach the browser); Delete needs `delete`.
 */
export function toolsFor(kindKey: string, verbs: readonly string[]): ToolId[] {
  if (READ_ONLY.has(kindKey)) return [];
  const tools: ToolId[] = [];
  if (verbs.includes("update") && kindKey !== "secrets") tools.push("edit");
  if (SCALABLE.has(kindKey)) tools.push("scale");
  if (RESTARTABLE.has(kindKey)) tools.push("restart");
  if (kindKey === "deployments.apps") tools.push("rollback");
  if (kindKey === "nodes") tools.push("cordon", "uncordon", "drain", "nodeShell");
  if (verbs.includes("delete")) tools.push("delete");
  return tools;
}

/** The tools with a key, as registry ids (rollback has none). */
export function keyedTools(tools: readonly ToolId[]): ShortcutId[] {
  return tools.filter((t): t is Exclude<ToolId, "rollback"> => t !== "rollback");
}
