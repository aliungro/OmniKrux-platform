import { afterEach, describe, it, expect, vi } from "vitest";
import type { WatchMessage } from "./types";
import { applyMessage, applyMessages, emptyWatchState, hasCurrentSnapshot, resetForReconnect, type WatchState } from "./watchState";
const row = (uid: string) => ({ uid, cluster_id: "c", kind: "Pod", namespace: "n", name: uid, created_at: "", labels: {}, columns: {} });
const snap = (uids: string[], part = 0, last = true) => ({ type: "snapshot", cluster_id: "c", rows: uids.map(row), part, last } as const);
const ready = (cluster_id = "c") => ({ type: "cluster_status", cluster_id, state: "ready", message: null } as const);
const syncing = { ...ready(), state: "syncing" } as const;

describe("current snapshot", () => {
  it("ready does not make an incomplete snapshot current", () => {
    let s = applyMessage(emptyWatchState(), ready());
    expect(hasCurrentSnapshot(s, "c")).toBe(false);
    s = applyMessage(s, { type: "upsert", cluster_id: "c", row: row("retained") });
    expect(hasCurrentSnapshot(s, "c")).toBe(false);
    s = applyMessage(s, snap(["x"], 0, false));
    expect(hasCurrentSnapshot(s, "c")).toBe(false);
    s = applyMessage(s, snap(["y"], 1, true));
    expect(hasCurrentSnapshot(s, "c")).toBe(true);
    s = applyMessage(s, snap(["refresh"], 0, false));
    expect(hasCurrentSnapshot(s, "c")).toBe(false);
    expect([...s.rows.c.keys()]).toEqual(["x", "y"]);
    s = applyMessage(s, snap([]));
    expect(hasCurrentSnapshot(s, "c")).toBe(true);
    expect(s.rows.c.size).toBe(0);
  });

  it("reconnect and removal invalidate the affected snapshot", () => {
    let s = applyMessages(emptyWatchState(), [snap(["a"]), { ...snap([]), cluster_id: "d" }]);
    expect(s.snapshotReady.has("c")).toBe(true);
    expect(hasCurrentSnapshot(s, "c")).toBe(false);
    s = applyMessages(s, [ready(), ready("d")]);
    expect(hasCurrentSnapshot(s, "c")).toBe(true);
    s = resetForReconnect(s);
    s = applyMessages(s, [ready(), ready("d")]);
    expect([...s.rows.c.keys()]).toEqual(["a"]);
    expect(s.snapshotReady.has("c")).toBe(false);
    expect(s.snapshotReady.has("d")).toBe(false);
    s = applyMessages(s, [snap(["b"]), { ...snap([]), cluster_id: "d" }]);
    expect(s.snapshotReady.has("c")).toBe(true);
    s = applyMessages(s, [snap(["x"], 0, false), syncing, ready(), snap(["y"], 1, true)]);
    expect(s.snapshotReady.has("c")).toBe(false);
    expect(s.snapshotReady.has("d")).toBe(true);
    expect([...s.rows.c.keys()]).toEqual(["x", "y"]);
    s = applyMessages(s, [snap(["z"]), { type: "cluster_removed", cluster_id: "c" }]);
    expect(s.snapshotReady.has("c")).toBe(false);
    expect(s.snapshotReady.has("d")).toBe(true);
    s = applyMessages(s, [ready(), snap(["orphan"], 1, true)]);
    expect(s.snapshotReady.has("c")).toBe(false);
  });

  it.each([
    [snap([], 0, false), snap([], 2, true)],
    [snap([], 0, false), snap([], 2, false), snap([], 1, true)],
    [snap([], 0, false), snap([], 1, false), snap([], 1, false), snap([], 2, true)],
    [snap([]), snap([], 1, true)],
  ])("rejects invalid snapshot ordering (%#)", (...parts) => {
    const complete = applyMessages(emptyWatchState(), [ready(), snap([])]);
    expect(hasCurrentSnapshot(complete, "c")).toBe(true);
    expect(hasCurrentSnapshot(applyMessages(complete, parts), "c")).toBe(false);
  });
});

describe("applyMessage", () => {
  it("snapshot replaces previous rows for that cluster", () => {
    let s = applyMessage(emptyWatchState(), snap(["a", "b"]));
    s = applyMessage(s, snap(["b"]));
    expect([...s.rows.c.keys()]).toEqual(["b"]);
  });
  it("multi-part snapshot is applied only when last part arrives", () => {
    let s = applyMessage(emptyWatchState(), snap(["a"]));
    s = applyMessage(s, snap(["x"], 0, false));
    expect([...s.rows.c.keys()]).toEqual(["a"]);
    s = applyMessage(s, snap(["y"], 1, true));
    expect([...s.rows.c.keys()]).toEqual(["x", "y"]);
  });
  it("a new part 0 discards stale buffered parts", () => {
    let s = applyMessage(emptyWatchState(), snap(["stale"], 0, false));
    s = applyMessage(s, snap(["x"], 0, false));
    s = applyMessage(s, snap(["y"], 1, true));
    expect([...s.rows.c.keys()]).toEqual(["x", "y"]);
    expect(s.pending.c).toBeUndefined();
  });
  it("upsert and delete", () => {
    let s = applyMessage(emptyWatchState(), snap(["a"]));
    s = applyMessage(s, { type: "upsert", cluster_id: "c", row: row("b") });
    s = applyMessage(s, { type: "delete", cluster_id: "c", uid: "a" });
    expect([...s.rows.c.keys()]).toEqual(["b"]);
  });
  it("cluster_status is recorded", () => {
    const s = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c", state: "error", message: "boom" });
    expect(s.clusters.c).toEqual({ state: "error", message: "boom" });
  });
  it("does not mutate input state and keeps unchanged clusters' identity", () => {
    const base = applyMessage(applyMessage(emptyWatchState(), snap(["a"])), {
      type: "snapshot", cluster_id: "d", rows: [{ ...row("z"), cluster_id: "d" }], part: 0, last: true,
    });
    const rowsC = base.rows.c;
    const next = applyMessage(base, { type: "upsert", cluster_id: "c", row: row("b") });
    expect(rowsC.size).toBe(1);
    expect(base.rows.c).toBe(rowsC);
    expect(next.rows.c).not.toBe(rowsC);
    expect(next.rows.d).toBe(base.rows.d);
    expect(next.snapshotReady).toBe(base.snapshotReady);
  });
  it("reconnect resets cluster state but keeps rows until the new snapshot", () => {
    let s = applyMessage(emptyWatchState(), snap(["a"]));
    s = applyMessage(s, { type: "cluster_status", cluster_id: "c", state: "ready", message: null });
    s = resetForReconnect(s);
    expect(s.clusters.c.state).toBe("syncing");
    expect(s.rows.c.size).toBe(1);
  });
  it("unknown message type returns the same state object", () => {
    const s = applyMessage(emptyWatchState(), snap(["a"]));
    expect(applyMessage(s, { type: "ping" } as unknown as WatchMessage)).toBe(s);
  });
  it("reconnect clears buffered snapshot parts", () => {
    let s = applyMessage(emptyWatchState(), snap(["x"], 0, false));
    expect(s.pending.c).toHaveLength(1);
    s = resetForReconnect(s);
    expect(s.pending).toEqual({});
  });
});

describe("cluster_removed", () => {
  it("cluster_removed drops rows and status", () => {
    let s = applyMessage(emptyWatchState(), snap(["a"]));
    s = applyMessage(s, { type: "cluster_status", cluster_id: "c", state: "ready", message: null });
    s = applyMessage(s, { type: "snapshot", cluster_id: "c", rows: [row("p")], part: 0, last: false });
    s = applyMessage(s, { type: "cluster_status", cluster_id: "d", state: "ready", message: null });
    const next = applyMessage(s, { type: "cluster_removed", cluster_id: "c" });
    expect(next.rows.c).toBeUndefined();
    expect(next.clusters.c).toBeUndefined();
    expect(next.pending.c).toBeUndefined();
    expect("c" in next.rows || "c" in next.clusters || "c" in next.pending).toBe(false);
    expect(next.clusters.d).toBe(s.clusters.d);
    expect(s.rows.c.size).toBe(1);
  });
  it("removing a cluster the state never saw returns the same state", () => {
    const s = applyMessage(emptyWatchState(), snap(["a"]));
    expect(applyMessage(s, { type: "cluster_removed", cluster_id: "zzz" })).toBe(s);
  });
});

describe("applyMessages", () => {
  const RealMap = Map;
  afterEach(() => vi.unstubAllGlobals());

  const deepFreeze = (s: WatchState) => {
    Object.freeze(s.clusters);
    Object.freeze(s.rows);
    Object.freeze(s.pending);
    for (const a of Object.values(s.pending)) Object.freeze(a);
    return Object.freeze(s);
  };

  it("applyMessages copies a cluster map once per batch", () => {
    const base = applyMessage(applyMessage(emptyWatchState(), snap(["a"])), {
      type: "snapshot", cluster_id: "d", rows: [{ ...row("z"), cluster_id: "d" }], part: 0, last: true,
    });
    const ups: WatchMessage[] = Array.from({ length: 1000 }, (_, i) => ({ type: "upsert", cluster_id: "c", row: row(`u${i}`) }));
    let created = 0;
    class CountingMap<K, V> extends RealMap<K, V> {
      constructor(entries?: Iterable<readonly [K, V]> | null) {
        super(entries);
        created++;
      }
    }
    vi.stubGlobal("Map", CountingMap);
    const next = applyMessages(base, ups);
    vi.unstubAllGlobals();
    expect(created).toBe(1);
    expect(next.rows.c.size).toBe(1001);
    expect(base.rows.c.size).toBe(1);
    expect(next.rows.d).toBe(base.rows.d);
  });

  it("gives the same result as applying the messages one by one, without mutating inputs", () => {
    let base = applyMessage(emptyWatchState(), snap(["a", "b"]));
    base = applyMessage(base, { type: "snapshot", cluster_id: "e", rows: [{ ...row("e0"), cluster_id: "e" }], part: 0, last: false });
    base = applyMessage(base, { type: "cluster_status", cluster_id: "gone", state: "ready", message: null });
    deepFreeze(base);
    const ms: WatchMessage[] = [
      { type: "upsert", cluster_id: "c", row: row("x") },
      { type: "delete", cluster_id: "c", uid: "a" },
      { type: "snapshot", cluster_id: "e", rows: [{ ...row("e1"), cluster_id: "e" }], part: 1, last: false },
      { type: "snapshot", cluster_id: "e", rows: [{ ...row("e2"), cluster_id: "e" }], part: 2, last: true },
      { type: "upsert", cluster_id: "e", row: { ...row("e3"), cluster_id: "e" } },
      { type: "snapshot", cluster_id: "f", rows: [row("stale")], part: 0, last: false },
      { type: "snapshot", cluster_id: "f", rows: [row("f0")], part: 0, last: false },
      { type: "snapshot", cluster_id: "f", rows: [row("f1")], part: 1, last: true },
      { type: "cluster_status", cluster_id: "c", state: "ready", message: null },
      { type: "cluster_removed", cluster_id: "gone" },
      { type: "ping" } as unknown as WatchMessage,
    ];
    for (const m of ms) Object.freeze(m);
    const one = ms.reduce(applyMessage, base);
    const batch = applyMessages(base, ms);
    const view = (s: WatchState) => ({
      clusters: s.clusters,
      rows: Object.fromEntries(Object.entries(s.rows).map(([k, v]) => [k, [...v.keys()]])),
      pending: s.pending,
      snapshotReady: s.snapshotReady,
      nextSnapshotPart: s.nextSnapshotPart,
    });
    expect(view(batch)).toEqual(view(one));
    expect([...batch.rows.e.keys()]).toEqual(["e0", "e1", "e2", "e3"]);
    expect([...batch.rows.f.keys()]).toEqual(["f0", "f1"]);
    expect([...base.rows.c.keys()]).toEqual(["a", "b"]);
    expect(base.pending.e).toHaveLength(1);
  });

  it("an empty or no-op batch returns the same state object", () => {
    const s = applyMessage(emptyWatchState(), snap(["a"]));
    expect(applyMessages(s, [])).toBe(s);
    expect(applyMessages(s, [{ type: "delete", cluster_id: "c", uid: "nope" }])).toBe(s);
  });

  it("a repeated identical status keeps the cluster's status object", () => {
    const s = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c", state: "ready", message: null });
    const next = applyMessage(s, { type: "cluster_status", cluster_id: "c", state: "ready", message: null });
    expect(next).toBe(s);
  });
});
