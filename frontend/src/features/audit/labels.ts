import type { AuditRecord, StatusClass } from "../../api/types";

/** What each action reads as in the log, in the order the Action filter offers them. */
export const ACTION_LABELS: readonly (readonly [action: string, label: string])[] = [
  ["scale", "Scaled"],
  ["restart", "Restarted"],
  ["rollback", "Rolled back"],
  ["edit", "Edited"],
  ["delete", "Deleted"],
  ["evict", "Requested an eviction"],
  ["cordon", "Cordoned"],
  ["uncordon", "Uncordoned"],
  ["drain", "Drained"],
  ["shell", "Opened a shell"],
  ["debug_container", "Started a debug container"],
  ["node_shell", "Started a node shell"],
  ["port_forward", "Port-forwarded"],
  ["secret_reveal", "Revealed a secret key"],
  ["cluster_add", "Added a cluster"],
  ["cluster_remove", "Removed a cluster"],
  ["cloud_account_add", "Connected a cloud account"],
  ["cloud_account_remove", "Removed a cloud account"],
];

const BY_ACTION = new Map(ACTION_LABELS);

/** Sentence-case words for an action; one this console doesn't know reads as its own name. */
export function actionLabel(action: string): string {
  const known = BY_ACTION.get(action);
  if (known !== undefined) return known;
  const words = action.replace(/_/g, " ").trim();
  return words === "" ? "Unknown action" : words[0].toUpperCase() + words.slice(1);
}

/** The kind key as one thing: "deployments.apps" -> "deployment". */
export function kindWord(key: string): string {
  const base = key.split(".")[0];
  if (base.endsWith("ies")) return `${base.slice(0, -3)}y`;
  if (base.endsWith("sses")) return base.slice(0, -2);
  return base.endsWith("s") ? base.slice(0, -1) : base;
}

/**
 * What the row acted on. A node shell is a pod of the audit (its kind is `pods`), but the thing
 * that was opened is the node, which the record keeps in its details.
 */
export function whatOf(r: Pick<AuditRecord, "action" | "kind" | "name" | "details">): { kind: string | null; name: string } {
  if (r.kind === "cloud-account") return { kind: "Cloud account", name: r.name ?? "" };
  if (r.action === "node_shell") {
    const node = r.details?.node;
    if (typeof node === "string" && node !== "") return { kind: null, name: `Node ${node}` };
  }
  return { kind: kindWord(r.kind), name: r.name ?? "" };
}

/**
 * How it ended. `ended` (a shell or port-forward that was closed) reads as done, like a success;
 * `started` and `unknown` are the open ring: nothing says it worked.
 */
export function outcomeOf(outcome: string): { label: string; cls: StatusClass } {
  switch (outcome) {
    case "succeeded":
      return { label: "Succeeded", cls: "ok" };
    case "ended":
      return { label: "Ended", cls: "ok" };
    case "failed":
      return { label: "Failed", cls: "bad" };
    case "started":
      return { label: "Started", cls: "warn" };
    default:
      return { label: "Unknown", cls: "warn" };
  }
}

/** The message column: the server's words, or a plain line where a record has none. */
export function messageOf(r: Pick<AuditRecord, "message" | "outcome">): string {
  if (r.message) return r.message;
  if (r.outcome === "started") return "Still in progress.";
  if (r.outcome === "unknown") return "It isn't known how this ended.";
  return "";
}

export type DiffKind = "add" | "remove" | "meta" | "context";

/**
 * A diff line's kind. The server's diff is a unified diff whose file lines are always the first
 * two (`--- before`, `+++ after`), so only those and the `@@` hunk lines are headers: a removed
 * line whose own text starts with `--` is still a removed line.
 */
export function diffKind(line: string, index: number): DiffKind {
  if ((index === 0 && line.startsWith("--- ")) || (index === 1 && line.startsWith("+++ ")) || line.startsWith("@@")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "remove";
  return "context";
}
