import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import pc from "../territories/provider.module.css";
import type { Ask } from "./useDock";
import s from "./ConfirmDialog.module.css";

/**
 * Asks before something changes the cluster. Cancel takes focus first, the cluster is named and
 * coloured, and a failure stays here in plain words so you can try again or cancel.
 */
export function ConfirmDialog({ ask, onConfirm, onCancel }: { ask: Ask; onConfirm: () => void; onCancel: () => void }) {
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      const back = returnTo.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  const dialogRef = useRef<HTMLDivElement>(null);

  // While the request runs both buttons are off; keep focus in the dialog rather than lose it.
  useEffect(() => {
    if (ask.busy) dialogRef.current?.focus();
  }, [ask.busy]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!ask.busy) onCancel(); // a request on its way can't be called back
      return;
    }
    // Two buttons: Tab moves between them and never leaves the dialog.
    if (e.key === "Tab") {
      e.preventDefault();
      const next = document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current;
      (next?.disabled ? cancelRef.current : next)?.focus();
    }
  };

  return (
    <div className={s.backdrop} onMouseDown={(e) => e.target === e.currentTarget && !ask.busy && onCancel()}>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-busy={ask.busy}
        tabIndex={-1}
        aria-labelledby={`${id}-t`}
        aria-describedby={`${id}-b`}
        className={`${s.dialog} ${pc[knownProvider(ask.cluster.provider)]}`}
        data-provider={knownProvider(ask.cluster.provider)}
        onKeyDown={onKey}
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
          <button
            ref={confirmRef}
            type="button"
            className={`${s.btn} ${s.go}`}
            onClick={onConfirm}
            disabled={ask.busy}
          >
            {ask.busy ? "Starting…" : ask.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
