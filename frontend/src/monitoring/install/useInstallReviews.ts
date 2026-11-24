// The install reviews as the rest of Monitoring sees them. An install, an uninstall and the review
// of the contact points in OmniKrux's own Alertmanager are server-built plans reviewed in the shared
// `ActionDialog`, one at a time; `InstallReviewHost` (mounted once by `MonitoringApp`) holds the
// queue. Outside it (a page rendered on its own in a test) every review reads cancelled.

import { createContext, useContext } from "react";
import type { Component } from "./api";

/**
 * How a review ended. `applied`: done (or nothing was left to review); `started`: the job carries on
 * after the dialog closed (follow it on Monitoring tools); `cancelled`: closed without applying, or
 * the job was stopped; `failed`: the review couldn't be made, or the job failed.
 */
export type InstallOutcome = "applied" | "started" | "cancelled" | "failed";

export interface InstallRequest {
  clusterId: string;
  components: Component[];
  projectId?: string;
  /**
   * Where the keyboard goes when the review closes; the Monitoring workspace when it's gone. A
   * function is asked as the review closes (for a page that wasn't drawn yet when it was asked for).
   */
  focusAfter?: FocusAfter;
}

export type FocusAfter = HTMLElement | null | (() => HTMLElement | null);

export interface InstallReviews {
  install(req: InstallRequest): Promise<InstallOutcome>;
  uninstall(clusterId: string, focusAfter?: HTMLElement | null): Promise<InstallOutcome>;
  contacts(clusterId: string, focusAfter?: HTMLElement | null): Promise<InstallOutcome>;
  /**
   * One review dialog at a time across Monitoring: resolves when no other review holds the screen
   * (this host's own reviews take the same turn), with the release to call once the caller's
   * dialog closed. The tool review queue takes it before each review it opens.
   */
  turn(): Promise<() => void>;
}

export const InstallReviewsContext = createContext<InstallReviews | null>(null);

const cancelled = () => Promise.resolve<InstallOutcome>("cancelled");
const NONE: InstallReviews = { install: cancelled, uninstall: cancelled, contacts: cancelled, turn: () => Promise.resolve(() => {}) };

/** The reviews of the Monitoring app; outside it, ones that do nothing (each reads cancelled). */
export function useInstallReviews(): InstallReviews {
  return useContext(InstallReviewsContext) ?? NONE;
}

// --- Words ----------------------------------------------------------------------------------

export const installingWords = (cluster: string) => `Installing the monitoring tools in ${cluster}. Follow it on Monitoring tools.`;
export const uninstallingWords = (cluster: string) => `Uninstalling the monitoring tools from ${cluster}. Follow it on Monitoring tools.`;
export const stoppingWords = (what: "install" | "uninstall", cluster: string) =>
  `Stopping the ${what} in ${cluster}. Follow it on Monitoring tools.`;
export const notInstalledWords = (cluster: string) => `Nothing was installed in ${cluster}.`;
export const notUninstalledWords = (cluster: string) => `Nothing was uninstalled from ${cluster}.`;
export const contactsAppliedWords = (cluster: string) => `Contact points are up to date in ${cluster}'s Alertmanager.`;
export const contactsCancelledWords = (cluster: string) =>
  `Contact points in ${cluster}'s Alertmanager aren't updated yet. Review them from Monitoring tools.`;
export const reviewFailedWords = (what: "install" | "uninstall" | "contacts", cluster: string, words: string) =>
  what === "contacts"
    ? `Couldn't review the contact points in ${cluster}'s Alertmanager: ${words}`
    : `Couldn't review the ${what} in ${cluster}: ${words}`;
