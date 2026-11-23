// The tool review queue as the rest of Monitoring sees it. A rule change that needs a cluster
// change (a PrometheusRule written or removed through the action pipeline) is reviewed in the
// shared `ActionDialog`, one at a time; `ToolReviewHost` (mounted once by `MonitoringApp`) holds
// the queue. Outside it (a dashboard rendered on its own in a test) the queue is a no-op.

import { createContext, useContext } from "react";
import type { AlertChangeOut } from "../api";

/** One cluster review: the target to sync, and the names the status line says. */
export type ToolReviewRequest = { targetId: string; ruleName: string; projectName: string };

/** How one review ended: applied, closed without applying, or it couldn't be made or applied. */
export type ToolReviewResult = "applied" | "cancelled" | "failed";

export interface ToolReviews {
  /**
   * Queues the `review` changes in order (each opens its own review, one at a time) and announces
   * the `failed` ones. When the queue ends the keyboard goes to `after.focus`, or to the
   * Monitoring workspace when that is gone.
   */
  enqueue(changes: AlertChangeOut[], after?: { focus?: HTMLElement | null }): void;
  /** One target's review (a rule's Review or Retry); focus returns to where it was asked. */
  reviewTarget(targetId: string, ruleName: string, projectName: string): Promise<ToolReviewResult>;
  /** Reviews waiting or open. */
  pending: number;
}

export const ToolReviewsContext = createContext<ToolReviews | null>(null);

const NONE: ToolReviews = {
  enqueue: () => {},
  reviewTarget: () => Promise.resolve("cancelled"),
  pending: 0,
};

/** The queue of the Monitoring app; outside it, one that does nothing (a review reads cancelled). */
export function useToolReviews(): ToolReviews {
  return useContext(ToolReviewsContext) ?? NONE;
}

// --- Words ----------------------------------------------------------------------------------

export const appliedWords = (rule: string, project: string) => `Applied "${rule}" in ${project}'s cluster.`;
export const cancelledWords = (rule: string, project: string) =>
  `"${rule}" isn't applied in ${project}'s cluster yet. Review it from its panel or the Alerts page.`;
export const failedWords = (rule: string, project: string, message: string) =>
  `"${rule}" couldn't be applied in ${project}'s cluster: ${message}`;
export const lokiFailedWords = (rule: string, message: string) => `"${rule}" couldn't be written to Loki: ${message}`;

/** When a failed change came without words of its own (the backend's TOOL_FAILED). */
export const TOOL_FAILED = "OmniKrux couldn't bring this rule up to date in the tool. Try again.";
