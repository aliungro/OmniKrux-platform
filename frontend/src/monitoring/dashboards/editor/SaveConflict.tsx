// A save refused because another save landed first (409): a bar under the header says so, and
// Review differences compares the saved version with the draft before anything is overwritten.
// The draft is never dropped here.
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { failure } from "../../../api/http";
import { DialogShell } from "../../../features/dock/ConfirmDialog";
import type { DashboardOut, DashboardRequestError } from "../api";
import { JsonDiff } from "../JsonDiff";
import { dashboardJson, type DashboardSpec } from "../schema";
import s from "./EditBar.module.css";

export function SaveConflict({ version, saved, draft, saving, error, onSaveOver }: {
  /** The version the server says is current. */
  version: number;
  /** The dashboard as last read: the saved side once it has caught up with `version`. */
  saved: DashboardOut | undefined;
  draft: DashboardSpec;
  saving: boolean;
  /** The latest save failure, if it isn't this conflict. */
  error: DashboardRequestError | null;
  onSaveOver(version: number, base: DashboardSpec): void;
}) {
  const [open, setOpen] = useState(false);
  const review = useRef<HTMLButtonElement>(null);
  // The refusal appears with the keyboard on its action (W12): reviews open with focus on their
  // action, and wherever the save was pressed from (a tile, Save dashboard) gets nothing from it.
  useLayoutEffect(() => { review.current?.focus({ preventScroll: true }); }, []);
  return (
    <>
      <div className={s.notice} data-kind="conflict" role="alert">
        <p className={s.noticeLine}>
          This dashboard was saved somewhere else since you started (version {version}). Review the differences before saving.
        </p>
        <button ref={review} type="button" className={s.noticeAction} onClick={() => setOpen(true)}>Review differences</button>
      </div>
      {open && (
        <ReviewDialog version={version} saved={saved} draft={draft} saving={saving} error={error} restoreFocusTo={review}
          onKeep={() => setOpen(false)} onSaveOver={onSaveOver} />
      )}
    </>
  );
}

function ReviewDialog({ version, saved, draft, saving, error, restoreFocusTo, onKeep, onSaveOver }: {
  version: number;
  saved: DashboardOut | undefined;
  draft: DashboardSpec;
  saving: boolean;
  error: DashboardRequestError | null;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onKeep(): void;
  onSaveOver(version: number, base: DashboardSpec): void;
}) {
  const id = useId();
  const go = useRef<HTMLButtonElement>(null);
  const theirs = saved && saved.version >= version ? saved : null;
  const n = theirs?.version ?? version;
  // Back from a save that didn't go through: the keyboard returns to the action.
  useEffect(() => { if (!saving) go.current?.focus(); }, [saving]);
  const confirm = () => { if (theirs && !saving) onSaveOver(theirs.version, theirs.spec); };
  return (
    <DialogShell provider="monitoring" role="dialog" busy={saving} onCancel={onKeep} onConfirm={confirm} first={go}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} className={s.review}>
      <h2 id={`${id}-t`} className={s.dialogTitle}>Saved version {n} and your draft</h2>
      {theirs
        ? <JsonDiff before={dashboardJson(theirs.spec)} after={dashboardJson(draft)} beforeLabel={`Saved version ${n}`} afterLabel="Your draft" />
        : <p className={s.reviewNote} role="status">Loading the saved version…</p>}
      {error && <p className={s.dialogError} role="alert">{failure(error, "save again")}</p>}
      <div className={s.dialogActions}>
        <button type="button" className={s.secondary} aria-disabled={saving || undefined} onClick={() => { if (!saving) onKeep(); }}>Keep editing</button>
        <button ref={go} type="button" className={s.primary} aria-disabled={!theirs || saving || undefined} onClick={confirm}>Save over it</button>
      </div>
    </DialogShell>
  );
}
