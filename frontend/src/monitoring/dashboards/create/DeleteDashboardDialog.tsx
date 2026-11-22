// Delete dashboard…: asked first, with what goes with it (its saved versions, and a draft kept in
// this browser). A save that landed since the question was asked refuses the delete (409): the
// question says so and counts the versions again.
import { useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { DeleteReviewDialog } from "../../DeleteReviewDialog";
import { dashboardKey, deleteDashboard, getDashboard, useVersions, type DashboardOut, type DashboardRequestError } from "../api";
import { readDraft } from "../drafts/draftStore";

export const STALE_DELETE = "This dashboard was saved since you opened this. Review it again.";

const versionsLine = (n: number) => (n === 1 ? "Its saved version goes with it." : `Its ${n} saved versions go with it.`);

export function DeleteDashboardDialog({ dashboard, restoreFocusTo, onCancel, onDeleted }: {
  dashboard: DashboardOut;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onCancel(): void;
  /** The dashboard is gone; the caller drops its draft and sessions and leaves the page. */
  onDeleted(): void;
}) {
  const client = useQueryClient();
  const versions = useVersions(dashboard.id);
  // The version the delete is checked against: a newer save refuses it.
  const [version, setVersion] = useState(dashboard.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = readDraft(dashboard.id) !== null;
  const count = versions.data?.length;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteDashboard(dashboard.id, version);
      onDeleted();
    } catch (err) {
      const e = err as DashboardRequestError;
      if (e.code === "version_conflict") {
        setError(STALE_DELETE);
        // Reviewed again: the versions as they are now, and the version a delete is checked against.
        let current = e.currentVersion;
        if (current === null) {
          try { current = (await getDashboard(dashboard.id)).version; } catch { current = null; }
        }
        if (current !== null) setVersion(current);
        void versions.refetch();
        void client.invalidateQueries({ queryKey: dashboardKey(dashboard.id), exact: true });
      } else {
        setError(failure(e, "try again"));
      }
      setBusy(false);
    }
  };

  return (
    <DeleteReviewDialog title={`Delete dashboard "${dashboard.title}"?`} action="Delete dashboard" busy={busy} error={error}
      restoreFocusTo={restoreFocusTo} onCancel={onCancel} onConfirm={() => void confirm()}>
      <p>{count === undefined ? "Its saved versions go with it." : versionsLine(count)}</p>
      {draft && <p>Your unsaved draft in this browser goes too.</p>}
    </DeleteReviewDialog>
  );
}
