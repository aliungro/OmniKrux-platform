import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { pressed } from "../chrome/shortcuts";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import pc from "../territories/provider.module.css";
import type { Ask } from "./useDock";
import s from "./ConfirmDialog.module.css";

const FOCUSABLE = 'button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !(el as HTMLButtonElement).disabled && el.closest("[hidden]") === null,
  );
}

/**
 * The shell every question before a change shares: centred over a dimmed page, the cluster's
 * colour along the top, `first` focused on open and focus given back on close. Tab cycles inside
 * it; Escape and a click outside cancel, unless something is on its way (`busy`). A review passes
 * `onConfirm`, which Ctrl+Enter (Cmd+Enter) calls once per press. A held Enter never presses a
 * button here. Keys typed here never reach the table or the page's shortcuts.
 */
export function DialogShell({
  provider,
  role = "alertdialog",
  busy,
  onCancel,
  onConfirm,
  first,
  restoreFocusTo,
  labelledBy,
  describedBy,
  className = "",
  children,
}: {
  provider: string;
  role?: "dialog" | "alertdialog";
  busy: boolean;
  onCancel: () => void;
  /** A review's confirm: Ctrl+Enter (Cmd+Enter) calls it. Absent: the dialog's keys are as before. */
  onConfirm?: () => void;
  first: RefObject<HTMLElement | null>;
  restoreFocusTo?: RefObject<HTMLElement | null>;
  labelledBy: string;
  describedBy?: string;
  className?: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement;
    first.current?.focus();
    return () => {
      const back = restoreFocusTo?.current ?? returnTo.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []); // once, on open: `first` is a ref

  // While a request runs the buttons are off; keep focus in the dialog rather than lose it.
  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    // A review confirms with Ctrl+Enter (Cmd+Enter) wherever its focus is, once per press.
    if (onConfirm && pressed("confirmReview", e)) {
      e.preventDefault();
      if (!e.repeat && !busy) onConfirm();
      return;
    }
    // A held Enter never presses the button that took focus while it was held. Fields keep theirs
    // (a held Enter still types new lines in a textarea).
    if (e.key === "Enter" && e.repeat && e.target instanceof Element && e.target.closest("button")) {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (!busy) onCancel(); // a request on its way can't be called back
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    e.preventDefault();
    const all = focusables(dialogRef.current);
    if (all.length === 0) return;
    const at = all.findIndex((el) => el === document.activeElement || el.contains(document.activeElement));
    const step = e.shiftKey ? -1 : 1;
    const next = at === -1 ? (e.shiftKey ? all.length - 1 : 0) : (at + step + all.length) % all.length;
    all[next].focus();
  };

  const p = knownProvider(provider);
  return (
    <div className={s.backdrop} onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-busy={busy}
        tabIndex={-1}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className={`${s.dialog} ${pc[p]} ${className}`}
        data-provider={p}
        onKeyDown={onKey}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Asks before something changes the cluster. Cancel takes focus first (Ctrl+Enter confirms), the
 * cluster is named and coloured, and a failure stays here in plain words so you can try again or
 * cancel.
 */
export function ConfirmDialog({ ask, onConfirm, onCancel }: { ask: Ask; onConfirm: () => void; onCancel: () => void }) {
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <DialogShell
      provider={ask.cluster.provider}
      busy={ask.busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
      first={cancelRef}
      labelledBy={`${id}-t`}
      describedBy={`${id}-b`}
    >
      <div className={s.where}>
        <ProviderBadge provider={ask.cluster.provider} />
        <span className={s.path}>{ask.where}</span>
      </div>
      <h2 id={`${id}-t`} className={s.title}>{ask.title}</h2>
      <p id={`${id}-b`} className={s.body}>{ask.body}</p>
      {ask.error && <p className={s.error} role="alert">{ask.error}</p>}
      <div className={s.actions}>
        <button ref={cancelRef} type="button" className={s.btn} onClick={onCancel} disabled={ask.busy}>
          Cancel
        </button>
        <button type="button" className={`${s.btn} ${s.go}`} onClick={onConfirm} disabled={ask.busy}>
          {ask.busy ? "Starting…" : ask.confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}
