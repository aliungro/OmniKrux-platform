import { useEffect, useId, useRef, type RefObject } from "react";
import { DialogShell } from "../../features/dock/ConfirmDialog";
import type { SourceDeleteReviewOut } from "../api/types";
import s from "./SourceForm.module.css";

/** Asks before a source is deleted: who loses it, then Delete source (focused) or Cancel. */
export function SourceDeleteReview({ review, busy, error, restoreFocusTo, onCancel, onConfirm }: {
  review: SourceDeleteReviewOut;
  busy: boolean;
  error: string | null;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onCancel(): void;
  onConfirm(): void;
}) {
  const id = useId();
  const go = useRef<HTMLButtonElement>(null);
  // After a refused delete the review is asked again with the keyboard where it started.
  useEffect(() => { if (error) go.current?.focus(); }, [error]);
  const names = review.projects.map((p) => p.name).join(", ");
  return (
    <DialogShell provider="monitoring" busy={busy} onCancel={onCancel} onConfirm={onConfirm} first={go}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} describedBy={`${id}-b`} className={s.dialog}>
      <h2 id={`${id}-t`} className={s.dialogTitle}>Delete source {review.name}?</h2>
      <p id={`${id}-b`} className={s.dialogBody}>
        {review.projects.length > 0 ? `Projects that use it lose it: ${names}.` : "No project uses it."}
      </p>
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.dialogActions}>
        <button type="button" className={s.secondary} onClick={onCancel} disabled={busy}>Cancel</button>
        <button ref={go} type="button" className={s.danger} onClick={onConfirm} disabled={busy}>Delete source</button>
      </div>
    </DialogShell>
  );
}
