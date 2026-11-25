// The question before a contact point goes: which rules stop notifying it. The review is read
// first; the delete carries its token, so a rule that started using it since is asked about again.
// What the delete changes in an Alertmanager OmniKrux installed (the answer's `contacts` changes) is
// reviewed through the tool review queue once this dialog is gone.

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { failure } from "../../../api/http";
import { DeleteReviewDialog } from "../../DeleteReviewDialog";
import { contactPointDeleteReview, deleteContactPoint, type AlertRequestError, type ContactPointDeleteReviewOut, type ContactPointOut } from "../api";
import { useToolReviews } from "../reviews/useToolReviews";

export const REVIEW_CHANGED = "Something changed since the review. Review it again.";

export function ContactPointDeleteDialog({ point, restoreFocusTo, onCancel, onDeleted }: {
  point: ContactPointOut;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onCancel(): void;
  onDeleted(): void;
}) {
  const reviews = useToolReviews();
  const [review, setReview] = useState<ContactPointDeleteReviewOut | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(async () => {
    setBusy(true);
    try {
      setReview(await contactPointDeleteReview(point.id));
    } catch (err) {
      if ((err as AlertRequestError).status === 404) {
        onDeleted();
        return;
      }
      setError(failure(err, "try again"));
    }
    setBusy(false);
  }, [point.id, onDeleted]);
  const started = useRef(false);
  useLayoutEffect(() => {
    if (started.current) return;
    started.current = true;
    void read();
  }, [read]);

  const confirm = async () => {
    if (busy) return;
    if (!review) {
      setError(null);
      await read();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await deleteContactPoint(point.id, review.token);
      onDeleted();
      const changes = out?.alert_changes ?? [];
      if (changes.length > 0) reviews.enqueue(changes);
    } catch (err) {
      const e = err as AlertRequestError;
      if (e.status === 404) {
        onDeleted();
        return;
      }
      if (e.status === 409) {
        // What it affects changed since the question: asked again, and the new answer shown.
        setReview(null);
        await read();
        setError(REVIEW_CHANGED);
        return;
      }
      setError(failure(err, "try again"));
      setBusy(false);
    }
  };

  const names = review?.used_by.map((r) => r.name) ?? [];
  return (
    <DeleteReviewDialog title={`Delete the contact point "${point.name}"?`} action="Delete contact point" busy={busy} error={error}
      restoreFocusTo={restoreFocusTo} onCancel={onCancel} onConfirm={() => void confirm()}>
      {!review && !error && <p>Checking which rules use it…</p>}
      {review && (names.length > 0 ? <p>These rules stop notifying it: {names.join(", ")}.</p> : <p>No rule uses it.</p>)}
    </DeleteReviewDialog>
  );
}
