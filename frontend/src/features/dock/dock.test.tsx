import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import type { Cluster, ResourceRow } from "../../api/types";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import type { Session } from "./dockState";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    input = document.createElement("textarea");
    loadAddon() {}
    open(host: HTMLElement) { host.append(this.input); }
    focus() { this.input.focus(); }
    write() {}
    reset() {}
    dispose() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { Dock } from "./Dock";
import { useDock, type DockApi } from "./useDock";

const DEBUG_COPY = "Ephemeral debug containers can't be removed. This one stays in the pod until the pod is deleted.";
const nodeCopy = (node: string) =>
  `This starts a privileged pod on ${node} with full access to the node. It is deleted when you close the session, and stops on its own after 1 hour.`;

const cluster = (over: Partial<Cluster> = {}): Cluster => ({
  id: "c1",
  name: "aks-prod-weu",
  context_name: "aks-prod-weu",
  server: "https://x",
  original_server: null,
  provider: "aks",
  region: null,
  environment: "production",
  state: "ready",
  message: null,
  ...over,
});
const aks = cluster();
const eks = cluster({ id: "c2", name: "eks-staging", provider: "eks" });

const shell = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  kind: "shell",
  cluster: aks,
  namespace: "payments",
  pod: "payments-api-xk2pq",
  container: "app",
  containers: ["app"],
  ...over,
});

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

let dock: DockApi;
function Harness() {
  dock = useDock([aks, eks]);
  return (
    <>
      <button type="button" onClick={() => dock.askNodeShell("c1", "aks-np1-03")}>node shell</button>
      <Dock dock={dock} />
    </>
  );
}

function renderDock() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
}

const open = (s: Session) => act(() => dock.dispatch({ type: "open", session: s }));
/** Opens a shell and waits for its pane (the terminal loads lazily) to connect. */
async function openShell(s: Session) {
  const before = FakeWebSocket.instances.length;
  open(s);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(before + 1));
}
const shown = () => screen.getAllByRole("tabpanel").filter((p) => !p.hidden);

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("Dock", () => {
  it("says how to open a session while empty", () => {
    renderDock();
    expect(screen.getByText("Open logs (l) or a shell (s) from a pod")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("switching tabs switches the visible identity", async () => {
    renderDock();
    await openShell(shell("a"));
    await openShell(shell("b", { cluster: eks, namespace: "cache", pod: "redis-0", container: "redis" }));
    const [tabA, tabB] = screen.getAllByRole("tab");
    expect(tabA.textContent).toContain("AKS");
    expect(tabA.textContent).toContain("Shell");
    expect(tabA.textContent).toContain("payments-api-xk2pq");
    expect(tabB.getAttribute("aria-selected")).toBe("true");
    expect(tabB.closest("[data-provider]")?.getAttribute("data-provider")).toBe("eks");

    let [pane] = shown();
    expect(within(pane).getByRole("region", { name: /shell/i }).getAttribute("data-provider")).toBe("eks");
    expect(pane.textContent).toContain("eks-staging / cache / redis-0");
    expect(pane.textContent).toContain("(redis)");
    expect(pane.textContent).not.toContain("aks-prod-weu");

    fireEvent.click(tabA);
    expect(tabA.getAttribute("aria-selected")).toBe("true");
    expect(tabB.getAttribute("aria-selected")).toBe("false");
    [pane] = shown();
    expect(within(pane).getByRole("region", { name: /shell/i }).getAttribute("data-provider")).toBe("aks");
    expect(pane.textContent).toContain("aks-prod-weu / payments / payments-api-xk2pq");
    expect(pane.textContent).not.toContain("eks-staging");
    // Both shells stay connected; only the visible one changed.
    expect(FakeWebSocket.instances.filter((w) => !w.closedByClient)).toHaveLength(2);
  });

  it("closes a tab with its × button", async () => {
    renderDock();
    await openShell(shell("a"));
    fireEvent.click(screen.getByRole("button", { name: /^Close shell aks-prod-weu/ }));
    expect(screen.queryByRole("tab")).toBeNull();
    expect(FakeWebSocket.last.closedByClient).toBe(true);
    expect(screen.getByText("Open logs (l) or a shell (s) from a pod")).toBeTruthy();
  });

  it("middle-click closes only the targeted background session", () => {
    renderDock();
    open({ ...shell("a", { pod: "orders-worker" }), kind: "logs" });
    open({ ...shell("b", { pod: "redis-0" }), kind: "logs" });
    const [tabA, tabB] = screen.getAllByRole("tab");
    const [socketA, socketB] = FakeWebSocket.instances;

    fireEvent.click(tabA);
    expect(tabA.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tabB);
    expect(tabB.getAttribute("aria-selected")).toBe("true");
    const [pane] = shown();

    fireEvent.contextMenu(tabA, { button: 2 });
    fireEvent(tabA, new MouseEvent("auxclick", { bubbles: true, button: 2 }));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    fireEvent(within(tabA).getByText("orders-worker"), new MouseEvent("auxclick", { bubbles: true, button: 1 }));

    expect(screen.getAllByRole("tab")).toEqual([tabB]);
    expect(shown()).toEqual([pane]);
    expect(tabB.getAttribute("aria-selected")).toBe("true");
    expect(socketA.closedByClient).toBe(true);
    expect(socketB.closedByClient).toBe(false);
    expect(FakeWebSocket.instances).toEqual([socketA, socketB]);
  });

  it("suppresses middle-button auto-scroll on the session wrapper only", () => {
    renderDock();
    open({ ...shell("a"), kind: "logs" });
    const tab = screen.getByRole("tab");
    expect(fireEvent.mouseDown(tab, { button: 1 })).toBe(false);
    expect(fireEvent.mouseDown(tab, { button: 0 })).toBe(true);
    expect(fireEvent.mouseDown(screen.getByRole("tablist"), { button: 1 })).toBe(true);
  });

  it("Ctrl \\ toggles the layout", async () => {
    renderDock();
    await openShell(shell("a"));
    await openShell(shell("b", { pod: "redis-0" }));
    const toggle = screen.getByRole("button", { name: /side by side/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(dock.state.layout).toBe("split");
  });

  it("side by side is disabled with one session and says why", async () => {
    renderDock();
    await openShell(shell("a"));
    const toggle = screen.getByRole("button", { name: /side by side/i });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("title")).toBe("Open a second log or shell to see two side by side.");
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(dock.state.layout).toBe("single");
    await openShell(shell("b", { pod: "redis-0" }));
    expect(toggle.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(toggle);
    expect(shown()).toHaveLength(2);
  });

  it.each(["logs", "shell"] as const)("two %s side by side", async (kind) => {
    renderDock();
    if (kind === "shell") {
      await openShell(shell("a"));
      await openShell(shell("b", { pod: "redis-0" }));
    } else {
      open({ ...shell("a"), kind });
      open({ ...shell("b", { pod: "redis-0" }), kind });
    }
    fireEvent.click(screen.getByRole("button", { name: /side by side/i }));
    const panes = shown();
    expect(panes).toHaveLength(2);
    expect(panes[0].textContent).toContain("payments-api-xk2pq");
    expect(panes[1].textContent).toContain("redis-0");
  });

  it.each(["a", "b"])("closing one of two side-by-side sessions shows the other alone (%s)", async (id) => {
    renderDock();
    await openShell(shell("a"));
    await openShell(shell("b", { pod: "redis-0" }));
    fireEvent.click(screen.getByRole("button", { name: /side by side/i }));
    expect(shown()).toHaveLength(2);
    act(() => dock.dispatch({ type: "close", id }));
    expect(shown()).toHaveLength(1);
    expect(shown()[0].textContent).toContain(id === "a" ? "redis-0" : "payments-api-xk2pq");
  });

  it("dock is labelled logs and shells", async () => {
    renderDock();
    expect(screen.getByRole("region", { name: "Logs and shells" }).getAttribute("data-page-keys")).toBe("off");
    await openShell(shell("a"));
    expect(screen.getByRole("region", { name: "Logs and shells" }).getAttribute("data-page-keys")).toBe("off");
    expect(screen.getByRole("tablist", { name: "Logs and shells" })).toBeTruthy();
  });

  it("arrowing across session tabs keeps focus on the tabs", async () => {
    renderDock();
    await openShell(shell("a"));
    await openShell(shell("b", { pod: "redis-0" }));
    const [a, b] = screen.getAllByRole("tab");
    act(() => b.focus());
    fireEvent.keyDown(b, { key: "ArrowLeft" });
    expect(a.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b);
    // Clicking into a terminal still moves focus there and selects its session.
    const input = shown()[0].querySelector("textarea")!;
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
  });

  it("a newly opened shell takes focus after navigating the tabs", async () => {
    renderDock();
    await openShell(shell("a"));
    const tab = screen.getByRole("tab");
    act(() => tab.focus());
    await openShell(shell("b", { pod: "redis-0" }));
    await waitFor(() => expect(document.activeElement).toBe(shown()[0].querySelector("textarea")));
  });

  it("Tab from a shell tab keeps focus on its close button", async () => {
    const user = userEvent.setup();
    renderDock();
    await openShell(shell("a"));
    await openShell(shell("b", { pod: "redis-0" }));
    await user.click(screen.getAllByRole("tab")[1]);
    await user.tab();
    expect(document.activeElement).toBe(screen.getAllByRole("button", { name: /^Close shell/ })[1]);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /side by side/i }));
    await user.tab();
    expect(document.activeElement).toBe(shown()[0].querySelector("textarea"));
  });

  it("clicking the layout after shell tab navigation keeps focus on the control", async () => {
    const user = userEvent.setup();
    renderDock();
    await openShell(shell("a"));
    await openShell(shell("b", { pod: "redis-0" }));
    await user.click(screen.getAllByRole("tab")[1]);
    const target = screen.getByRole("button", { name: /side by side/i });
    await user.click(target);
    expect(document.activeElement).toBe(target);
  });

  it("Tabbing back to the grip after shell tab navigation keeps focus on the grip", async () => {
    const user = userEvent.setup();
    renderDock();
    await openShell(shell("a"));
    await openShell(shell("b", { pod: "redis-0" }));
    await user.click(screen.getAllByRole("tab")[1]);
    await user.tab({ shift: true }); // the background tab's close button
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("separator", { name: "Resize the dock" }));
  });

  it("Ctrl F searches the focused log when two logs are side by side", () => {
    renderDock();
    open({ ...shell("a"), kind: "logs" });
    open({ ...shell("b", { pod: "redis-0" }), kind: "logs" });
    fireEvent.click(screen.getByRole("button", { name: /side by side/i }));
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(within(shown()[1]).getByRole("searchbox", { name: "Search logs" }));
  });

  it("exec failure offers a debug container", async () => {
    const fetch = vi.fn(() => json({ container: "debugger-x7k2p", target: null }));
    vi.stubGlobal("fetch", fetch);
    renderDock();
    await openShell(shell("a"));
    act(() => FakeWebSocket.last.emit({ type: "error", message: "Can't open a shell: container app isn't running (CrashLoopBackOff)." }));
    fireEvent.click(screen.getByRole("button", { name: "Start a debug container" }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(DEBUG_COPY)).toBeTruthy();
    expect(dialog.textContent).toContain("aks-prod-weu / payments / payments-api-xk2pq");
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start debug container" }));

    await waitFor(() => expect(FakeWebSocket.last.params.get("container")).toBe("debugger-x7k2p"));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith(
      "/api/clusters/c1/pods/payments/payments-api-xk2pq/debug",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ target: "app" }) }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const ws = FakeWebSocket.last;
    expect(ws.params.get("pod")).toBe("payments-api-xk2pq");
    expect(ws.params.get("container")).toBe("debugger-x7k2p");
    const [pane] = shown();
    expect(pane.textContent).toContain("(debugger-x7k2p)");
    // Ruling R12: the server dropped the target because app isn't running; say so.
    expect(pane.textContent).toContain("It isn't attached to app's processes because app isn't running.");
  });

  it("a debug container that couldn't start says why in plain words", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ detail: "Not allowed to add a debug container to pod payments/payments-api-xk2pq." }, 502)));
    renderDock();
    await openShell(shell("a"));
    act(() => FakeWebSocket.last.emit({ type: "error", message: "Can't open a shell: container app isn't running (Completed)." }));
    fireEvent.click(screen.getByRole("button", { name: "Start a debug container" }));
    fireEvent.click(screen.getByRole("button", { name: "Start debug container" }));
    expect(await screen.findByText("Not allowed to add a debug container to pod payments/payments-api-xk2pq.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("node shell confirm copy exact and opens with cleanupPod", async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => json({ namespace: "default", pod: "omnikrux-node-shell-a1b2c", container: "shell" }))
      .mockImplementationOnce(() => json({ namespace: "default", pod: "omnikrux-node-shell-d3e4f", container: "shell" }));
    vi.stubGlobal("fetch", fetch);
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "node shell" }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(nodeCopy("aks-np1-03"))).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start node shell" }));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith("/api/clusters/c1/nodes/aks-np1-03/shell", expect.objectContaining({ method: "POST" }));
    let ws = FakeWebSocket.last;
    expect(ws.params.get("pod")).toBe("omnikrux-node-shell-a1b2c");
    expect(ws.params.get("namespace")).toBe("default");
    expect(ws.params.get("cleanup_pod")).toBe("true");
    expect(screen.getByRole("tab").textContent).toContain("Node");

    // The server deleted that pod when the session ended: starting again makes a new one.
    act(() => ws.emit({ type: "exit", code: 0, message: null }));
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    expect(within(screen.getByRole("alertdialog")).getByText(nodeCopy("aks-np1-03"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start node shell" }));
    await waitFor(() => expect(FakeWebSocket.last.params.get("pod")).toBe("omnikrux-node-shell-d3e4f"));
    ws = FakeWebSocket.last;
    expect(ws.params.get("cleanup_pod")).toBe("true");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("escape cancels a confirm without a request", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "node shell" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an open that resolves late never takes focus from a newer one", async () => {
    const rowOf = (cluster_id: string, name: string): ResourceRow => ({
      uid: name, cluster_id, kind: "Pod", namespace: "payments", name, created_at: null, labels: {},
      columns: { status: "Running", status_class: "ok", resource_version: "1" },
    });
    const describe = (name: string) => ({
      pod: { name, namespace: "payments", status: "Running", status_class: "ok", node: "n1", pod_ip: null, host_ip: null,
        qos: null, service_account: null, owner: null, started_at: null, resource_version: "1" },
      containers: [{ name: "app", state: "Running", state_class: "ok" }],
      init_containers: [], ephemeral_containers: [], conditions: [], labels: {}, annotations: {}, events: [], events_error: null,
    });
    let slowAnswer!: () => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/clusters/c1/")) {
        // Cluster A answers slowly.
        return new Promise<Response>((resolve) => {
          slowAnswer = () => void json(describe("api-a")).then(resolve);
        });
      }
      return json(describe("api-b"));
    }));
    renderDock();
    act(() => dock.openPod(rowOf("c1", "api-a"), "shell"));
    act(() => dock.openPod(rowOf("c2", "api-b"), "shell"));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(FakeWebSocket.last.params.get("pod")).toBe("api-b");

    await act(async () => slowAnswer());
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    // A's tab is there, but B (the newer request, where you're typing) keeps the focus.
    const [tabB, tabA] = screen.getAllByRole("tab");
    expect(tabA.textContent).toContain("api-a");
    expect(tabB.getAttribute("aria-selected")).toBe("true");
    expect(tabA.getAttribute("aria-selected")).toBe("false");
    const [pane] = shown();
    expect(pane.textContent).toContain("eks-staging / payments / api-b");
    fireEvent.click(screen.getByRole("button", { name: /side by side/i }));
    expect(shown()).toHaveLength(2);
    expect(tabB.getAttribute("aria-selected")).toBe("true");
  });

  describe("a late open never moves focus past a newer choice of yours", () => {
    const rowOf = (cluster_id: string, name: string): ResourceRow => ({
      uid: name, cluster_id, kind: "Pod", namespace: "payments", name, created_at: null, labels: {},
      columns: { status: "Running", status_class: "ok", resource_version: "1" },
    });
    const describeBody = (name: string) => ({
      pod: { name, namespace: "payments", status: "Running", status_class: "ok", node: "n1", pod_ip: null, host_ip: null,
        qos: null, service_account: null, owner: null, started_at: null, resource_version: "1" },
      containers: [{ name: "app", state: "Running", state_class: "ok" }],
      init_containers: [], ephemeral_containers: [], conditions: [], labels: {}, annotations: {}, events: [], events_error: null,
    });
    let slowAnswer!: () => void;
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn((url: string) => {
        if (url.endsWith("/describe")) {
          // The describe of api-a (cluster aks) answers slowly.
          return new Promise<Response>((resolve) => {
            slowAnswer = () => void json(describeBody("api-a")).then(resolve);
          });
        }
        return json({ namespace: "default", pod: "omnikrux-node-shell-a1b2c", container: "shell" });
      }));
    });
    const selected = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")!;

    it("a tab you click keeps the focus", async () => {
      renderDock();
      await openShell(shell("x"));
      await openShell(shell("y", { cluster: eks, namespace: "cache", pod: "redis-0", container: "redis" }));
      act(() => dock.openPod(rowOf("c1", "api-a"), "shell"));
      fireEvent.click(screen.getAllByRole("tab")[0]); // back to x, and typing there
      expect(selected().textContent).toContain("payments-api-xk2pq");

      await act(async () => slowAnswer());
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
      expect(selected().textContent).toContain("payments-api-xk2pq");
      expect(shown()[0].textContent).toContain("aks-prod-weu / payments / payments-api-xk2pq");
    });

    it("closing a background tab keeps a pending open's focus", async () => {
      const user = userEvent.setup();
      renderDock();
      await openShell(shell("x"));
      await openShell(shell("y", { pod: "redis-0" }));
      await user.click(screen.getAllByRole("tab")[1]);
      act(() => dock.openPod(rowOf("c1", "api-a"), "shell"));
      await user.click(screen.getAllByRole("button", { name: /^Close shell/ })[0]);
      await act(async () => slowAnswer());
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
      expect(selected().textContent).toContain("api-a");
      expect(shown()[0].textContent).toContain("api-a");
    });

    it("closing the focused tab cancels a pending open's focus", async () => {
      renderDock();
      await openShell(shell("x"));
      await openShell(shell("y", { pod: "redis-0" }));
      act(() => dock.openPod(rowOf("c1", "api-a"), "shell"));
      fireEvent.click(screen.getAllByRole("button", { name: /^Close shell/ })[1]);
      await act(async () => slowAnswer());
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
      expect(selected().textContent).toContain("payments-api-xk2pq");
    });

    it("a node shell you confirmed keeps the focus", async () => {
      renderDock();
      act(() => dock.openPod(rowOf("c1", "api-a"), "shell"));
      fireEvent.click(screen.getByRole("button", { name: "node shell" }));
      fireEvent.click(screen.getByRole("button", { name: "Start node shell" }));
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
      expect(selected().textContent).toContain("omnikrux-node-shell-a1b2c");

      await act(async () => slowAnswer());
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
      expect(selected().textContent).toContain("omnikrux-node-shell-a1b2c");
    });

    it("focusing inside the selected pane cancels a pending open's focus", async () => {
      renderDock();
      await openShell(shell("x"));
      await openShell(shell("y", { cluster: eks, namespace: "cache", pod: "redis-0", container: "redis" }));
      act(() => dock.openPod(rowOf("c1", "api-a"), "shell")); // slow describe, from the table
      // Back into Y's terminal, which is already the selected tab: keys go there again.
      fireEvent.focusIn(shown()[0]);
      expect(selected().textContent).toContain("redis-0");

      await act(async () => slowAnswer());
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
      expect(selected().textContent).toContain("redis-0");
      expect(shown()).toHaveLength(1);
      expect(shown()[0].textContent).toContain("eks-staging / cache / redis-0");
    });
  });

  it("cancel can't be used while the request runs, and a restart whose tab closed still opens", async () => {
    let answer!: (r: Response) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(() => json({ namespace: "default", pod: "omnikrux-node-shell-a1b2c", container: "shell" }))
      .mockImplementationOnce(() => new Promise<Response>((r) => { answer = r; }));
    vi.stubGlobal("fetch", fetch);
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "node shell" }));
    fireEvent.click(screen.getByRole("button", { name: "Start node shell" }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.last.emit({ type: "exit", code: 0, message: null }));
    fireEvent.click(screen.getByRole("button", { name: "Start again" }));
    fireEvent.click(screen.getByRole("button", { name: "Start node shell" }));

    // The pod is being made: neither Escape nor Cancel can drop it on the floor.
    const dialog = screen.getByRole("alertdialog");
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    act(() => dock.cancel());
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    // The old tab goes away meanwhile; the new pod still gets its session (and so its cleanup).
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); // once the terminal's code is in
    const old = dock.state.sessions[0].id;
    act(() => dock.dispatch({ type: "close", id: old }));
    await act(async () => answer(new Response(JSON.stringify({ namespace: "default", pod: "omnikrux-node-shell-d3e4f", container: "shell" }), { status: 200, headers: { "content-type": "application/json" } })));
    await waitFor(() => expect(FakeWebSocket.last.params.get("pod")).toBe("omnikrux-node-shell-d3e4f"));
    expect(FakeWebSocket.last.params.get("cleanup_pod")).toBe("true");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("in split layout, focusing a pane selects its tab", async () => {
    renderDock();
    open({ ...shell("l"), kind: "logs" });
    await openShell(shell("s", { cluster: eks, pod: "redis-0", container: "redis" }));
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    expect(shown()).toHaveLength(2);
    const [logsTab, shellTab] = screen.getAllByRole("tab");
    expect(shellTab.getAttribute("aria-selected")).toBe("true");
    act(() => screen.getByRole("log").focus());
    expect(logsTab.getAttribute("aria-selected")).toBe("true");
    expect(shellTab.getAttribute("aria-selected")).toBe("false");
    expect(shown()).toHaveLength(2);
  });
});
