import type { AuditRecord, StatusClass } from "../../api/types";

/** What each action reads as in the log, in the order the Action filter offers them. */
export const ACTION_LABELS: readonly (readonly [action: string, label: string])[] = [
  ["scale", "Scaled"],
  ["restart", "Restarted"],
  ["rollback", "Rolled back"],
  ["edit", "Edited"],
  ["create", "Created"],
  ["install", "Installed"],
  ["uninstall", "Uninstalled"],
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
  ["source_add", "Added a source"],
  ["source_change", "Changed a source"],
  ["source_remove", "Removed a source"],
  ["project_add", "Added a project"],
  ["project_change", "Changed a project"],
  ["project_remove", "Removed a project"],
  ["group_add", "Added a group"],
  ["group_change", "Changed a group"],
  ["group_remove", "Removed a group"],
  ["dashboard_add", "Added a dashboard"],
  ["dashboard_save", "Saved a dashboard"],
  ["dashboard_remove", "Removed a dashboard"],
  ["dashboard_restore", "Restored a dashboard version"],
  ["dashboard_import", "Imported a dashboard"],
  ["dashboard_update", "Updated a dashboard from its source"],
  ["monitoring_export", "Exported from Monitoring"],
  ["grafana_add", "Connected a Grafana"],
  ["grafana_change", "Changed a Grafana connection"],
  ["grafana_remove", "Removed a Grafana connection"],
  ["alert_rule_add", "Added an alert rule"],
  ["alert_rule_change", "Changed an alert rule"],
  ["alert_rule_remove", "Removed an alert rule"],
  ["contact_point_add", "Added a contact point"],
  ["contact_point_change", "Changed a contact point"],
  ["contact_point_remove", "Removed a contact point"],
  ["contact_point_test", "Sent a test message"],
  ["silence_add", "Added a silence"],
  ["silence_remove", "Expired a silence"],
  ["loki_rule_write", "Wrote a Loki rule"],
  ["loki_rule_remove", "Removed a Loki rule"],
];

const BY_ACTION = new Map(ACTION_LABELS);

/** Sentence-case words for an action; one this console doesn't know reads as its own name. */
export function actionLabel(action: string): string {
  const known = BY_ACTION.get(action);
  if (known !== undefined) return known;
  const words = action.replace(/_/g, " ").trim();
  return words === "" ? "Unknown action" : words[0].toUpperCase() + words.slice(1);
}

/** A record's action in words: Monitoring's removal of an already expired silence shares its
 * action with expiring one, and says what it did (its details say so). */
export function recordActionLabel(r: Pick<AuditRecord, "app" | "action" | "details">): string {
  if (r.app === "monitoring" && r.action === "silence_remove" && r.details?.removed_expired === true) return "Removed an expired silence";
  return actionLabel(r.action);
}

/** What Monitoring's records act on, in words (the record's kind key is the object in the singular). */
export const MONITORING_KINDS: Record<string, string> = {
  source: "Source", project: "Project", group: "Group", dashboard: "Dashboard", alert_rule: "Alert rule",
  contact_point: "Contact point", silence: "Silence", loki_rule: "Loki rule", grafana: "Grafana connection",
};

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
export function whatOf(r: Pick<AuditRecord, "app" | "action" | "kind" | "name" | "details">): { kind: string | null; name: string } {
  if (r.kind === "cloud-account") return { kind: "Cloud account", name: r.name ?? "" };
  if (r.action === "node_shell") {
    const node = r.details?.node;
    if (typeof node === "string" && node !== "") return { kind: null, name: `Node ${node}` };
  }
  if (r.app === "monitoring") {
    // Own keys only: a kind such as "constructor" never reads an inherited property.
    const own = (key: string) => (Object.hasOwn(MONITORING_KINDS, key) ? MONITORING_KINDS[key] : undefined);
    const word = own(r.kind) ?? own(kindWord(r.kind));
    if (word !== undefined) return { kind: word, name: r.name ?? "" };
  }
  return { kind: kindWord(r.kind), name: r.name ?? "" };
}

/** The sentence Monitoring wrote for a record that has no diff, or null when it wrote none. */
export function changeOf(r: Pick<AuditRecord, "app" | "details">): string | null {
  if (r.app !== "monitoring") return null;
  const { change, handed_to: handedTo } = r.details ?? {};
  if (typeof change === "string" && change !== "") return change;
  if (typeof handedTo === "string" && handedTo !== "") return `Its imported dashboards were handed to ${handedTo}.`;
  return null;
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
