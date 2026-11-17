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
  const reason = t.cluster.source === "cloud" ? "Connection unavailable" : `Can't reach it: ${t.message ?? "Connection unavailable"}`;
  return t.state === "syncing" ? `Retrying connection. ${reason}` : reason;
}
