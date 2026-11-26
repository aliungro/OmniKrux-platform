// The words of Grafana connections: where one is, its sign-in, a test's answer and the rules the
// backend checks (the same copy, so a refusal reads the same before and after it is sent).
import type { GrafanaAuth, GrafanaIn, GrafanaOut, GrafanaTestOut } from "./api";

export const AUTH_LABELS: Record<GrafanaAuth, string> = {
  none: "None",
  bearer: "Service account token",
  basic: "User name and password",
};

export const ADDRESS_EXAMPLE = "http://grafana.example:3000";
export const KEEP_SECRET = "Saved. Leave empty to keep it.";
export const CLUSTER_ANONYMOUS = "A Grafana reached through its cluster is read without a sign-in (anonymous access).";
export const NO_ANSWER = "Grafana didn't answer. Check the address and sign-in, then test again.";
export const DISCARD_CONNECTION = "Discard this Grafana connection?";
/** F15: an import takes at most this many dashboards. */
export const MAX_PICK = 100;
export const PICK_LIMIT = `Pick up to ${MAX_PICK} dashboards at a time.`;
export const NO_MATCH = "No dashboard matches. Try other words.";
export const GRAFANA_GONE = "That Grafana connection no longer exists.";

/** Why an edit can't be tested yet: the saved test would check the old settings, and the stored secret can't travel. */
export const RETYPE_TO_TEST: Record<"bearer" | "basic", string> = {
  bearer: "Type the token again to test these changes, or save them and use Test on its row.",
  basic: "Type the password again to test these changes, or save them and use Test on its row.",
};

// The backend's own refusals (`transfer/api.py`), word for word.
export const URL_RULE = "Use an http or https address with a host, like http://grafana.example:3000.";
export const CLUSTER_PICK = "Pick the cluster, namespace, service and port.";
export const TOKEN_NEEDED = "A service account token is needed.";
export const BASIC_NEEDS = "Basic sign-in needs a user name and a password.";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const dashboardsWord = (n: number) => plural(n, "dashboard", "dashboards");

/** Where a Grafana is reached: its address, or `<cluster> · <namespace>/<service>:<port>`. */
export function grafanaWhere(g: GrafanaOut | GrafanaIn, clusterName?: string): string {
  if (g.reach === "url") return g.url ?? "";
  const named = "cluster_name" in g ? g.cluster_name : null;
  const cluster = clusterName ?? named ?? g.cluster_id ?? "cluster";
  return `${cluster} · ${g.namespace ?? ""}/${g.service ?? ""}:${g.port ?? ""}`;
}

/** A connection in a list of choices: its name, then where. A cluster's name is in the connection's own name, so only the service follows. */
export function connectionLabel(g: GrafanaOut): string {
  if (g.reach === "url") return `${g.name} · ${g.url ?? ""}`;
  return `${g.name} · ${g.namespace ?? ""}/${g.service ?? ""}:${g.port ?? ""}`;
}

/** What starts in the in-cluster fields (where Grafana's own chart puts it). */
export const CLUSTER_DEFAULTS = { namespace: "monitoring", service: "grafana", port: "80" } as const;
export const enterWords = (field: "namespace" | "service" | "port") => `Enter the ${field}.`;
export const sameGrafanaWords = (name: string) => `${name} already connects to this Grafana.`;
export const handOverWords = (other: string) => `Dashboards imported from it can update from ${other} instead.`;

/** A test's answer in words, and whether it connected. */
export function testWords(out: GrafanaTestOut): { ok: boolean; text: string } {
  if (out.ok) return { ok: true, text: `Connected · Grafana ${out.version ?? "unknown"} · ${dashboardsWord(out.dashboards ?? 0)}` };
  return { ok: false, text: out.message ?? NO_ANSWER };
}

export const importedWords = (n: number) => `${dashboardsWord(n)} imported`;
