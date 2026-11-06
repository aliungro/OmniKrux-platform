import { describe, it, expect } from "vitest";
import { applyMessage, emptyWatchState, resetForReconnect } from "./watchState";
const row = (uid: string) => ({ uid, cluster_id: "c", kind: "Pod", namespace: "n", name: uid, created_at: "", columns: {} });
const snap = (uids: string[], part = 0, last = true) => ({ type: "snapshot", cluster_id: "c", rows: uids.map(row), part, last } as const);

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
  });
  it("reconnect resets cluster state but keeps rows until the new snapshot", () => {
    let s = applyMessage(emptyWatchState(), snap(["a"]));
    s = applyMessage(s, { type: "cluster_status", cluster_id: "c", state: "ready", message: null });
    s = resetForReconnect(s);
    expect(s.clusters.c.state).toBe("syncing");
    expect(s.rows.c.size).toBe(1);
  });
});
