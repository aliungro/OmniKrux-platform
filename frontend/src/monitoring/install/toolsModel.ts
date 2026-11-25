// What the Monitoring tools page decides from a cluster's status: how each component stands, and
// whether an install can start. Pure, so the page only draws it.
import type { Component, InstallOut, InstallStatusOut, ReleaseOut } from "./api";

export type ComponentState = "missing" | "installed" | "failing" | "busy";

/** The charts (release `chart` keys) that make up each component. */
export const COMPONENT_CHARTS: Record<Component, readonly string[]> = {
  metrics: ["kube-prometheus-stack"],
  logs: ["loki", "alloy"],
};

export const COMPONENTS: readonly Component[] = ["metrics", "logs"];

/** Helm's word for a release it has no record of (the backend's `RELEASE_MISSING`). */
export const RELEASE_MISSING = "missing";

/** How often a cluster's tools are read while an install or uninstall runs there. */
export const POLL_RUNNING_MS = 3000;

/**
 * Whether a failed or cancelled record was left by an uninstall (its message is the uninstall's
 * own: every one of them ends with "uninstall again", says OmniKrux stopped during the uninstall, or
 * that the uninstall stopped on something unexpected or because the cluster was removed).
 * The install's own messages offer "install again", never "uninstall again".
 */
export function endedUninstall(install: InstallOut): boolean {
  if (install.state !== "failed" && install.state !== "cancelled") return false;
  return UNINSTALL_WORDS.test(install.message ?? "");
}

const UNINSTALL_WORDS = new RegExp(String.raw`\buninstall again\b|\bduring the uninstall\b|\bthe uninstall stopped\b`, "i");

/** Whether a job is running on the cluster (an install or an uninstall): the page asks more often. */
export function isBusy(status: InstallStatusOut): boolean {
  const state = status.install?.state;
  return state === "installing" || state === "uninstalling";
}

const releasesOf = (status: InstallStatusOut, c: Component): ReleaseOut[] =>
  status.releases.filter((r) => COMPONENT_CHARTS[c].includes(r.chart));

/** Whether a release is healthy as Helm and the workloads say it. */
export function releaseHealthy(r: ReleaseOut): boolean {
  return r.status === "deployed" && r.workloads.every((w) => w.desired > 0 && w.ready >= w.desired);
}

/**
 * How a component stands: `busy` while a job runs, `missing` when OmniKrux hasn't installed it (or
 * Helm has no record of it any more), `failing` when a release or a workload isn't up, else `installed`.
 */
export function componentState(status: InstallStatusOut, c: Component): ComponentState {
  if (isBusy(status)) return "busy";
  const install = status.install;
  if (install === null || !install.components.includes(c)) return "missing";
  const releases = releasesOf(status, c);
  if (releases.length === 0 || releases.some((r) => r.status === RELEASE_MISSING)) return "missing";
  return releases.every(releaseHealthy) ? "installed" : "failing";
}

/** Whether an install can start now: OmniKrux has what it needs, the read worked and no job is running. */
export function canInstall(status: InstallStatusOut): boolean {
  return status.tools.available && status.problem === null && !isBusy(status);
}

/** HH:MM:SS (local time) of an ISO moment; null when it isn't one. */
export function readAt(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
