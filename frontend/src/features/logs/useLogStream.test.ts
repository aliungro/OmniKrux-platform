import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { LogLine } from "../../api/types";
import { FakeWebSocket } from "./fakeWebSocket";
import type { LogBuffer } from "./logBuffer";
import { useLogStream, type LogStreamParams } from "./useLogStream";

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const line = (ts: string | null, text: string, pod = "web-1"): LogLine => ({ pod, container: "app", ts, text });

const shown = (buf: LogBuffer) =>
  Array.from({ length: buf.length }, (_, i) => {
    const it = buf.get(i)!;
    return "marker" in it ? `[${it.marker}]` : it.text;
  });

const base: LogStreamParams = {
  cluster: "c1",
  namespace: "shop",
  pod: "web-1",
  container: "app",
  previous: false,
  follow: true,
};

function open(params: LogStreamParams = base) {
  return renderHook((p: LogStreamParams) => useLogStream(p), { initialProps: params });
}

describe("useLogStream", () => {
  it("opens the socket with the stream's parameters", () => {
    open({ ...base, selector: undefined });
    const ws = FakeWebSocket.last;
    expect(ws.url.startsWith(`ws://${window.location.host}/api/logs?`)).toBe(true);
    expect(Object.fromEntries(ws.params)).toEqual({
      cluster: "c1",
      namespace: "shop",
      pod: "web-1",
      container: "app",
      previous: "false",
      follow: "true",
    });
    open({ cluster: "c1", namespace: "shop", selector: "app=web", container: null, previous: true, follow: false });
    expect(Object.fromEntries(FakeWebSocket.last.params)).toEqual({
      cluster: "c1",
      namespace: "shop",
      selector: "app=web",
      previous: "true",
      follow: "false",
    });
  });

  it("reconnect resumes from last timestamp with a gap marker", () => {
    const { result } = open();
    const ws1 = FakeWebSocket.last;
    act(() => {
      ws1.emit({ type: "status", state: "streaming", message: null });
      ws1.emit({
        type: "lines",
        lines: [line("2026-11-07T14:04:12.5Z", "a"), line("2026-11-07T14:04:13.09Z", "b"), line("2026-11-07T14:04:13.090Z", "c")],
      });
    });
    expect(result.current.status).toBe("streaming");

    act(() => ws1.drop(1006));
    expect(result.current.status).toBe("reconnecting");
    expect(result.current.message).toMatch(/^Lost the connection/);
    act(() => void vi.advanceTimersByTime(999));
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    const ws2 = FakeWebSocket.last;
    expect(ws2).not.toBe(ws1);
    expect(ws2.params.get("since_time")).toBe("2026-11-07T14:04:13.090Z");
    expect(ws2.params.get("follow")).toBe("true");
    expect(ws2.params.get("pod")).toBe("web-1");

    // The API server rounds sinceTime down to the second: what was already shown is skipped.
    act(() => {
      ws2.emit({ type: "status", state: "streaming", message: null });
      ws2.emit({
        type: "lines",
        lines: [
          line("2026-11-07T14:04:13Z", "before a, same second"),
          line("2026-11-07T14:04:13.090Z", "b"),
          line("2026-11-07T14:04:13.090Z", "c"),
          line("2026-11-07T14:04:20.5Z", "e"),
        ],
      });
    });
    expect(result.current.status).toBe("streaming");
    expect(shown(result.current.buffer)).toEqual([
      "a",
      "b",
      "c",
      "[Reconnected — lines between 14:04:13.090 and 14:04:20.500 may be missing]",
      "e",
    ]);
  });

  it("skips a repeated stamp only as often as it was shown", () => {
    const { result } = open();
    act(() => {
      FakeWebSocket.last.emit({ type: "lines", lines: [line("2026-11-07T14:04:13.1Z", "x")] });
      FakeWebSocket.last.drop(1006);
    });
    act(() => void vi.advanceTimersByTime(1000));
    act(() =>
      FakeWebSocket.last.emit({
        type: "lines",
        lines: [line("2026-11-07T14:04:13.100Z", "x"), line("2026-11-07T14:04:13.100Z", "y, same stamp, new")],
      }),
    );
    expect(shown(result.current.buffer)).toEqual([
      "x",
      "[Reconnected — lines between 14:04:13.100 and 14:04:13.100 may be missing]",
      "y, same stamp, new",
    ]);
  });

  it("backs off 1, 2, 5, then 10 s, and starts over once a socket delivers", () => {
    open();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const before = FakeWebSocket.instances.length;
      act(() => FakeWebSocket.last.drop(1006));
      let waited = 0;
      while (FakeWebSocket.instances.length === before) {
        act(() => void vi.advanceTimersByTime(500));
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 5000, 10000, 10000]);

    act(() => FakeWebSocket.last.emit({ type: "status", state: "streaming", message: null }));
    const before = FakeWebSocket.instances.length;
    act(() => FakeWebSocket.last.drop(1006));
    act(() => void vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances.length).toBe(before + 1);
  });

  it("does not reconnect after the stream ended or failed", () => {
    const { result } = open();
    act(() => {
      FakeWebSocket.last.emit({ type: "status", state: "streaming", message: null });
      FakeWebSocket.last.emit({ type: "status", state: "ended", message: null });
      FakeWebSocket.last.drop(1000);
    });
    expect(result.current.status).toBe("ended");
    act(() => void vi.advanceTimersByTime(30_000));
    expect(FakeWebSocket.instances).toHaveLength(1);

    const failed = open();
    const message = 'Pod shop/web-1 has no container "x". Pick one of: app.';
    act(() => {
      FakeWebSocket.last.emit({ type: "status", state: "error", message });
      FakeWebSocket.last.drop(1011);
    });
    expect(failed.result.current.status).toBe("error");
    expect(failed.result.current.message).toBe(message);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("retry after an error keeps the lines and resumes from the last stamp", () => {
    const { result } = open();
    const ws1 = FakeWebSocket.last;
    act(() => {
      ws1.emit({ type: "lines", lines: [line("2026-11-07T14:04:12Z", "a"), line("2026-11-07T14:04:13Z", "b")] });
      ws1.emit({ type: "status", state: "error", message: "Lost the log stream after 5 attempts: timed out." });
      ws1.drop(1011);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.retry).not.toBeNull();

    act(() => result.current.retry?.());
    const ws2 = FakeWebSocket.last;
    expect(ws2).not.toBe(ws1);
    expect(ws2.params.get("since_time")).toBe("2026-11-07T14:04:13Z");
    expect(result.current.status).toBe("connecting");
    act(() => {
      ws2.emit({ type: "status", state: "streaming", message: null });
      ws2.emit({ type: "lines", lines: [line("2026-11-07T14:04:13Z", "b"), line("2026-11-07T14:04:30Z", "c")] });
    });
    expect(shown(result.current.buffer)).toEqual([
      "a",
      "b",
      "[Reconnected — lines between 14:04:13.000 and 14:04:30.000 may be missing]",
      "c",
    ]);
  });

  it.each([1008, 4403])("a refusal (close %i) can't be retried", (code) => {
    const { result } = open();
    act(() => FakeWebSocket.last.drop(code));
    expect(result.current.status).toBe("error");
    expect(result.current.retry).toBeNull();
  });

  it("server 1008 offers no try again", () => {
    const { result } = open();
    const message = "Choose a pod or a label selector (one of them, not both).";
    act(() => {
      FakeWebSocket.last.emit({ type: "status", state: "error", message });
      FakeWebSocket.last.drop(1008);
    });
    expect(result.current.status).toBe("error");
    expect(result.current.message).toBe(message); // the server's words, not ours
    expect(result.current.retry).toBeNull();
  });

  it("nothing to retry while the stream is fine", () => {
    const { result } = open();
    act(() => FakeWebSocket.last.emit({ type: "status", state: "streaming", message: null }));
    expect(result.current.retry).toBeNull();
  });

  it("an unexpected close without follow is an error, not a reconnect", () => {
    const { result } = open({ ...base, previous: true, follow: false });
    act(() => FakeWebSocket.last.drop(1006));
    expect(result.current.status).toBe("error");
    expect(result.current.message).toMatch(/^Lost the connection to the console's server/);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("counts lines the server dropped and marks where", () => {
    const { result } = open();
    act(() => {
      FakeWebSocket.last.emit({ type: "lines", lines: [line(null, "one")] });
      FakeWebSocket.last.emit({ type: "dropped", count: 1200 });
      FakeWebSocket.last.emit({ type: "lines", lines: [line(null, "two")] });
    });
    expect(result.current.buffer.dropped).toBe(1200);
    expect(shown(result.current.buffer)).toEqual([
      "one",
      "[1,200 lines dropped because the page fell behind the stream]",
      "two",
    ]);
  });

  it("new parameters close the old socket and start an empty log", () => {
    const { result, rerender } = open();
    const ws1 = FakeWebSocket.last;
    act(() => ws1.emit({ type: "lines", lines: [line(null, "current run")] }));
    rerender({ ...base, previous: true, follow: false });
    expect(ws1.closedByClient).toBe(true);
    expect(FakeWebSocket.last.params.get("previous")).toBe("true");
    expect(result.current.buffer.length).toBe(0);
    expect(result.current.status).toBe("connecting");
  });

  it("in selector mode resumes from the pod that is furthest behind", () => {
    open({ cluster: "c1", namespace: "shop", selector: "app=web", container: null, previous: false, follow: true });
    act(() => {
      FakeWebSocket.last.emit({
        type: "lines",
        lines: [line("2026-11-07T14:00:05Z", "a1", "web-1"), line("2026-11-07T14:00:09Z", "b1", "web-2")],
      });
      FakeWebSocket.last.drop(1006);
    });
    act(() => void vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.last.params.get("since_time")).toBe("2026-11-07T14:00:05Z");
  });
});
