import type { RefObject } from "react";
import { DeleteReviewDialog } from "../DeleteReviewDialog";
import type { ProjectDeleteReviewOut } from "../api/types";

/** Asks before a project is deleted: everything it owns, what stays, then Delete project (focused) or Cancel. */
export function ProjectDeleteReview({ review, busy, error, restoreFocusTo, onCancel, onConfirm }: {
  review: ProjectDeleteReviewOut;
  busy: boolean;
  error: string | null;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onCancel(): void;
  onConfirm(): void;
}) {
  const names = (list: { name: string }[]) => list.map((x) => x.name).join(", ");
  const lines: string[] = [];
  if (review.sources_removed.length > 0) lines.push(`Sources it created that go with it: ${names(review.sources_removed)}.`);
  if (review.sources_kept.length > 0) {
    const kept = review.sources_kept.map((x) => `${x.name} (used by ${x.used_by.join(", ")})`).join("; ");
    lines.push(`Sources it created that other projects still use stay: ${kept}.`);
  }
  if (review.sources_unlinked.length > 0) lines.push(`Other sources stay as they are and are only unlinked: ${names(review.sources_unlinked)}.`);
  if (review.groups_left.length > 0) lines.push(`It leaves these groups; the groups stay: ${names(review.groups_left)}.`);
  if (lines.length === 0) lines.push("Only the project itself is removed.");
  return (
    <DeleteReviewDialog title={`Delete project ${review.name}?`} action="Delete project" busy={busy} error={error}
      restoreFocusTo={restoreFocusTo} onCancel={onCancel} onConfirm={onConfirm}>
      {lines.map((line) => <p key={line}>{line}</p>)}
    </DeleteReviewDialog>
  );
}
