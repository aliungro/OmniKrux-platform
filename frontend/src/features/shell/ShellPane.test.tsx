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
    opened = 0;
    loadAddon() {}
    open() { this.opened += 1; }
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

  it("opens the terminal only once Geist Mono has loaded, so cells get its width", async () => {
    let loaded!: () => void;
    const load = vi.fn(() => new Promise<void>((r) => { loaded = r; }));
    Object.defineProperty(document, "fonts", { configurable: true, value: { check: () => false, load } });
    try {
      render(<ShellPane session={session()} />);
      expect(load).toHaveBeenCalledWith('12.5px "Geist Mono"');
      expect(FakeTerminal.last.opened).toBe(0);
      const focusedBefore = FakeTerminal.last.focused;
      await act(async () => loaded());
      expect(FakeTerminal.last.opened).toBe(1);
      expect(FakeTerminal.last.focused).toBe(focusedBefore + 1); // the active pane takes focus once it's open
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
  });

  it("onRestart replaces start again and reconnect (a node shell needs a new pod)", async () => {
    const onRestart = vi.fn();
    render(<ShellPane session={session({ cleanupPod: true })} onRestart={onRestart} note="Node shell on aks-np1-03." />);
    expect(screen.getByText("Node shell on aks-np1-03.")).toBeTruthy();
    await act(async () => {}); // a node shell connects once the mount has settled
    const { ws } = open();
    act(() => ws.drop(1006));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1); // the deleted pod is never reconnected to
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

  it("an error offers Reconnect, as its words say", () => {
    render(<ShellPane session={session()} />);
    const { ws } = open();
    const msg = "The connection to the shell broke (ClientConnectionResetError). Reconnect to start a new shell.";
    act(() => ws.emit({ type: "error", message: msg }));
    act(() => ws.drop(1011));
    expect(screen.getByRole("alert").textContent).toContain(msg);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeTerminal.last.resets).toBe(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a node shell's error starts again with a new pod", async () => {
    const onRestart = vi.fn();
    render(<ShellPane session={session({ cleanupPod: true })} onRestart={onRestart} />);
    await act(async () => {});
    const { ws } = open();
    act(() => ws.emit({ type: "error", message: "The connection to the shell broke (TimeoutError). Reconnect to start a new shell." }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("the not-running error offers both a debug container and Reconnect", () => {
    render(<ShellPane session={session()} onStartDebug={() => {}} />);
    act(() => FakeWebSocket.last.emit({
      type: "error",
      message: "Can't open a shell: container payments-api isn't running (CrashLoopBackOff). Start a debug container to look inside the pod.",
    }));
    act(() => FakeWebSocket.last.drop(1011));
    expect(screen.getByRole("button", { name: "Start a debug container" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });

  it.each([1008, 4403])("a refusal (close %i) offers no Reconnect, since trying again can't help", (code) => {
    render(<ShellPane session={session()} />);
    act(() => FakeWebSocket.last.emit({ type: "error", message: "Refused." }));
    act(() => FakeWebSocket.last.drop(code));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  it("a shell that can't run in the container says why and offers a debug container", () => {
    const onStartDebug = vi.fn();
    render(<ShellPane session={session()} onStartDebug={onStartDebug} />);
    const { ws } = open();
    const msg =
      'The command couldn\'t run in the container (exit 126: it can\'t be executed): OCI runtime exec failed: exec: "/bin/sh": stat /bin/sh: no such file or directory';
    act(() => ws.emit({ type: "exit", code: 126, message: msg, cannot_run: true }));
    act(() => ws.drop(1000));
    const note = screen.getByRole("status");
    expect(note.textContent).toContain(msg);
    expect(note.textContent).toContain("A debug container brings its own shell.");
    fireEvent.click(screen.getByRole("button", { name: "Start a debug container" }));
    expect(onStartDebug).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Start again" })).toBeTruthy();
  });

  it("an ordinary exit offers no debug container", () => {
    render(<ShellPane session={session()} onStartDebug={() => {}} />);
    const { ws } = open();
    act(() => ws.emit({ type: "exit", code: 127, message: null, cannot_run: false }));
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
