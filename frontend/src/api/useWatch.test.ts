import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useWatch } from "./useWatch";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  serverMessage(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  serverRaw(data: string) {
    this.onmessage?.({ data });
  }
  serverClose(code = 1006) {
    this.onclose?.({ code });
  }
}

const status = { type: "cluster_status", cluster_id: "c", state: "ready", message: null };
const row = (uid: string, cluster_id = "c") => ({ uid, cluster_id, kind: "Pod", namespace: "n", name: uid, created_at: null, columns: {} });

/** A controllable requestAnimationFrame: callbacks run only when the test calls frame(). */
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function frame() {
  const due = [...frames.values()];
  frames = new Map();
  act(() => due.forEach((cb) => cb(0)));
}

beforeEach(() => {
  FakeSocket.instances = [];
  frames = new Map();
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useWatch", () => {
  it("builds the url from window.location and applies messages", () => {
    const { result } = renderHook(() => useWatch("pods"));
    expect(FakeSocket.instances[0].url).toBe(`ws://${window.location.host}/api/watch?kind=pods`);
    act(() => FakeSocket.instances[0].serverMessage(status));
    frame();
    expect(result.current.clusters.c.state).toBe("ready");
  });

  it("reconnects with 1, 2, 5, 10, 10 s backoff and resets to syncing", () => {
    const { result } = renderHook(() => useWatch("pods"));
    act(() => FakeSocket.instances[0].serverMessage(status));
    const expected = [1000, 2000, 5000, 10000, 10000];
    expected.forEach((delay, i) => {
      act(() => FakeSocket.instances[i].serverClose());
      expect(result.current.clusters.c.state).toBe("syncing");
      act(() => vi.advanceTimersByTime(delay - 1));
      expect(FakeSocket.instances.length).toBe(i + 1);
      act(() => vi.advanceTimersByTime(1));
      expect(FakeSocket.instances.length).toBe(i + 2);
    });
  });

  it("resets the delay to 1 s after a connection that received a message", () => {
    renderHook(() => useWatch("pods"));
    act(() => FakeSocket.instances[0].serverClose());
    act(() => vi.advanceTimersByTime(1000));
    act(() => FakeSocket.instances[1].serverClose());
    act(() => vi.advanceTimersByTime(2000));
    expect(FakeSocket.instances.length).toBe(3);
    act(() => FakeSocket.instances[2].serverMessage(status));
    act(() => FakeSocket.instances[2].serverClose());
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeSocket.instances.length).toBe(4);
  });

  it("does not reconnect on close code 4404", () => {
    renderHook(() => useWatch("nope"));
    act(() => FakeSocket.instances[0].serverClose(4404));
    act(() => vi.advanceTimersByTime(60000));
    expect(FakeSocket.instances.length).toBe(1);
  });

  it("cancels a pending reconnect on unmount", () => {
    const { unmount } = renderHook(() => useWatch("pods"));
    act(() => FakeSocket.instances[0].serverClose());
    unmount();
    act(() => vi.advanceTimersByTime(60000));
    expect(FakeSocket.instances.length).toBe(1);
  });

  it("closes the live socket on unmount", () => {
    const { unmount } = renderHook(() => useWatch("pods"));
    const sock = FakeSocket.instances[0];
    unmount();
    expect(sock.closed).toBe(true);
  });

  it("ignores malformed and non-object frames without throwing or changing state", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useWatch("pods"));
    act(() => FakeSocket.instances[0].serverMessage(status));
    frame();
    const before = result.current;
    for (const raw of ["{not json", "null", "5"]) {
      expect(() => act(() => FakeSocket.instances[0].serverRaw(raw))).not.toThrow();
    }
    frame();
    expect(result.current).toBe(before);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("ignores unknown message types", () => {
    const { result } = renderHook(() => useWatch("pods"));
    act(() => FakeSocket.instances[0].serverMessage(status));
    act(() => FakeSocket.instances[0].serverMessage({ type: "ping", cluster_id: "c" }));
    frame();
    expect(result.current.clusters.c.state).toBe("ready");
  });

  it("under StrictMode leaves exactly one open socket and closes the first", () => {
    renderHook(() => useWatch("pods"), { wrapper: StrictMode });
    expect(FakeSocket.instances[0].closed).toBe(true);
    expect(FakeSocket.instances.filter((s) => !s.closed)).toHaveLength(1);
  });
});

describe("useWatch batching", () => {
  it("messages in one frame cause one state update", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useWatch("pods");
    });
    const sock = FakeSocket.instances[0];
    const before = renders;
    act(() => {
      sock.serverMessage({ type: "snapshot", cluster_id: "c", rows: [row("a")], part: 0, last: true });
      for (let i = 0; i < 50; i++) sock.serverMessage({ type: "upsert", cluster_id: "c", row: row(`u${i}`) });
      sock.serverMessage(status);
    });
    expect(renders).toBe(before);
    expect(result.current.rows.c).toBeUndefined();
    frame();
    expect(renders).toBe(before + 1);
    expect(result.current.rows.c.size).toBe(51);
    expect(result.current.clusters.c.state).toBe("ready");
    expect(frames.size).toBe(0);
  });

  it("schedules one frame per batch, and a new one for later messages", () => {
    const { result } = renderHook(() => useWatch("pods"));
    const sock = FakeSocket.instances[0];
    act(() => {
      sock.serverMessage(status);
      sock.serverMessage(status);
    });
    expect(frames.size).toBe(1);
    frame();
    act(() => sock.serverMessage({ type: "upsert", cluster_id: "c", row: row("b") }));
    expect(frames.size).toBe(1);
    frame();
    expect([...result.current.rows.c.keys()]).toEqual(["b"]);
  });

  it("applies queued messages before resetting on close", () => {
    const { result } = renderHook(() => useWatch("pods"));
    act(() =>
      FakeSocket.instances[0].serverMessage({ type: "snapshot", cluster_id: "c", rows: [row("a")], part: 0, last: true }),
    );
    act(() => FakeSocket.instances[0].serverClose());
    expect(frames.size).toBe(0);
    expect(result.current.rows.c.size).toBe(1);
    expect(result.current.clusters.c.state).toBe("syncing");
  });

  it("cancels the pending frame on unmount", () => {
    const { unmount } = renderHook(() => useWatch("pods"));
    act(() => FakeSocket.instances[0].serverMessage(status));
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
  });

  it("falls back to a 16 ms timer without requestAnimationFrame", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    vi.stubGlobal("cancelAnimationFrame", undefined);
    const { result } = renderHook(() => useWatch("pods"));
    act(() => FakeSocket.instances[0].serverMessage(status));
    act(() => vi.advanceTimersByTime(15));
    expect(result.current.clusters.c).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.clusters.c.state).toBe("ready");
  });

  it("still applies messages within a second when frames never run (hidden tab)", () => {
    const { result } = renderHook(() => useWatch("pods"));
    act(() => FakeSocket.instances[0].serverMessage(status));
    act(() => vi.advanceTimersByTime(999));
    expect(result.current.clusters.c).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.clusters.c.state).toBe("ready");
    expect(frames.size).toBe(0);
  });
});

describe("useWatch cluster changes", () => {
  it("unknown cluster id triggers callback once", () => {
    const onUnknownCluster = vi.fn();
    const knownClusterIds = new Set(["c"]);
    renderHook(() => useWatch("pods", { onUnknownCluster, knownClusterIds }));
    const sock = FakeSocket.instances[0];
    act(() => {
      sock.serverMessage(status);
      sock.serverMessage({ type: "cluster_status", cluster_id: "new", state: "syncing", message: null });
      sock.serverMessage({ type: "snapshot", cluster_id: "new", rows: [row("a", "new")], part: 0, last: true });
    });
    frame();
    act(() => sock.serverMessage({ type: "upsert", cluster_id: "new", row: row("b", "new") }));
    frame();
    expect(onUnknownCluster).toHaveBeenCalledTimes(1);
    expect(onUnknownCluster).toHaveBeenCalledWith("new");
  });

  it("calls again for an id that was removed and came back, never for known ids or without a known set", () => {
    const onUnknownCluster = vi.fn();
    const { rerender } = renderHook(
      ({ known }) => useWatch("pods", { onUnknownCluster, knownClusterIds: known }),
      { initialProps: { known: undefined as Set<string> | undefined } },
    );
    const sock = FakeSocket.instances[0];
    act(() => sock.serverMessage({ type: "cluster_status", cluster_id: "x", state: "ready", message: null }));
    expect(onUnknownCluster).not.toHaveBeenCalled();
    rerender({ known: new Set(["c"]) });
    act(() => sock.serverMessage({ type: "cluster_status", cluster_id: "x", state: "ready", message: null }));
    act(() => sock.serverMessage({ type: "cluster_removed", cluster_id: "x" }));
    act(() => sock.serverMessage({ type: "cluster_status", cluster_id: "x", state: "syncing", message: null }));
    act(() => sock.serverMessage(status));
    frame();
    expect(onUnknownCluster.mock.calls).toEqual([["x"], ["x"]]);
  });

  it("reports removed clusters and drops them from state", () => {
    const onClusterRemoved = vi.fn();
    const { result } = renderHook(() => useWatch("pods", { onClusterRemoved }));
    act(() => FakeSocket.instances[0].serverMessage(status));
    frame();
    act(() => FakeSocket.instances[0].serverMessage({ type: "cluster_removed", cluster_id: "c" }));
    expect(onClusterRemoved).toHaveBeenCalledWith("c");
    frame();
    expect(result.current.clusters.c).toBeUndefined();
  });
});
