import { useEffect, useRef } from "react";
import type { WatchState } from "../../api/watchState";
import type { RowRef } from "../territories/model";
import { followSession } from "./dockState";
import { FOLLOW_SETTLE_MS, followUpdate, podGone } from "./follow";
import type { DockApi } from "./useDock";

export interface FollowSelectionOptions {
  /** Only the active pane's selection moves the follow log. */
  active: boolean;
  kindKey: string;
  selected: RowRef | null;
  watch: WatchState;
  dock: Pick<DockApi, "state" | "followRow" | "holdFollow">;
}

function target(s: { cluster: { id: string }; namespace: string; pod: string }) {
  return { clusterId: s.cluster.id, namespace: s.namespace, pod: s.pod };
}

/**
 * Keeps the follow log on the selected pod row once the selection settles (`FOLLOW_SETTLE_MS`), so
 * holding ↓ opens one stream, not one per row. On another kind's row, or with nothing selected, it
 * keeps its last pod and says why; a followed pod that is gone from the list says so, and the note
 * clears when a pod of that name is back. Watch updates never delay the retarget: the "gone" check
 * has a timer of its own, armed at most once per settle however often the rows change. It never
 * touches the history (selection moves stay `replace`).
 */
export function useFollowSelection({ active, kindKey, selected, watch, dock }: FollowSelectionOptions): void {
  const latest = useRef({ active, kindKey, selected, watch, dock });
  latest.current = { active, kindKey, selected, watch, dock };
  const follow = followSession(dock.state);
  const following = follow !== undefined;
  const selectedKey = selected === null ? null : `${selected.clusterId}\n${selected.uid}`;

  // The selection: restarted by every move, applied once it has been still for the settle time.
  // A follow log that opens meanwhile (L while its describe was on the way) settles too.
  useEffect(() => {
    if (!active || !following) return;
    const timer = window.setTimeout(() => {
      const { kindKey, selected, watch, dock } = latest.current;
      const f = followSession(dock.state);
      if (!f) return;
      const row = selected === null ? undefined : watch.rows[selected.clusterId]?.get(selected.uid);
      const update = followUpdate(kindKey, selected, row);
      if ("row" in update) dock.followRow(update.row);
      // The followed pod went with the selected row: that it's gone is what to say.
      else if (kindKey === "pods" && podGone(target(f), watch)) dock.holdFollow("gone");
      else dock.holdFollow(update.hold);
    }, FOLLOW_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [active, following, kindKey, selectedKey]);

  // Whether the followed pod is gone: checked once, a settle after the first change to its
  // cluster's rows, then armed again by the next change.
  const goneTimer = useRef<number | null>(null);
  const followedRows = following && kindKey === "pods" ? watch.rows[follow.cluster.id] : undefined;
  const watching = following && kindKey === "pods";
  useEffect(() => {
    if (!active || !watching || goneTimer.current !== null) return;
    goneTimer.current = window.setTimeout(() => {
      goneTimer.current = null;
      const { active, kindKey, watch, dock } = latest.current;
      const f = followSession(dock.state);
      if (!active || kindKey !== "pods" || !f) return;
      const gone = podGone(target(f), watch);
      if (gone && f.hold !== "gone") dock.holdFollow("gone");
      else if (!gone && f.hold === "gone") dock.holdFollow(null);
    }, FOLLOW_SETTLE_MS);
  }, [active, watching, followedRows]);
  useEffect(() => () => {
    if (goneTimer.current !== null) window.clearTimeout(goneTimer.current);
    goneTimer.current = null;
  }, []);
}
