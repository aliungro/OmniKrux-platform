// Review changes: the saved version beside the draft, before Save dashboard. Focus starts on Save
// dashboard, Ctrl+Enter saves, Esc goes back to Review changes. The save is the editor's own
// (a newer saved version is refused and reviewed there).
import { useEffect, useId, useRef, type RefObject } from "react";
import { DialogShell } from "../../../features/dock/ConfirmDialog";
import { JsonDiff } from "../JsonDiff";
import { dashboardJson, type DashboardSpec } from "../schema";
import e from "../editor/EditBar.module.css";

export function ReviewChanges({ title, version, saved, draft, saving, restoreFocusTo, onCancel, onSave }: {
  title: string;
  /** The saved version and its document. */
  version: number;
  saved: DashboardSpec;
  draft: DashboardSpec;
  saving: boolean;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onCancel(): void;
  onSave(): void;
}) {
  const id = useId();
  const go = useRef<HTMLButtonElement>(null);
  // Back from a save that didn't go through: the keyboard returns to the action.
  useEffect(() => { if (!saving) go.current?.focus(); }, [saving]);
  const save = () => { if (!saving) onSave(); };
  return (
    <DialogShell provider="monitoring" role="dialog" busy={saving} onCancel={onCancel} onConfirm={save} first={go}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} className={e.review}>
      <h2 id={`${id}-t`} className={e.dialogTitle}>Review changes to "{title}"</h2>
      <JsonDiff before={dashboardJson(saved)} after={dashboardJson(draft)} beforeLabel={`Saved (version ${version})`} afterLabel="Your changes" />
      <div className={e.dialogActions}>
        <button type="button" className={e.secondary} aria-disabled={saving || undefined} onClick={() => { if (!saving) onCancel(); }}>Cancel</button>
        <button ref={go} type="button" className={e.primary} aria-disabled={saving || undefined} aria-busy={saving || undefined}
          aria-keyshortcuts="Control+Enter" onClick={save}>
          Save dashboard
        </button>
      </div>
    </DialogShell>
  );
}
