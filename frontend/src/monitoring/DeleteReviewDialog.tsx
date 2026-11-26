import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { DialogShell } from "../features/dock/ConfirmDialog";
import s from "./DeleteReviewDialog.module.css";

/**
 * The question before a delete: a title, what it affects (`children`), then Cancel (focused) and the
 * action button. Enter on Cancel cancels; Ctrl+Enter confirms, Esc cancels. While the delete runs both
 * buttons are off and focus leaves; when it ends after a failure the keyboard comes back to the action
 * (the answer was given), and when the last blocker goes it comes back to Cancel.
 */
export function DeleteReviewDialog({ title, action, busy, blocked = false, error, restoreFocusTo, onCancel, onConfirm, children }: {
  title: string;
  /** The action button's words, such as "Delete source". */
  action: string;
  busy: boolean;
  /** The action can't be taken yet (the body says why): its button is off, as is Ctrl+Enter. */
  blocked?: boolean;
  error: string | null;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onCancel(): void;
  onConfirm(): void;
  /** What the delete affects. Rendered inside the dialog's description. */
  children: ReactNode;
}) {
  const id = useId();
  const go = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // A confirm that ended (it failed): the keyboard returns to the action the user chose. Any other
  // wait (the host checking what the delete affects) ends on Cancel, as on open.
  const confirmed = useRef(false);
  useEffect(() => {
    if (busy) return;
    (confirmed.current ? go : cancel).current?.focus();
    confirmed.current = false;
  }, [busy]);
  const confirm = () => { confirmed.current = true; onConfirm(); };
  // The delete is open again (its last blocker went, with the button the keyboard was on): back to Cancel.
  const wasBlocked = useRef(blocked);
  useEffect(() => {
    const active = document.activeElement;
    if (wasBlocked.current && !blocked && (active === null || active === document.body || !active.isConnected)) cancel.current?.focus();
    wasBlocked.current = blocked;
  }, [blocked]);
  return (
    <DialogShell provider="monitoring" busy={busy} onCancel={onCancel} onConfirm={blocked ? () => {} : confirm} first={cancel}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} describedBy={`${id}-b`} className={s.dialog}>
      <h2 id={`${id}-t`} className={s.dialogTitle}>{title}</h2>
      <div id={`${id}-b`} className={s.dialogBody}>{children}</div>
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.dialogActions}>
        <button ref={cancel} type="button" className={s.secondary} aria-disabled={busy || undefined} onClick={() => { if (!busy) onCancel(); }}>Cancel</button>
        <button ref={go} type="button" className={s.danger} aria-disabled={busy || blocked || undefined} onClick={() => { if (!busy && !blocked) confirm(); }}>{action}</button>
      </div>
    </DialogShell>
  );
}
