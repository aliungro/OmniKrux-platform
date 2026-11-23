import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { DialogShell } from "../features/dock/ConfirmDialog";
import s from "./DeleteReviewDialog.module.css";

/**
 * The question before a delete: a title, what it affects (`children`), then the action button
 * (focused) or Cancel. Ctrl+Enter confirms, Esc cancels. While the delete runs both buttons are off
 * and focus leaves; when it ends the keyboard comes back to the action.
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
  useEffect(() => { if (!busy) go.current?.focus(); }, [busy]);
  // The delete is open again (its last blocker went, with the button the keyboard was on): back to the action.
  const wasBlocked = useRef(blocked);
  useEffect(() => {
    const active = document.activeElement;
    if (wasBlocked.current && !blocked && (active === null || active === document.body || !active.isConnected)) go.current?.focus();
    wasBlocked.current = blocked;
  }, [blocked]);
  return (
    <DialogShell provider="monitoring" busy={busy} onCancel={onCancel} onConfirm={blocked ? () => {} : onConfirm} first={go}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} describedBy={`${id}-b`} className={s.dialog}>
      <h2 id={`${id}-t`} className={s.dialogTitle}>{title}</h2>
      <div id={`${id}-b`} className={s.dialogBody}>{children}</div>
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.dialogActions}>
        <button type="button" className={s.secondary} aria-disabled={busy || undefined} onClick={() => { if (!busy) onCancel(); }}>Cancel</button>
        <button ref={go} type="button" className={s.danger} aria-disabled={busy || blocked || undefined} onClick={() => { if (!busy && !blocked) onConfirm(); }}>{action}</button>
      </div>
    </DialogShell>
  );
}
