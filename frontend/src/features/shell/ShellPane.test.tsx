import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ShellSession } from "../../api/types";
import { FakeWebSocket } from "../logs/fakeWebSocket";

const fake = vi.hoisted(() => {
  class FakeTerminal {
    static last: FakeTerminal;
    cols = 80;
    rows = 24;
    written: string[] = [];
    focused = 0;
    disposed = false;
    resets = 0;
    private data: ((d: string) => void)[] = [];
    private size: ((s: { cols: number; rows: number }) => void)[] = [];
    constructor(public options: Record<string, unknown>) {
      FakeTerminal.last = this;
    }
    loadAddon() {}
    open() {}
    focus() { this.focused += 1; }
    write(d: string) { this.written.push(d); }
    reset() { this.resets += 1; }
    dispose() { this.disposed = true; }
    onData(cb: (d: string) => void) { this.data.push(cb); return { dispose() {} }; }
    onResize(cb: (s: { cols: number; rows: number }) => void) { this.size.push(cb); return { dispose() {} }; }
    type(d: string) { this.data.forEach((cb) => cb(d)); }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.size.forEach((cb) => cb({ cols, rows }));
    }
  }
  return { FakeTerminal };
});
vi.mock("@xterm/xterm", () => ({ Terminal: fake.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { ShellPane } from "./ShellPane";

const { FakeTerminal } = fake;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const session = (over: Partial<ShellSession> = {}): ShellSession => ({
  clusterId: "c1",
  clusterName: "aks-prod-weu",
  provider: "aks",
  namespace: "payments",
  pod: "payments-api-xk2pq",
  container: "payments-api",
  cleanupPod: false,
  ...over,
});

const open = () => {
  const ws = FakeWebSocket.last;
  const sent: unknown[] = [];
  (ws as unknown as { send: (s: string) => void }).send = (s) => sent.push(JSON.parse(s));
  act(() => ws.onopen?.({}));
  return { ws, sent };
};

describe("ShellPane", () => {
  it("shell pane header shows the session's cluster", () => {
    render(<ShellPane session={session({ clusterName: "eks-staging", provider: "eks" })} />);
    const pane = screen.getByRole("region", { name: /shell/i });
    expect(pane.textContent).toContain("eks-staging / payments / payments-api-xk2pq");
    expect(pane.textContent).toContain("(payments-api)");
    expect(screen.getByText("EKS")).toBeTruthy();
    expect(pane.dataset.provider).toBe("eks");
    expect(FakeWebSocket.last.params.get("cluster")).toBe("c1");
  });

  it("keystrokes are sent as stdin", () => {
    render(<ShellPane session={session()} />);
    const { sent } = open();
    act(() => FakeTerminal.last.type("ls\r"));
    expect(sent).toContainEqual({ type: "stdin", data: "ls\r" });
  });

  it("resize is forwarded", () => {
    render(<ShellPane session={session()} />);
    const { sent } = open();
    expect(sent).toContainEqual({ type: "resize", cols: 80, rows: 24 });
    act(() => FakeTerminal.last.resize(120, 40));
    expect(sent).toContainEqual({ type: "resize", cols: 120, rows: 40 });
  });

  it("writes server output into the terminal", () => {
    render(<ShellPane session={session()} />);
    const { ws } = open();
    act(() => ws.emit({ type: "stdout", data: "$ " }));
    expect(FakeTerminal.last.written).toEqual(["$ "]);
  });

  it("focuses the terminal only when active", () => {
    const { rerender } = render(<ShellPane session={session()} active={false} />);
    expect(FakeTerminal.last.focused).toBe(0);
    rerender(<ShellPane session={session()} active />);
    expect(FakeTerminal.last.focused).toBe(1);
  });

  it("socket close shows disconnected banner", () => {
    render(<ShellPane session={session()} />);
    const { ws } = open();
    act(() => ws.drop(1006));
    expect(screen.getByText("Disconnected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeTerminal.last.resets).toBe(1); // a fresh shell, not a replay
    expect(screen.queryByText("Disconnected")).toBeNull();
  });

  it("exit shows code and start again", () => {
    render(<ShellPane session={session()} />);
    const { ws } = open();
    act(() => ws.emit({ type: "exit", code: 130, message: null }));
    act(() => ws.drop(1000));
    expect(screen.getByText("Session ended (exit 130)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("not-running error offers debug container", () => {
    const onStartDebug = vi.fn();
    render(<ShellPane session={session()} onStartDebug={onStartDebug} />);
    const msg =
      "Can't open a shell: container payments-api isn't running (CrashLoopBackOff). Start a debug container to look inside the pod.";
    act(() => FakeWebSocket.last.emit({ type: "error", message: msg }));
    expect(screen.getByRole("alert").textContent).toContain(msg);
    fireEvent.click(screen.getByRole("button", { name: "Start a debug container" }));
    expect(onStartDebug).toHaveBeenCalledTimes(1);
  });

  it("other errors show the server's words without a debug button", () => {
    render(<ShellPane session={session()} onStartDebug={() => {}} />);
    act(() => FakeWebSocket.last.emit({ type: "error", message: "Pod gone." }));
    expect(screen.getByRole("alert").textContent).toContain("Pod gone.");
    expect(screen.queryByRole("button", { name: "Start a debug container" })).toBeNull();
  });

  it("disposes the terminal and closes the socket on unmount", () => {
    const { unmount } = render(<ShellPane session={session()} />);
    const ws = FakeWebSocket.last;
    unmount();
    expect(FakeTerminal.last.disposed).toBe(true);
    expect(ws.closedByClient).toBe(true);
  });
});
