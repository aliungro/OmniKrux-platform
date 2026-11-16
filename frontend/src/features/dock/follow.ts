import type { ResourceRow } from "../../api/types";
import type { WatchState } from "../../api/watchState";
import type { RowRef } from "../territories/model";
import type { FollowHold, Session } from "./dockState";

/** How long the selection must stay put before the follow log retargets (holding ↓ opens no streams). */
export const FOLLOW_SETTLE_MS = 250;

/**
 * What the follow log does with the settled selection: show the selected pod row, or keep its
 * last pod and say why.
 */
export function followUpdate(
  kindKey: string,
  selected: RowRef | null,
  row: ResourceRow | undefined,
): { row: ResourceRow } | { hold: FollowHold } {
  if (kindKey === "pods" && selected !== null && row) return { row };
  if (selected === null) return { hold: "noSelection" };
  if (kindKey !== "pods") return { hold: "notPod" };
  // A pod row that isn't loaded (yet, or any more) is as good as no selection.
  return { hold: "noSelection" };
}

/**
 * Whether the followed pod is gone from a cluster whose rows are complete. Matched by namespace
 * and name, so a pod recreated under the same name (a StatefulSet pod, with a new uid) is not gone.
 */
export function podGone(
  target: { clusterId: string; namespace: string; pod: string },
  watch: Pick<WatchState, "clusters" | "rows">,
): boolean {
  if (watch.clusters[target.clusterId]?.state !== "ready") return false;
  const rows = watch.rows[target.clusterId];
  if (!rows) return true;
  for (const row of rows.values()) {
    if (row.name === target.pod && (row.namespace ?? "") === target.namespace) return false;
  }
  return true;
}

/** What the follow log says while it holds its last pod. */
export function holdNote(s: Session): string | null {
  switch (s.hold) {
    case "notPod":
      return `Still showing ${s.pod}: the selected row isn't a pod.`;
    case "noSelection":
      return `Still showing ${s.pod}: no row is selected.`;
    case "gone":
      return `${s.pod} is gone: it was deleted or replaced. Select another pod to follow its log.`;
    default:
      return null;
  }
}
