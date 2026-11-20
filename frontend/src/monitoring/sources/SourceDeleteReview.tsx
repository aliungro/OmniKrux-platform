import type { RefObject } from "react";
import { DeleteReviewDialog } from "../DeleteReviewDialog";
import type { SourceDeleteReviewOut } from "../api/types";

/** Asks before a source is deleted: who loses it, then Delete source (focused) or Cancel. */
export function SourceDeleteReview({ review, busy, error, restoreFocusTo, onCancel, onConfirm }: {
  review: SourceDeleteReviewOut;
  busy: boolean;
  error: string | null;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onCancel(): void;
  onConfirm(): void;
}) {
  const names = review.projects.map((p) => p.name).join(", ");
  return (
    <DeleteReviewDialog title={`Delete source ${review.name}?`} action="Delete source" busy={busy} error={error}
      restoreFocusTo={restoreFocusTo} onCancel={onCancel} onConfirm={onConfirm}>
      <p>{review.projects.length > 0 ? `Projects that use it lose it: ${names}.` : "No project uses it."}</p>
    </DeleteReviewDialog>
  );
}
