// Asked before a tab leaves a dashboard with unsaved changes (closing it, going elsewhere, Back
// or Forward): Stay (focus, Esc), Discard changes, or Keep draft and leave (Ctrl+Enter) when this
// browser keeps drafts.
import { useId, useRef, type RefObject } from "react";
import { DialogShell } from "../../../features/dock/ConfirmDialog";
import s from "./Drafts.module.css";

export function LeaveDialog({ title, draftsWork, onStay, onDiscard, onKeep, restoreFocusTo, body }: {
  title: string;
  draftsWork: boolean;
  /** What leaving does, when it isn't a dashboard's draft (an alert rule being written). */
  body?: string;
  onStay(): void;
  onDiscard(): void;
  onKeep(): void;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const stay = useRef<HTMLButtonElement>(null);
  return (
    <DialogShell provider="monitoring" busy={false} onCancel={onStay} onConfirm={draftsWork ? onKeep : undefined} first={stay}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} describedBy={`${id}-b`} className={s.dialog}>
      <h2 id={`${id}-t`} className={s.dialogTitle}>Leave "{title}" with unsaved changes?</h2>
      <p id={`${id}-b`} className={s.dialogBody}>
        {body ?? (draftsWork
          ? "Your changes stay saved as a draft in this browser and are offered back when you open the dashboard again."
          : "This browser can't keep drafts, so leaving loses these changes.")}
      </p>
      <div className={s.dialogActions}>
        <button ref={stay} type="button" className={s.secondary} onClick={onStay}>Stay</button>
        <button type="button" className={draftsWork ? s.secondary : s.danger} onClick={onDiscard}>Discard changes</button>
        {draftsWork && (
          <button type="button" className={s.primary} aria-keyshortcuts="Control+Enter" onClick={onKeep}>Keep draft and leave</button>
        )}
      </div>
    </DialogShell>
  );
}
