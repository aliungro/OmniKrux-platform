// The leave check of the Silences and Contact points forms: a form with changes asks before the
// page's other views or its own Cancel take it away. The page's views ask through `leaveForm`
// (the same hook the rule form fills), so one question serves them all.

import { useCallback, useEffect, useId, useRef, useState, type MutableRefObject } from "react";
import { DialogShell } from "../../features/dock/ConfirmDialog";
import s from "./leave.module.css";

export type LeaveRef = MutableRefObject<((then: () => void) => void) | null>;

/** `request(then)` runs `then` at once when nothing changed, else after the question says Discard. */
export function useLeaveGuard(leaveRef: LeaveRef | undefined, changed: boolean, busy: boolean) {
  const [asking, setAsking] = useState<(() => void) | null>(null);
  const request = useCallback((then: () => void) => {
    if (busy) return;
    if (!changed) then();
    else setAsking(() => then);
  }, [changed, busy]);
  useEffect(() => {
    if (!leaveRef) return;
    leaveRef.current = request;
    return () => { if (leaveRef.current === request) leaveRef.current = null; };
  }, [leaveRef, request]);
  return { asking, request, keep: () => setAsking(null), discard: () => { const then = asking; setAsking(null); then?.(); } };
}

export function DiscardDialog({ title, onKeep, onDiscard }: { title: string; onKeep(): void; onDiscard(): void }) {
  const id = useId();
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <DialogShell provider="monitoring" busy={false} onCancel={onKeep} first={keep} labelledBy={`${id}-t`} describedBy={`${id}-b`} className={s.dialog}>
      <h2 id={`${id}-t`} className={s.dialogTitle}>{title}</h2>
      <p id={`${id}-b`} className={s.dialogBody}>What you entered here isn't saved.</p>
      <div className={s.dialogActions}>
        <button ref={keep} type="button" className={s.secondary} onClick={onKeep}>Keep editing</button>
        <button type="button" className={s.danger} onClick={onDiscard}>Discard</button>
      </div>
    </DialogShell>
  );
}
