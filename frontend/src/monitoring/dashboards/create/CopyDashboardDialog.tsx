// Copy dashboard…: a new dashboard with this one's panels, under a title and owner of the
// reader's choice (sources the new owner can't use are set to its own).
import type { RefObject } from "react";
import { copyDashboard, type DashboardOut } from "../api";
import { OwnerDialog } from "./NewDashboardDialog";

export function CopyDashboardDialog({ dashboard, restoreFocusTo, onCancel, onCopied }: {
  dashboard: DashboardOut;
  restoreFocusTo?: RefObject<HTMLElement | null>;
  onCancel(): void;
  onCopied(out: DashboardOut): void;
}) {
  const title = `${dashboard.title} (copy)`;
  const owner = { kind: dashboard.owner_kind, id: dashboard.owner_id, name: dashboard.owner_name };
  return (
    <OwnerDialog heading="Copy dashboard" action="Create copy" busyAction="Copying…" owner={owner}
      titleFor={() => title}
      send={(o, t) => copyDashboard({ from_id: dashboard.id, owner_kind: o.kind, owner_id: o.id, title: t })}
      restoreFocusTo={restoreFocusTo} onCancel={onCancel} onDone={onCopied} />
  );
}
