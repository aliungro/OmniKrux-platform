import { hasCurrentSnapshot, type WatchState } from "../../api/watchState";
import type { Territory } from "../territories/model";

/** Home never interprets retained rows as current health. */
export function currentHealth(territories: Territory[], watch: WatchState): Territory[] {
  return territories.map(t => hasCurrentSnapshot(watch, t.cluster.id) ? t : {
    ...t, state: t.state === "ready" ? "syncing" : t.state, rows: [], total: 0, failing: 0, pending: 0,
  });
}

export function connectionProblem(t: Territory): string | null {
  if (t.state === "absent") return "Pods unavailable";
  if (t.state !== "error" && !(t.state === "syncing" && t.message)) return null;
  const reason = t.cluster.source === "cloud"
    ? cloudCause(t.message) ?? "Connection unavailable"
    : `Can't reach it: ${t.message ?? "Connection unavailable"}`;
  return t.state === "syncing" ? `Retrying connection. ${reason}` : reason;
}

// A URL, an IPv4 address or a host:port. The backend already words cloud errors without the
// private endpoint (Plan 5 R48); this second check keeps one that slips through off screen.
const ADDRESS = /:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[\w-]+(?:\.[\w-]+)+:\d+/;

/** A cloud cluster's reason, shown only when it names no address. "Retrying — " is dropped:
 * the Home copy already says it is retrying. */
function cloudCause(message: string | null): string | null {
  const cause = message?.replace(/^Retrying — /, "").trim();
  return cause && !ADDRESS.test(cause) ? cause : null;
}
