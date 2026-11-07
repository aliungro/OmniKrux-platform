import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import { StrictMode } from "react";
import { useExec, execUrl } from "./useExec";

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const target = { cluster: "c1", namespace: "payments", pod: "api-1", container: "app" };

describe("execUrl", () => {
  it("passes the target and leaves the command to the server", () => {
    const p = new URL(execUrl({ ...target, cleanupPod: true })).searchParams;
    expect(p.get("cluster")).toBe("c1");
    expect(p.get("container")).toBe("app");
    expect(p.get("cleanup_pod")).toBe("true");
    expect(p.has("command")).toBe(false);
    expect(new URL(execUrl({ ...target, container: null })).searchParams.has("container")).toBe(false);
  });
});

describe("useExec", () => {
  it("a node shell never connects from a mount that's undone at once (closing it deletes the pod)", async () => {
    // StrictMode mounts, unmounts and mounts again: a socket from the first mount would close at
    // once, and the server deletes a node-shell pod when its session closes.
    renderHook(() => useExec({ ...target, cleanupPod: true }, () => {}), { wrapper: StrictMode });
    await act(async () => {});
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.last.closedByClient).toBe(false);
    expect(FakeWebSocket.last.params.get("cleanup_pod")).toBe("true");
  });

  it("streams output to the subscriber and sends stdin once open", () => {
    const out: string[] = [];
    const { result } = renderHook(() => useExec(target, (d) => out.push(d)));
    expect(result.current.status).toBe("connecting");
    const ws = FakeWebSocket.last;
    const sent: unknown[] = [];
    (ws as unknown as { send: (s: string) => void }).send = (s) => sent.push(JSON.parse(s));
    act(() => ws.onopen?.({}));
    expect(result.current.status).toBe("open");
    act(() => ws.emit({ type: "stdout", data: "hi" }));
    expect(out).toEqual(["hi"]);
    act(() => result.current.send("ls\r"));
    act(() => result.current.resize(100, 30));
    expect(sent).toEqual([
      { type: "stdin", data: "ls\r" },
      { type: "resize", cols: 100, rows: 30 },
    ]);
  });

  it("holds the latest size until the socket opens", () => {
    const { result } = renderHook(() => useExec(target, () => {}));
    const ws = FakeWebSocket.last;
    const sent: unknown[] = [];
    (ws as unknown as { send: (s: string) => void }).send = (s) => sent.push(JSON.parse(s));
    act(() => result.current.resize(90, 20));
    expect(sent).toEqual([]);
    act(() => ws.onopen?.({}));
    expect(sent).toEqual([{ type: "resize", cols: 90, rows: 20 }]);
  });

  it("a close after exit stays exited, with the code", () => {
    const { result } = renderHook(() => useExec(target, () => {}));
    const ws = FakeWebSocket.last;
    act(() => ws.onopen?.({}));
    act(() => ws.emit({ type: "exit", code: 3, message: null }));
    act(() => ws.drop(1000));
    expect(result.current.status).toBe("exited");
    expect(result.current.exitCode).toBe(3);
  });

  it("a close with no word is disconnected, and reconnect opens a new socket", () => {
    const { result } = renderHook(() => useExec(target, () => {}));
    act(() => FakeWebSocket.last.drop(1006));
    expect(result.current.status).toBe("disconnected");
    act(() => result.current.reconnect());
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result.current.status).toBe("connecting");
  });

  it("an error message wins over the close that follows", () => {
    const { result } = renderHook(() => useExec(target, () => {}));
    const ws = FakeWebSocket.last;
    act(() => ws.emit({ type: "error", message: "nope" }));
    act(() => ws.drop(1011));
    expect(result.current.status).toBe("error");
    expect(result.current.message).toBe("nope");
  });
});
