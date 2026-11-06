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

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
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
    const before = result.current;
    for (const raw of ["{not json", "null", "5"]) {
      expect(() => act(() => FakeSocket.instances[0].serverRaw(raw))).not.toThrow();
    }
    expect(result.current).toBe(before);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("ignores unknown message types", () => {
    const { result } = renderHook(() => useWatch("pods"));
    act(() => FakeSocket.instances[0].serverMessage(status));
    act(() => FakeSocket.instances[0].serverMessage({ type: "ping", cluster_id: "c" }));
    expect(result.current.clusters.c.state).toBe("ready");
  });

  it("under StrictMode leaves exactly one open socket and closes the first", () => {
    renderHook(() => useWatch("pods"), { wrapper: StrictMode });
    expect(FakeSocket.instances[0].closed).toBe(true);
    expect(FakeSocket.instances.filter((s) => !s.closed)).toHaveLength(1);
  });
});
