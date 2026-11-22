// Restore version n: asked first, then saved as a new version with what version n had (no
// version is deleted). Focus starts on the action, Ctrl+Enter restores, Esc goes back to Restore….
import { useEffect, useId, useRef, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { DialogShell } from "../../../features/dock/ConfirmDialog";
import { dashboardKey, restoreVersion, useDashboardMutation, type DashboardOut } from "../api";
import e from "../editor/EditBar.module.css";
import v from "./VersionsTab.module.css";

export function RestoreDialog({ dashboardId, version, baseVersion, restoreFocusTo, onCancel, onRestored }: {
  dashboardId: string;
  /** The version to restore. */
  version: number;
  /** The current saved version: the server refuses the restore if another save landed since. */
  baseVersion: number;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onCancel(): void;
  onRestored(out: DashboardOut): void;
}) {
  const id = useId();
  const go = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  // Re-reads the dashboard and its versions, not panel data (only what changed runs again).
  const mutation = useDashboardMutation((x: { n: number; base: number }) => restoreVersion(dashboardId, x.n, x.base));
  const busy = mutation.isPending;
  // Back from a request that didn't go through: the keyboard returns to the action.
  useEffect(() => { if (!busy) go.current?.focus(); }, [busy]);
  const restore = () => {
    if (busy) return;
    mutation.mutate({ n: version, base: baseVersion }, {
      onSuccess: (out) => {
        client.setQueryData(dashboardKey(out.id), out);
        onRestored(out);
      },
      // Another save landed first: the dashboard is read again, so trying again restores over it.
      onError: (err) => {
        if (err.code === "version_conflict") void client.invalidateQueries({ queryKey: dashboardKey(dashboardId), exact: true });
      },
    });
  };
  return (
    <DialogShell provider="monitoring" role="dialog" busy={busy} onCancel={onCancel} onConfirm={restore} first={go}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} describedBy={`${id}-d`} className={e.dialog}>
      <h2 id={`${id}-t`} className={e.dialogTitle}>Restore version {version}?</h2>
      <p id={`${id}-d`} className={v.dialogText}>This saves a new version with what version {version} had. No version is deleted.</p>
      {mutation.error && <p className={e.dialogError} role="alert">{failure(mutation.error, "try again")}</p>}
      <div className={e.dialogActions}>
        <button type="button" className={e.secondary} aria-disabled={busy || undefined} onClick={() => { if (!busy) onCancel(); }}>Cancel</button>
        <button ref={go} type="button" className={e.primary} aria-disabled={busy || undefined} aria-busy={busy || undefined}
          aria-keyshortcuts="Control+Enter" onClick={restore}>
          Restore version {version}
        </button>
      </div>
    </DialogShell>
  );
}
