import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { ResourceRow } from "../../api/types";
import { emptyWatchState, type WatchState } from "../../api/watchState";
import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import type { RowRef } from "../territories/model";
import type { DockState, FollowHold, Session } from "./dockState";
import { FOLLOW_SETTLE_MS } from "./follow";
import { useFollowSelection, type FollowSelectionOptions } from "./useFollowSelection";

const pod = (name: string, uid = name): ResourceRow => ({
  uid, cluster_id: "c1", kind: "Pod", namespace: "n", name, created_at: null, labels: {}, columns: {},
});
const ref = (row: ResourceRow): RowRef => ({ clusterId: row.cluster_id, uid: row.uid });

const watchOf = (rows: ResourceRow[]): WatchState => ({
  ...emptyWatchState(),
  clusters: { c1: { state: "ready", message: null } },
  rows: { c1: new Map(rows.map((r) => [r.uid, r])) },
});

function followOn(name: string, hold?: FollowHold): Session {
  return {
    id: "f", kind: "logs", namespace: "n", pod: name, container: "app", containers: ["app"], follow: true,
    ...(hold ? { hold } : {}),
    cluster: {
      id: "c1", name: "kind", context_name: "kind", server: "https://x", ...FILE_CLUSTER_METADATA, original_server: null,
      provider: "kind", region: null, environment: "development", state: "ready", message: null,
    },
  };
}

const stateWith = (sessions: Session[]): DockState => ({ sessions, focused: sessions[0]?.id ?? null, previous: null, layout: "single", height: 300 });

function fakeDock(sessions: Session[] = [followOn("a")]) {
  return { state: stateWith(sessions), followRow: vi.fn(), holdFollow: vi.fn() };
}

const rows = ["a", "b", "c", "d", "e", "f"].map((name) => pod(name));
const watch = watchOf(rows);

function setup(initial: Partial<FollowSelectionOptions> = {}) {
  const dock = (initial.dock as ReturnType<typeof fakeDock> | undefined) ?? fakeDock();
  const props: FollowSelectionOptions = { active: true, kindKey: "pods", selected: ref(rows[0]), watch, dock, ...initial };
  const hook = renderHook((p: FollowSelectionOptions) => useFollowSelection(p), { initialProps: props });
  return { ...hook, dock, props };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useFollowSelection", () => {
  it("settles once after the last change", () => {
    const { rerender, dock, props } = setup();
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS);
    dock.followRow.mockClear();
    for (const row of rows.slice(1)) {
      rerender({ ...props, selected: ref(row) });
      vi.advanceTimersByTime(30);
    }
    expect(dock.followRow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS - 31);
    expect(dock.followRow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dock.followRow).toHaveBeenCalledExactlyOnceWith(rows[5]);
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS * 4);
    expect(dock.followRow).toHaveBeenCalledTimes(1);
    expect(dock.holdFollow).not.toHaveBeenCalled();
  });

  it("a deployment selection holds notPod and no selection holds noSelection", () => {
    const deployment = { ...pod("web"), kind: "Deployment" };
    const { rerender, dock, props } = setup({ kindKey: "deployments.apps", selected: ref(deployment), watch: watchOf([deployment]) });
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS);
    expect(dock.holdFollow).toHaveBeenLastCalledWith("notPod");
    rerender({ ...props, selected: null });
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS);
    expect(dock.holdFollow).toHaveBeenLastCalledWith("noSelection");
    expect(dock.holdFollow).toHaveBeenCalledTimes(2);
    expect(dock.followRow).not.toHaveBeenCalled();
  });

  it("returning to the followed pod clears the hold", () => {
    const { rerender, dock, props } = setup({ selected: null, dock: fakeDock([followOn("a", "noSelection")]) });
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS);
    expect(dock.holdFollow).toHaveBeenLastCalledWith("noSelection");
    rerender({ ...props, selected: ref(rows[0]) });
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS);
    // useDock's followRow, on the followed pod itself, clears the hold without a describe (R3).
    expect(dock.followRow).toHaveBeenCalledExactlyOnceWith(rows[0]);
  });

  it("a deleted followed pod is said to be gone and clears when it is back", () => {
    const { rerender, dock, props } = setup({ selected: ref(rows[1]) });
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS);
    dock.followRow.mockClear();
    dock.holdFollow.mockClear();

    rerender({ ...props, watch: watchOf(rows.slice(1)) });
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS - 1);
    expect(dock.holdFollow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dock.holdFollow).toHaveBeenCalledExactlyOnceWith("gone");

    // The dock now says it's gone; a StatefulSet's pod comes back under the same name.
    const said = { ...dock, state: stateWith([followOn("a", "gone")]) };
    rerender({ ...props, dock: said, watch: watchOf([pod("a", "a-2"), ...rows.slice(1)]) });
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS);
    expect(dock.holdFollow).toHaveBeenLastCalledWith(null);
    expect(dock.holdFollow).toHaveBeenCalledTimes(2);
    expect(dock.followRow).not.toHaveBeenCalled();
  });

  it("a deleted followed pod that is the selected row is gone, not unselected", () => {
    const { rerender, dock, props } = setup({ selected: ref(rows[1]) });
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS);
    dock.holdFollow.mockClear();
    // Back on the followed pod as it goes: the table keeps the deleted row selected, and the
    // selection and the rows change in one tick.
    rerender({ ...props, selected: { clusterId: "c1", uid: "a" }, watch: watchOf(rows.slice(1)) });
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS);
    expect(dock.holdFollow).toHaveBeenCalledWith("gone");
    expect(dock.holdFollow).not.toHaveBeenCalledWith("noSelection");
  });

  it("a busy watch does not delay the retarget", () => {
    const { rerender, dock, props } = setup();
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS);
    dock.followRow.mockClear();
    let current = props;
    const frame = () => {
      current = { ...current, watch: watchOf(rows) };
      rerender(current);
    };
    current = { ...current, selected: ref(rows[3]) };
    rerender(current);
    for (let t = 0; t < 5; t++) {
      vi.advanceTimersByTime(50);
      frame();
    }
    expect(dock.followRow).toHaveBeenCalledExactlyOnceWith(rows[3]);
    for (let t = 0; t < 10; t++) {
      vi.advanceTimersByTime(50);
      frame();
    }
    expect(dock.followRow).toHaveBeenCalledTimes(1);
    expect(dock.holdFollow).not.toHaveBeenCalled();
  });

  it("does nothing without a follow session or while the pane is inactive", () => {
    const none = setup({ dock: fakeDock([]) });
    none.rerender({ ...none.props, selected: ref(rows[2]), watch: watchOf([]) });
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS * 2);
    expect(none.dock.followRow).not.toHaveBeenCalled();
    expect(none.dock.holdFollow).not.toHaveBeenCalled();
    none.unmount();

    const idle = setup({ active: false });
    idle.rerender({ ...idle.props, selected: ref(rows[2]) });
    idle.rerender({ ...idle.props, selected: null, watch: watchOf([]) });
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS * 2);
    expect(idle.dock.followRow).not.toHaveBeenCalled();
    expect(idle.dock.holdFollow).not.toHaveBeenCalled();
  });

  it("clears its timer on unmount", () => {
    const { rerender, unmount, dock, props } = setup();
    rerender({ ...props, selected: ref(rows[2]), watch: watchOf(rows.slice(1)) });
    unmount();
    vi.advanceTimersByTime(FOLLOW_SETTLE_MS * 2);
    expect(dock.followRow).not.toHaveBeenCalled();
    expect(dock.holdFollow).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
