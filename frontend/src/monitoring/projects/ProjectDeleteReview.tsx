import type { RefObject } from "react";
import { DeleteReviewDialog } from "../DeleteReviewDialog";
import { OwnerRuleLines, waitsForClusterRules } from "../alerts/reviews/OwnerRuleLines";
import type { ProjectDeleteReviewOut } from "../api/types";

/** Asks before a project is deleted: everything it owns, what stays, then Delete project (focused) or Cancel. */
export function ProjectDeleteReview({ review, busy, error, clusterName, restoreFocusTo, onCancel, onConfirm, onOpenRule, onReviewed }: {
  review: ProjectDeleteReviewOut;
  busy: boolean;
  error: string | null;
  /** Where the project's cluster rules run, when known. */
  clusterName: string | null;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onCancel(): void;
  onConfirm(): void;
  /** Opens a rule on the Alerts page (a group's rule can't be removed from a project). */
  onOpenRule(ruleId: string): void;
  /** A cluster rule's removal finished: the review is read again. */
  onReviewed(): Promise<void>;
}) {
  const names = (list: { name: string }[]) => list.map((x) => x.name).join(", ");
  const first: string[] = [];
  const lines: string[] = [];
  if (review.dashboards.length > 0) {
    const versions = (n: number) => (n === 1 ? "1 version" : `${n} versions`);
    first.push(`Dashboards that go with it: ${review.dashboards.map((d) => `${d.title} (${versions(d.versions)})`).join(", ")}.`);
  }
  if (review.sources_removed.length > 0) lines.push(`Sources it created that go with it: ${names(review.sources_removed)}.`);
  if (review.sources_kept.length > 0) {
    const kept = review.sources_kept.map((x) => `${x.name} (used by ${x.used_by.join(", ")})`).join("; ");
    lines.push(`Sources it created that other projects still use stay: ${kept}.`);
  }
  if (review.sources_unlinked.length > 0) lines.push(`Other sources stay as they are and are only unlinked: ${names(review.sources_unlinked)}.`);
  if (review.groups_left.length > 0) lines.push(`It leaves these groups; the groups stay: ${names(review.groups_left)}.`);
  const rules = (review.alert_rules?.length ?? 0) > 0 || waitsForClusterRules(review);
  if (first.length === 0 && lines.length === 0 && !rules) lines.push("Only the project itself is removed.");
  return (
    <DeleteReviewDialog title={`Delete project ${review.name}?`} action="Delete project" busy={busy} blocked={waitsForClusterRules(review)} error={error}
      restoreFocusTo={restoreFocusTo} onCancel={onCancel} onConfirm={onConfirm}>
      {first.map((line) => <p key={line}>{line}</p>)}
      <OwnerRuleLines alertRules={review.alert_rules} clusterRules={review.cluster_rules} owner={{ kind: "project", id: review.project_id }}
        clusterOf={() => clusterName} fallbackCluster={clusterName ?? "its cluster"} onOpenRule={onOpenRule} onReviewed={onReviewed} />
      {lines.map((line) => <p key={line}>{line}</p>)}
      {review.tools_stay && (
        <p>{`Monitoring tools OmniKrux installed in ${review.tools_stay.cluster_name} stay. Uninstall them from Monitoring tools.`}</p>
      )}
    </DeleteReviewDialog>
  );
}
