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

// The backend's own refusals (`transfer/api.py`, `sources/transport.py`), word for word.
export const URL_RULE = "Use an http or https address with a host, like http://prometheus.example:9090.";
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

/** A test's answer in words, and whether it connected. */
export function testWords(out: GrafanaTestOut): { ok: boolean; text: string } {
  if (out.ok) return { ok: true, text: `Connected · Grafana ${out.version ?? "unknown"} · ${dashboardsWord(out.dashboards ?? 0)}` };
  return { ok: false, text: out.message ?? NO_ANSWER };
}

export const importedWords = (n: number) => `${dashboardsWord(n)} imported`;
