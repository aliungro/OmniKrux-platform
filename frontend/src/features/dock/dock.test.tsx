import { useRef } from "react";
import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { clusterLifecycle } from "../../api/clusterLifecycle";
import type { Cluster, ResourceRow } from "../../api/types";
import { container, describeBody } from "../../test/describe";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import { componentCss } from "../../test/css";
import type { Session } from "./dockState";
import tabStyles from "./SessionTabs.module.css";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    input = document.createElement("textarea");
    loadAddon() {}
    // As xterm draws it: the helper textarea inside a .xterm root.
    open(host: HTMLElement) {
      const root = document.createElement("div");
      root.className = "xterm";
      root.append(this.input);
      host.append(root);
    }
    attachCustomKeyEventHandler() {}
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

import { pressed } from "../chrome/shortcuts";
import { Dock, type DockHandle } from "./Dock";
import { useDock, type DockApi } from "./useDock";

const DEBUG_COPY = "Ephemeral debug containers can't be removed. This one stays in the pod until the pod is deleted.";
const nodeCopy = (node: string) =>
  `This starts a privileged pod on ${node} with full access to the node. It is deleted when you close the session, and stops on its own after 1 hour.`;

const cluster = (over: Partial<Cluster> = {}): Cluster => ({
  id: "c1",
  name: "aks-prod-weu",
  context_name: "aks-prod-weu",
  server: "https://x",
  ...FILE_CLUSTER_METADATA, original_server: null,
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
/** How many times the dock handed the keyboard back to the workspace. */
let returns = 0;
function Harness() {
  dock = useDock([aks, eks]);
  const workspace = useRef<HTMLButtonElement>(null);
  const handle = useRef<DockHandle>(null);
  return (
    <>
      {/* Stands in for the table row: Alt+Down moves into the logs, as Shell's page keys do. */}
      <button ref={workspace} type="button" onClick={() => dock.askNodeShell("c1", "aks-np1-03")}
        onKeyDown={(e) => {
          if (!pressed("enterLogs", e)) return;
          e.preventDefault();
          if (!e.repeat) handle.current?.enter();
        }}>node shell</button>
      <Dock ref={handle} dock={dock} onFocusWorkspace={() => { returns += 1; workspace.current?.focus(); }} />
    </>
  );
}

function renderDock() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>), client };
}

const open = (s: Session) => act(() => dock.dispatch({ type: "open", session: s }));
/** Opens a shell and waits for its pane (the terminal loads lazily) to connect. */
async function openShell(s: Session) {
  const before = FakeWebSocket.instances.length;
  open(s);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(before + 1));
}
const shown = () => screen.getAllByRole("tabpanel").filter((p) => !p.hidden);

const demoPod: ResourceRow = {
  uid: "demo-pod", cluster_id: "c1", kind: "Pod", namespace: "demo", name: "two-containers", created_at: null,
  labels: {}, columns: { ready: "1/2", resource_version: "1" },
};
const web = container({ name: "web", state: "Running", state_class: "ok", ready: true });
const helper = container({ name: "helper", state: "Waiting: CrashLoopBackOff" });
const twoContainers = describeBody({
  containers: [web, helper],
  init_containers: [container({ name: "prepare", state: "Terminated: Completed" })],
  ephemeral_containers: [container({ name: "debugger", state: "Running" })],
});

beforeEach(() => {
  returns = 0;
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

  it("opening logs from a row leaves focus on the row", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(twoContainers)));
    renderDock();
    // The workspace button stands in for the table row the keys were pressed on.
    const row = screen.getByRole("button", { name: "node shell" });
    row.focus();
    act(() => dock.openFollow(demoPod)); // L
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    act(() => dock.openPod(demoPod, "logs", { previous: true })); // p
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    act(() => dock.openPinned(demoPod)); // Shift+L
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(3));
    expect(dock.state.sessions.map((x) => [x.follow ?? false, x.previous ?? false, x.pinned ?? false])).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]);
    // The newest is selected, as a click's is, and the keyboard stays on the row.
    expect(dock.state.focused).toBe(dock.state.sessions[2].id);
    expect(document.activeElement).toBe(row);
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

  it("shows a compact, named layout icon with the dock shortcut in its tooltip", async () => {
    renderDock();
    await openShell(shell("a"));
    await openShell(shell("b", { pod: "redis-0" }));
    const toggle = screen.getByRole("button", { name: "Side by side" });
    expect(toggle.getAttribute("title")).toBe("Side by side (Ctrl+\\)");
    expect(toggle.textContent).toBe("");
    expect(toggle.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("side by side is disabled with one session and says why", async () => {
    renderDock();
    await openShell(shell("a"));
    const toggle = screen.getByRole("button", { name: /side by side/i });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("title")).toBe("Side by side (Ctrl+\\). Open a second log or shell to use it.");
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

  describe("pod shell container choice", () => {
    const choose = () => screen.findByRole("combobox", { name: "Container" }) as Promise<HTMLSelectElement>;

    it("lists regular containers and starts one shell only after confirming the chosen one", async () => {
      vi.stubGlobal("fetch", vi.fn(() => json(twoContainers)));
      renderDock();
      act(() => dock.openPod(demoPod, "shell"));

      const select = await choose();
      const dialog = screen.getByRole("dialog", { name: "Open shell" });
      expect(dialog.textContent).toContain("aks-prod-weu / demo / two-containers");
      expect(select.value).toBe("web");
      expect(document.activeElement).toBe(select);
      expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
        "web · Running", "helper · Waiting: CrashLoopBackOff",
      ]);
      expect(FakeWebSocket.instances).toHaveLength(0);
      fireEvent.change(select, { target: { value: "helper" } });
      expect(FakeWebSocket.instances).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole("button", { name: "Open shell" }));

      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      expect(FakeWebSocket.last.params.get("pod")).toBe("two-containers");
      expect(FakeWebSocket.last.params.get("container")).toBe("helper");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("preselects the annotated regular container and Escape cancels the choice", async () => {
      vi.stubGlobal("fetch", vi.fn(() => json({
        ...twoContainers, annotations: { "kubectl.kubernetes.io/default-container": "helper" },
      })));
      renderDock();
      act(() => dock.openPod(demoPod, "shell"));
      expect((await choose()).value).toBe("helper");
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it("opens a single regular container directly despite init and ephemeral containers", async () => {
      vi.stubGlobal("fetch", vi.fn(() => json({ ...twoContainers, containers: [web] })));
      renderDock();
      act(() => dock.openPod(demoPod, "shell"));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      expect(FakeWebSocket.last.params.get("container")).toBe("web");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("discards a pending describe after cancelling the lookup", async () => {
      let resolve!: (response: Response) => void;
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
      renderDock();
      act(() => dock.openPod(demoPod, "shell"));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await act(async () => resolve(await json(twoContainers)));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(dock.state.sessions).toEqual([]);
    });

    it("discards a slow single-container response after a newer shell open", async () => {
      let resolve!: (response: Response) => void;
      vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("two-containers")
        ? new Promise<Response>((done) => { resolve = done; })
        : json(describeBody({ containers: [helper] }))));
      renderDock();
      act(() => dock.openPod(demoPod, "shell"));
      act(() => dock.openPod({ ...demoPod, name: "newer" }, "shell"));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      await act(async () => resolve(await json(describeBody({ containers: [web] }))));
      expect(dock.state.sessions.map((session) => session.pod)).toEqual(["newer"]);
      expect(FakeWebSocket.last.params.get("pod")).toBe("newer");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("offers a retry when describe fails for a pod known to have multiple containers", async () => {
      vi.stubGlobal("fetch", vi.fn()
        .mockImplementationOnce(() => json({ detail: "Pod details are unavailable." }, 503))
        .mockImplementationOnce(() => json(twoContainers)));
      renderDock();
      act(() => dock.openPod(demoPod, "shell"));
      const dialog = screen.getByRole("dialog");
      expect((await within(dialog).findByRole("alert")).textContent).toContain("Pod details are unavailable.");
      expect(within(dialog).queryByRole("button", { name: /default/i })).toBeNull();
      expect(FakeWebSocket.instances).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
      expect((await choose()).value).toBe("web");
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it("explains a failed describe before allowing the server default when the count is unknown", async () => {
      vi.stubGlobal("fetch", vi.fn(() => json({ detail: "Pod details are unavailable." }, 503)));
      renderDock();
      act(() => dock.openPod({ ...demoPod, columns: {} }, "shell"));
      const dialog = screen.getByRole("dialog");
      expect((await within(dialog).findByRole("alert")).textContent).toContain("Pod details are unavailable.");
      expect(FakeWebSocket.instances).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole("button", { name: "Open default shell" }));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      expect(FakeWebSocket.last.params.has("container")).toBe(false);
    });
  });

  it("a log open that resolves late never takes focus from a newer one", async () => {
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
    act(() => dock.openPod(rowOf("c1", "api-a"), "logs"));
    act(() => dock.openPod(rowOf("c2", "api-b"), "logs"));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(FakeWebSocket.last.params.get("pod")).toBe("api-b");

    await act(async () => slowAnswer());
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    // A's tab is there, but B (the newer request) keeps the focus.
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

  describe("the follow log", () => {
    const rowOf = (name: string): ResourceRow => ({
      uid: name, cluster_id: "c1", kind: "Pod", namespace: "payments", name, created_at: null, labels: {},
      columns: { status: "Running", status_class: "ok", resource_version: "1" },
    });
    const oneContainer = describeBody({ containers: [web] });
    const live = () => FakeWebSocket.instances.filter((w) => w.url.includes("/api/logs") && !w.closedByClient);
    const flush = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });

    it("L opens one follow log on the default container", async () => {
      const annotated = describeBody({
        ...twoContainers,
        annotations: { "kubectl.kubernetes.io/default-container": "helper" },
      });
      vi.stubGlobal("fetch", vi.fn((url: string) => {
        if (url.includes("/two-containers/")) return json(annotated);
        if (url.includes("/broken/")) return json({ detail: "boom" }, 500);
        return json(twoContainers);
      }));
      renderDock();
      act(() => dock.openFollow(demoPod));
      await waitFor(() => expect(dock.state.sessions).toHaveLength(1));
      const [followed] = dock.state.sessions;
      expect(followed).toMatchObject({ follow: true, pod: "two-containers", container: "helper" });
      expect(followed.containers).toEqual(expect.arrayContaining(["web", "helper"]));
      expect(dock.state.focused).toBe(followed.id);
      expect(live()).toHaveLength(1);
      expect(live()[0].params.get("container")).toBe("helper");

      // No annotation: the first container, even though helper is the one failing.
      act(() => dock.openFollow({ ...demoPod, uid: "plain", name: "plain" }));
      await waitFor(() => expect(dock.state.sessions[0].pod).toBe("plain"));
      expect(dock.state.sessions).toHaveLength(1);
      expect(dock.state.sessions[0]).toMatchObject({ id: followed.id, container: "web" });

      // A failed describe still follows the pod, on the server's choice of container.
      act(() => dock.openFollow({ ...demoPod, uid: "broken", name: "broken" }));
      await waitFor(() => expect(dock.state.sessions[0].pod).toBe("broken"));
      expect(dock.state.sessions[0]).toMatchObject({ id: followed.id, container: null, containers: [] });
    });

    it("a late describe never retargets over a newer row", async () => {
      let answerA!: () => void;
      vi.stubGlobal("fetch", vi.fn((url: string) => {
        if (url.includes("/api-a/")) {
          return new Promise<Response>((resolve) => {
            answerA = () => void json(oneContainer).then(resolve);
          });
        }
        return json(oneContainer);
      }));
      renderDock();
      act(() => dock.openFollow(rowOf("api-x")));
      await waitFor(() => expect(dock.state.sessions).toHaveLength(1));
      const id = dock.state.sessions[0].id;

      act(() => dock.followRow(rowOf("api-a"))); // slow
      act(() => dock.followRow(rowOf("api-b")));
      await waitFor(() => expect(dock.state.sessions[0].pod).toBe("api-b"));
      await act(async () => answerA());
      await flush();
      expect(dock.state.sessions).toHaveLength(1);
      expect(dock.state.sessions[0]).toMatchObject({ id, pod: "api-b" });
      expect(live().map((w) => w.params.get("pod"))).toEqual(["api-b"]);
    });

    it("pinFollow copies the follow target into a pinned tab without taking focus", async () => {
      vi.stubGlobal("fetch", vi.fn(() => json(twoContainers)));
      renderDock();
      act(() => dock.pinFollow()); // nothing to pin yet
      expect(dock.state.sessions).toHaveLength(0);
      act(() => dock.openFollow(demoPod));
      await waitFor(() => expect(dock.state.sessions).toHaveLength(1));
      const followId = dock.state.sessions[0].id;

      act(() => dock.pinFollow());
      expect(dock.state.sessions).toHaveLength(2);
      const pinned = dock.state.sessions[1];
      expect(pinned).toMatchObject({ pinned: true, cluster: aks, namespace: "demo", pod: "two-containers", container: "web" });
      expect(pinned.follow).toBeUndefined();
      expect(pinned.id).not.toBe(followId);
      expect(dock.state.focused).toBe(followId);
      expect(screen.getAllByRole("tab")).toHaveLength(2);

      // Pinned again: the tab is already there.
      act(() => dock.pinFollow());
      expect(dock.state.sessions).toHaveLength(2);
      expect(dock.state.focused).toBe(followId);
    });

    it("the follow log uses one socket at a time", async () => {
      vi.stubGlobal("fetch", vi.fn(() => json(oneContainer)));
      renderDock();
      act(() => dock.openFollow(rowOf("api-a")));
      await waitFor(() => expect(live()).toHaveLength(1));
      const panel = screen.getByRole("tabpanel");
      const first = live()[0];

      act(() => dock.followRow(rowOf("api-b")));
      await waitFor(() => expect(live()[0]?.params.get("pod")).toBe("api-b"));
      expect(live()).toHaveLength(1);
      expect(first.closedByClient).toBe(true);
      // One tab, and the same pane: the session was retargeted in place.
      expect(screen.getAllByRole("tab")).toHaveLength(1);
      expect(screen.getByRole("tabpanel")).toBe(panel);
    });

    it("following the followed pod again clears its hold without a describe", async () => {
      const fetch = vi.fn(() => json(oneContainer));
      vi.stubGlobal("fetch", fetch);
      renderDock();
      act(() => dock.followRow(rowOf("api-a"))); // no follow log yet: nothing to retarget
      expect(fetch).not.toHaveBeenCalled();
      act(() => dock.openFollow(rowOf("api-a")));
      await waitFor(() => expect(dock.state.sessions).toHaveLength(1));
      act(() => dock.holdFollow("notPod"));
      expect(dock.state.sessions[0].hold).toBe("notPod");
      const calls = fetch.mock.calls.length;
      act(() => dock.followRow(rowOf("api-a")));
      expect(dock.state.sessions[0].hold).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(calls);
    });

    it("closing the follow tab during a retarget opens nothing", async () => {
      let answerA!: () => void;
      vi.stubGlobal("fetch", vi.fn((url: string) => {
        if (url.includes("/api-a/")) {
          return new Promise<Response>((resolve) => {
            answerA = () => void json(oneContainer).then(resolve);
          });
        }
        return json(oneContainer);
      }));
      renderDock();
      act(() => dock.openFollow(rowOf("api-x")));
      await waitFor(() => expect(dock.state.sessions).toHaveLength(1));
      act(() => dock.followRow(rowOf("api-a"))); // slow
      act(() => dock.dispatch({ type: "close", id: dock.state.sessions[0].id }));
      await act(async () => answerA());
      await flush();
      expect(dock.state.sessions).toHaveLength(0);
      expect(screen.queryByRole("tab")).toBeNull();
    });

    it("removing the follow log's cluster during a retarget to another cluster opens nothing", async () => {
      let answerB!: () => void;
      vi.stubGlobal("fetch", vi.fn((url: string) => {
        if (url.includes("/clusters/c2/")) {
          return new Promise<Response>((resolve) => {
            answerB = () => void json(oneContainer).then(resolve);
          });
        }
        return json(oneContainer);
      }));
      const { client } = renderDock();
      act(() => dock.openFollow(rowOf("api-x")));
      await waitFor(() => expect(dock.state.sessions).toHaveLength(1));
      act(() => dock.followRow({ ...rowOf("api-b"), cluster_id: "c2" })); // slow, on eks
      act(() => clusterLifecycle(client).remove(aks.id));
      expect(dock.state.sessions).toHaveLength(0);
      await act(async () => answerB());
      await flush();
      expect(dock.state.sessions).toHaveLength(0);
      expect(screen.queryByRole("tab")).toBeNull();
    });

    it("pinning from the follow log and Shift+L on the same pod give one pinned tab", async () => {
      // The follow log reads web (the first container); Shift+L would pick helper (failing).
      vi.stubGlobal("fetch", vi.fn(() => json(twoContainers)));
      renderDock();
      act(() => dock.openFollow(demoPod));
      await waitFor(() => expect(dock.state.sessions).toHaveLength(1));
      act(() => dock.pinFollow());
      expect(dock.state.sessions).toHaveLength(2);
      const pinnedId = dock.state.sessions[1].id;
      act(() => dock.openPinned(demoPod));
      await waitFor(() => expect(dock.state.focused).toBe(pinnedId));
      expect(dock.state.sessions).toHaveLength(2);
      expect(dock.state.sessions.filter((x) => x.pinned)).toHaveLength(1);

      // And the other way round: Shift+L first, then pin from the follow log.
      cleanup();
      FakeWebSocket.instances = [];
      renderDock();
      act(() => dock.openPinned(demoPod));
      await waitFor(() => expect(dock.state.sessions).toHaveLength(1));
      act(() => dock.openFollow(demoPod));
      await waitFor(() => expect(dock.state.sessions).toHaveLength(2));
      act(() => dock.pinFollow());
      expect(dock.state.sessions.filter((x) => x.pinned)).toHaveLength(1);
    });

    it("a follow whose cluster is removed during its describe opens nothing", async () => {
      let finish!: (response: Response) => void;
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
      const { client } = renderDock();
      act(() => dock.openFollow(demoPod));
      await act(async () => {
        clusterLifecycle(client).remove(aks.id);
        finish(await json(twoContainers));
      });
      await flush();
      expect(dock.state.sessions).toHaveLength(0);
      expect(screen.queryByRole("tab")).toBeNull();
    });
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
      act(() => dock.openPod(rowOf("c1", "api-a"), "logs"));
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
      act(() => dock.openPod(rowOf("c1", "api-a"), "logs"));
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
      act(() => dock.openPod(rowOf("c1", "api-a"), "logs"));
      fireEvent.click(screen.getAllByRole("button", { name: /^Close shell/ })[1]);
      await act(async () => slowAnswer());
      await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
      expect(selected().textContent).toContain("payments-api-xk2pq");
    });

    it("a node shell you confirmed keeps the focus", async () => {
      renderDock();
      act(() => dock.openPod(rowOf("c1", "api-a"), "logs"));
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
      act(() => dock.openPod(rowOf("c1", "api-a"), "logs")); // slow describe, from the table
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

function openKeyboardTestLog(id: string) {
  open(shell(id, { kind: "logs", pod: id, containers: ["app", "sidecar"] }));
  return screen.getByRole("tab", { name: new RegExp(`^Logs: .* / ${id} \\(`) });
}

const workspaceButton = () => screen.getByRole("button", { name: "node shell" });
const logIn = (id: string) => {
  const panel = shown().find((p) => p.getAttribute("data-dock-session") === id);
  if (!panel) throw new Error(`${id} is not shown`);
  return within(panel).getByRole("log");
};
const tabOf = (id: string) => screen.getByRole("tab", { name: new RegExp(`/ ${id} \\(`) });

it("esc on a split peer returns to the workspace and closes nothing", () => {
  renderDock();
  openKeyboardTestLog("first");
  openKeyboardTestLog("second");
  fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
  const peer = within(shown()[0]).getByRole("log");
  peer.focus();
  expect(fireEvent.keyDown(peer, { key: "Escape" })).toBe(false);
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(FakeWebSocket.instances.every((w) => !w.closedByClient)).toBe(true);
  expect(document.activeElement).toBe(workspaceButton());
});

it.each(["log", "searchbox"])("Alt+Up leaves a live stream from %s", (role) => {
  renderDock();
  openKeyboardTestLog("api");
  const control = screen.getByRole(role);
  control.focus();
  expect(fireEvent.keyDown(control, { key: "ArrowUp", altKey: true })).toBe(false);
  expect(document.activeElement).toBe(workspaceButton());
  expect(FakeWebSocket.last.closedByClient).toBe(false);
});

it("alt+down moves into the focused log and esc returns to the same row", () => {
  renderDock();
  openKeyboardTestLog("first");
  openKeyboardTestLog("second");
  const row = workspaceButton();
  row.focus();
  expect(fireEvent.keyDown(row, { key: "ArrowDown", altKey: true })).toBe(false);
  expect(document.activeElement).toBe(logIn("second"));
  expect(fireEvent.keyDown(document.activeElement!, { key: "Escape" })).toBe(false);
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(document.activeElement).toBe(row);
  expect(FakeWebSocket.instances.every((w) => !w.closedByClient)).toBe(true);
});

it("alt+down into a shell gives its terminal the keyboard", async () => {
  renderDock();
  await openShell(shell("sh"));
  const terminal = screen.getByRole("textbox");
  const row = workspaceButton();
  row.focus();
  fireEvent.keyDown(row, { key: "ArrowDown", altKey: true });
  await waitFor(() => expect(document.activeElement).toBe(terminal));
});

it("a held escape returns once and closes nothing", () => {
  renderDock();
  openKeyboardTestLog("api");
  const log = screen.getByRole("log");
  log.focus();
  // A repeat that arrives on the log is swallowed and does nothing.
  expect(fireEvent.keyDown(log, { key: "Escape", repeat: true })).toBe(false);
  expect(document.activeElement).toBe(log);
  expect(returns).toBe(0);
  expect(fireEvent.keyDown(log, { key: "Escape" })).toBe(false);
  expect(returns).toBe(1);
  for (let i = 0; i < 5; i++) fireEvent.keyDown(document.activeElement!, { key: "Escape", repeat: true });
  expect(returns).toBe(1);
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(FakeWebSocket.last.closedByClient).toBe(false);
  expect(document.activeElement).toBe(workspaceButton());
});

it("alt+down with nothing open says so", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    renderDock();
    const row = workspaceButton();
    row.focus();
    expect(screen.getByRole("status").textContent).toBe("Open logs (l) or a shell (s) from a pod");
    fireEvent.keyDown(row, { key: "ArrowDown", altKey: true });
    expect(screen.getByRole("status").textContent).toBe("No logs open yet: press L on a pod first.");
    expect(document.activeElement).toBe(row);
    act(() => vi.advanceTimersByTime(3_900));
    expect(screen.getByRole("status").textContent).toBe("No logs open yet: press L on a pod first.");
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("status").textContent).toBe("Open logs (l) or a shell (s) from a pod");
  } finally {
    vi.useRealTimers();
  }
});

it("left and right switch dock tabs from the log", async () => {
  renderDock();
  openKeyboardTestLog("a");
  openKeyboardTestLog("b");
  await openShell(shell("c", { pod: "redis-0" }));
  act(() => dock.dispatch({ type: "focus", id: "a" }));
  logIn("a").focus();
  expect(fireEvent.keyDown(logIn("a"), { key: "ArrowRight" })).toBe(false);
  expect(dock.state.focused).toBe("b");
  expect(document.activeElement).toBe(logIn("b"));
  // A shell's terminal would take the arrows: its tab button gets the focus instead.
  fireEvent.keyDown(logIn("b"), { key: "ArrowRight" });
  expect(dock.state.focused).toBe("c");
  const shellTab = screen.getByRole("tab", { name: /^Shell/ });
  expect(document.activeElement).toBe(shellTab);
  await act(async () => {});
  expect(document.activeElement).toBe(shellTab);
  // The tablist's own arrows wrap around to the first tab.
  fireEvent.keyDown(shellTab, { key: "ArrowRight" });
  expect(dock.state.focused).toBe("a");
  // And from the first log, left wraps around to the last.
  logIn("a").focus();
  fireEvent.keyDown(logIn("a"), { key: "ArrowLeft" });
  expect(dock.state.focused).toBe("c");
  expect(document.activeElement).toBe(shellTab);
});

it("alt+up from the log viewport returns to the table and alt+left is not a tab switch", () => {
  renderDock();
  openKeyboardTestLog("a");
  openKeyboardTestLog("b");
  const log = logIn("b");
  log.focus();
  for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    expect(fireEvent.keyDown(log, { key: "ArrowLeft", ...init })).toBe(true);
    expect(fireEvent.keyDown(log, { key: "ArrowRight", ...init })).toBe(true);
  }
  expect(dock.state.focused).toBe("b");
  expect(document.activeElement).toBe(log);
  expect(fireEvent.keyDown(log, { key: "ArrowUp", altKey: true })).toBe(false);
  expect(document.activeElement).toBe(workspaceButton());
  expect(screen.getAllByRole("tab")).toHaveLength(2);
});

it("ctrl+delete closes the highlighted tab and focus moves to the next", () => {
  renderDock();
  openKeyboardTestLog("a");
  openKeyboardTestLog("b");
  openKeyboardTestLog("c");
  fireEvent.click(tabOf("b"));
  logIn("b").focus();
  expect(fireEvent.keyDown(logIn("b"), { key: "Delete", ctrlKey: true })).toBe(false);
  expect(dock.state.sessions.map((x) => x.id)).toEqual(["a", "c"]);
  expect(document.activeElement).toBe(logIn("c"));
  // From the tab button, and with the macOS key: the neighbour takes over, as in a browser.
  tabOf("c").focus();
  expect(fireEvent.keyDown(tabOf("c"), { key: "Backspace", metaKey: true })).toBe(false);
  expect(dock.state.sessions.map((x) => x.id)).toEqual(["a"]);
  expect(document.activeElement).toBe(logIn("a"));
  // A held key closes once.
  openKeyboardTestLog("d");
  logIn("d").focus();
  expect(fireEvent.keyDown(logIn("d"), { key: "Delete", ctrlKey: true, repeat: true })).toBe(false);
  expect(dock.state.sessions.map((x) => x.id)).toEqual(["a", "d"]);
  // The close button of a tab closes that tab.
  const close = screen.getByRole("button", { name: /^Close logs .* \/ a \(/ });
  close.focus();
  fireEvent.keyDown(close, { key: "Delete", ctrlKey: true });
  expect(dock.state.sessions.map((x) => x.id)).toEqual(["d"]);
  expect(document.activeElement).toBe(logIn("d"));
  expect(returns).toBe(0);
});

it("closing the last tab with ctrl+delete returns to the same row", () => {
  renderDock();
  openKeyboardTestLog("api");
  const row = workspaceButton();
  row.focus();
  fireEvent.keyDown(row, { key: "ArrowDown", altKey: true });
  const log = screen.getByRole("log");
  expect(document.activeElement).toBe(log);
  expect(fireEvent.keyDown(log, { key: "Delete", ctrlKey: true })).toBe(false);
  expect(screen.queryByRole("tab")).toBeNull();
  expect(FakeWebSocket.last.closedByClient).toBe(true);
  expect(document.activeElement).toBe(row);
});

it("ctrl+delete in the log search or a terminal never closes", async () => {
  renderDock();
  await openShell(shell("sh"));
  const terminal = screen.getByRole("textbox");
  openKeyboardTestLog("api");
  const search = screen.getByRole("searchbox");
  search.focus();
  expect(fireEvent.keyDown(search, { key: "Delete", ctrlKey: true })).toBe(true);
  expect(fireEvent.keyDown(search, { key: "Backspace", metaKey: true })).toBe(true);
  expect(fireEvent.keyDown(search, { key: "Backspace", ctrlKey: true })).toBe(true);
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(document.activeElement).toBe(search);
  fireEvent.click(screen.getByRole("tab", { name: /^Shell/ }));
  act(() => terminal.focus());
  expect(fireEvent.keyDown(terminal, { key: "Delete", ctrlKey: true })).toBe(true);
  expect(fireEvent.keyDown(terminal, { key: "Backspace", metaKey: true })).toBe(true);
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(document.activeElement).toBe(terminal);
  expect(FakeWebSocket.instances.every((w) => !w.closedByClient)).toBe(true);
});

it("shift+L in the follow log pins its pod", async () => {
  vi.stubGlobal("fetch", vi.fn(() => json(twoContainers)));
  renderDock();
  act(() => dock.openFollow(demoPod));
  await waitFor(() => expect(dock.state.sessions).toHaveLength(1));
  const log = screen.getByRole("log");
  log.focus();
  expect(fireEvent.keyDown(log, { key: "L", shiftKey: true })).toBe(false);
  expect(dock.state.sessions).toHaveLength(2);
  expect(dock.state.sessions[1]).toMatchObject({ pinned: true, pod: "two-containers" });
  expect(document.activeElement).toBe(log);
  // Held, it pins once; from the follow tab, it pins the same pod (already pinned: one tab).
  fireEvent.keyDown(log, { key: "L", shiftKey: true, repeat: true });
  const followTab = screen.getAllByRole("tab")[0];
  followTab.focus();
  fireEvent.keyDown(followTab, { key: "L", shiftKey: true });
  expect(dock.state.sessions).toHaveLength(2);
  // On a pinned log it means nothing.
  fireEvent.click(screen.getAllByRole("tab")[1]);
  const pinnedLog = within(shown()[0]).getByRole("log");
  pinnedLog.focus();
  expect(fireEvent.keyDown(pinnedLog, { key: "L", shiftKey: true })).toBe(true);
  expect(dock.state.sessions).toHaveLength(2);
});

it("shift+l reported as a lower-case l in the follow log still pins", async () => {
  vi.stubGlobal("fetch", vi.fn(() => json(twoContainers)));
  renderDock();
  act(() => dock.openFollow(demoPod));
  await waitFor(() => expect(dock.state.sessions).toHaveLength(1));
  const log = screen.getByRole("log");
  log.focus();
  expect(fireEvent.keyDown(log, { key: "l", shiftKey: true })).toBe(false);
  expect(dock.state.sessions).toHaveLength(2);
  expect(dock.state.sessions[1]).toMatchObject({ pinned: true, pod: "two-containers" });
});

it("closing the focused follow tab by cluster removal rescues focus", async () => {
  vi.stubGlobal("fetch", vi.fn(() => json(twoContainers)));
  const { client } = renderDock();
  act(() => dock.openFollow(demoPod));
  await waitFor(() => expect(dock.state.sessions).toHaveLength(1));
  const log = screen.getByRole("log");
  log.focus();
  act(() => clusterLifecycle(client).remove(aks.id));
  expect(dock.state.sessions).toHaveLength(0);
  expect(log.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement).toBe(workspaceButton());
});

it("the close button names ctrl+delete", async () => {
  renderDock();
  openKeyboardTestLog("api");
  await openShell(shell("sh"));
  for (const close of [
    screen.getByRole("button", { name: /Close logs.*api/ }),
    screen.getByRole("button", { name: /Close shell/ }),
  ]) {
    expect(close.getAttribute("title")).toBe("Close (Ctrl+Del)");
    expect(close.getAttribute("aria-keyshortcuts")).toBe("Control+Delete");
  }
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");
  try {
    openKeyboardTestLog("other");
    const close = screen.getByRole("button", { name: /Close logs.*other/ });
    expect(close.getAttribute("title")).toBe("Close (⌘⌫)");
    expect(close.getAttribute("aria-keyshortcuts")).toBe("Meta+Backspace");
  } finally {
    platform.mockRestore();
  }
  // Tab still crosses the dock's edge both ways.
  const workspace = workspaceButton();
  const resize = screen.getByRole("separator", { name: "Resize the dock" });
  workspace.focus();
  const user = userEvent.setup();
  await user.tab();
  expect(document.activeElement).toBe(resize);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(workspace);
});

it("the first escape clears the search, the second goes back to the table", () => {
  renderDock();
  openKeyboardTestLog("api");
  const search = screen.getByRole<HTMLInputElement>("searchbox");
  search.focus();
  fireEvent.change(search, { target: { value: "failure" } });
  expect(fireEvent.keyDown(search, { key: "Escape" })).toBe(false);
  expect(search.value).toBe("");
  expect(document.activeElement).toBe(search);
  // The held first press doesn't carry on out of the logs.
  expect(fireEvent.keyDown(search, { key: "Escape", repeat: true })).toBe(false);
  expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: "Escape" });
  expect(document.activeElement).toBe(workspaceButton());
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(FakeWebSocket.last.closedByClient).toBe(false);
});

it("keeps Escape and Alt+Up out of the native container picker, composition, and modal", () => {
  renderDock();
  const tab = openKeyboardTestLog("api");
  const picker = screen.getByRole("combobox", { name: "Container" });
  picker.focus();
  expect(fireEvent.keyDown(picker, { key: "Escape" })).toBe(true);
  expect(fireEvent.keyDown(picker, { key: "ArrowUp", altKey: true })).toBe(true);
  expect(fireEvent.keyDown(picker, { key: "Delete", ctrlKey: true })).toBe(true);
  expect(document.activeElement).toBe(picker);
  tab.focus();
  expect(fireEvent.keyDown(tab, { key: "Escape", isComposing: true })).toBe(true);
  expect(fireEvent.keyDown(tab, { key: "ArrowUp", altKey: true, isComposing: true })).toBe(true);
  fireEvent.click(workspaceButton());
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  tab.focus();
  expect(fireEvent.keyDown(tab, { key: "Escape" })).toBe(true);
  expect(fireEvent.keyDown(tab, { key: "ArrowUp", altKey: true })).toBe(true);
  expect(fireEvent.keyDown(tab, { key: "Delete", ctrlKey: true })).toBe(true);
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(returns).toBe(0);
  expect(FakeWebSocket.last.closedByClient).toBe(false);
});

it("ctrl+delete on a log beside a shell does not autofocus the shell", async () => {
  renderDock();
  await openShell(shell("terminal"));
  const terminal = screen.getByRole("textbox");
  expect(document.activeElement).toBe(terminal);
  // Esc belongs to the terminal (vim, less); Alt+Up leaves it.
  expect(fireEvent.keyDown(terminal, { key: "Escape" })).toBe(true);
  expect(document.activeElement).toBe(terminal);
  expect(fireEvent.keyDown(terminal, { key: "ArrowUp", altKey: true })).toBe(false);
  expect(document.activeElement).toBe(workspaceButton());
  openKeyboardTestLog("api");
  const log = screen.getByRole("log");
  log.focus();
  fireEvent.keyDown(log, { key: "Delete", ctrlKey: true });
  const shellTab = screen.getByRole("tab", { name: /Shell/ });
  expect(shellTab.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(shellTab);
  await act(async () => {});
  expect(document.activeElement).toBe(shellTab);
  expect(FakeWebSocket.instances[0].closedByClient).toBe(false);
});

it.each([
  ["alt+up", { key: "ArrowUp", altKey: true }],
  ["esc", { key: "Escape" }],
] as const)("%s on the grip leaves the height alone and returns to the row", (_, init) => {
  renderDock();
  openKeyboardTestLog("api");
  const row = workspaceButton();
  const grip = screen.getByRole("separator", { name: "Resize the dock" });
  const height = grip.getAttribute("aria-valuenow");
  grip.focus();
  expect(fireEvent.keyDown(grip, init)).toBe(false);
  expect(grip.getAttribute("aria-valuenow")).toBe(height);
  expect(dock.state.height).toBe(Number(height));
  expect(document.activeElement).toBe(row);
  // The grip's own keys still resize, and only without a modifier.
  grip.focus();
  for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    expect(fireEvent.keyDown(grip, { key: "ArrowDown", ...mod })).toBe(true);
  }
  expect(grip.getAttribute("aria-valuenow")).toBe(height);
  expect(screen.getAllByRole("tab")).toHaveLength(1);
});

it.each(["alt+up", "esc"])("%s on the side-by-side button returns to the row", (which) => {
  renderDock();
  openKeyboardTestLog("a");
  openKeyboardTestLog("b");
  const layout = screen.getByRole("button", { name: "Side by side" });
  layout.focus();
  const init = which === "esc" ? { key: "Escape" } : { key: "ArrowUp", altKey: true };
  expect(fireEvent.keyDown(layout, init)).toBe(false);
  expect(document.activeElement).toBe(workspaceButton());
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(dock.state.layout).toBe("single");
});

it("an arrow to the tab that is already selected never pulls the focus back later", () => {
  renderDock();
  openKeyboardTestLog("a");
  openKeyboardTestLog("b");
  fireEvent.click(screen.getByRole("button", { name: "Side by side" }));
  expect(dock.state.focused).toBe("b");
  // The arrow arrives on the peer's log while b is still the selected tab: nothing to dispatch.
  fireEvent.keyDown(logIn("a"), { key: "ArrowRight" });
  expect(dock.state.focused).toBe("b");
  expect(document.activeElement).toBe(logIn("b"));
  // Back on the table, a later change in the dock (a log opened quietly) leaves the focus there.
  const row = workspaceButton();
  row.focus();
  act(() => dock.dispatch({ type: "open", session: shell("c", { kind: "logs", pod: "c" }), focus: false }));
  expect(dock.state.sessions).toHaveLength(3);
  expect(document.activeElement).toBe(row);
});

describe("one row of tabs and the open menu", () => {
  const logs = (id: string, over: Partial<Session> = {}): Session => shell(id, { kind: "logs", ...over });
  /** A 60-character pod name. */
  const longPod = (i: number) => `orders-ledger-reconciler-${String(i).padStart(2, "0")}-`.padEnd(60, "q");
  /** Twenty logs, the fifth on a pod whose name says "crash"; the last one opened is selected. */
  const openTwenty = () => {
    for (let i = 0; i < 20; i++) {
      open(logs(i === 4 ? "crash" : `s${i}`, i === 4 ? { pod: "crasher-7f9c6d-x2kq9", namespace: "demo" } : { pod: longPod(i) }));
    }
  };
  /** The tablist is wider inside than it is drawn: its tabs don't fit. */
  const overflowing = () => {
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) { return this.getAttribute("role") === "tablist" ? 4000 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) { return this.getAttribute("role") === "tablist" ? 800 : 0; },
    });
  };
  const menuButton = () => screen.getByRole("button", { name: "All 20 open logs and shells" });
  const openMenu = () => {
    fireEvent.click(menuButton());
    return screen.getByRole("combobox", { name: "Find a log or shell" });
  };

  afterEach(() => {
    delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    document.head.querySelectorAll("style[data-test-css]").forEach((x) => x.remove());
  });

  it("twenty long sessions stay on one row with the open menu", () => {
    const css = document.createElement("style");
    css.dataset.testCss = "";
    css.textContent = componentCss(import.meta.url, "./SessionTabs.module.css", tabStyles);
    document.head.append(css);
    overflowing();
    renderDock();
    openTwenty();
    const strip = screen.getByRole("tablist", { name: "Logs and shells" });
    expect(within(strip).getAllByRole("tab")).toHaveLength(20);
    expect(getComputedStyle(strip).flexWrap).toBe("nowrap");
    const button = menuButton();
    expect(button.textContent).toBe("20 open");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // It sits between the tabs and the layout toggle.
    expect(strip.nextElementSibling).toBe(button);
    expect(button.nextElementSibling).toBe(screen.getByRole("button", { name: "Side by side" }));
  });

  it("crowded tabs keep a readable name and leave the rest to the menu", async () => {
    const css = document.createElement("style");
    css.dataset.testCss = "";
    css.textContent = componentCss(import.meta.url, "./SessionTabs.module.css", tabStyles);
    document.head.append(css);
    vi.stubGlobal("fetch", vi.fn(() => json(twoContainers)));
    overflowing();
    renderDock();
    openTwenty();
    act(() => dock.openFollow(demoPod));
    await waitFor(() => expect(dock.state.sessions).toHaveLength(21));
    const wrapper = (tab: HTMLElement) => tab.closest<HTMLElement>(`.${tabStyles.sess}`)!;
    const [follow] = screen.getAllByRole("tab").filter((t) => wrapper(t).hasAttribute("data-follow"));
    const plain = screen.getByRole("tab", { name: /crasher/ });
    // About ten letters of a pod beside its badge (not a three-letter stub); the follow tab also
    // keeps its marker, and grows further to keep its name while it is selected.
    expect(getComputedStyle(wrapper(plain)).minWidth).toBe("148px");
    // 10ch, which jsdom computes at 8px a ch.
    expect(getComputedStyle(plain.querySelector(`.${tabStyles.pod}`)!).minWidth).toBe("80px");
    expect(getComputedStyle(wrapper(follow)).minWidth).toBe("232px");
    expect(getComputedStyle(wrapper(follow)).maxWidth).toBe("280px");
    expect(screen.getByRole("button", { name: "All 21 open logs and shells" }).textContent).toBe("21 open");
  });

  /**
   * As Chrome lays the strip out: 800px wide, and its tabs fit only while a short tab is selected
   * (the selected tab doesn't shrink and shows its close button, so a long one pushes the rest out).
   */
  const fitsWithShortSelected = () => {
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("role") !== "tablist") return 0;
        const selected = this.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "";
        return selected.includes("orders-ledger") ? 1100 : 760;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) { return this.getAttribute("role") === "tablist" ? 800 : 0; },
    });
  };
  const openFour = () => {
    open(logs("long", { pod: longPod(1) }));
    for (const id of ["a", "b", "c"]) open(logs(id, { pod: `web-${id}` }));
  };
  const menuOf = (n: number) => screen.queryByRole("button", { name: `All ${n} open logs and shells` });

  it("the open menu is hidden while tabs fit", () => {
    fitsWithShortSelected();
    renderDock();
    openFour();
    expect(menuOf(4)).toBeNull();
    // Selecting the long tab pushes the rest out of the strip; a short one again lets them fit.
    fireEvent.click(screen.getByRole("tab", { name: /orders-ledger/ }));
    expect(menuOf(4)).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /web-b/ }));
    expect(menuOf(4)).toBeNull();
  });

  it("selecting a long tab shows the menu, so clipped tabs stay reachable", () => {
    fitsWithShortSelected();
    renderDock();
    openFour();
    expect(menuOf(4)).toBeNull();
    // By keyboard: the arrows walk from web-a back to the long tab.
    const tab = screen.getByRole("tab", { name: /web-a/ });
    fireEvent.click(tab);
    fireEvent.keyDown(tab, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: /orders-ledger/ }).getAttribute("aria-selected")).toBe("true");
    expect(menuOf(4)?.textContent).toBe("4 open");
  });

  it("the menu finds a session and picking it selects its tab", () => {
    overflowing();
    renderDock();
    openTwenty();
    const find = openMenu();
    expect(document.activeElement).toBe(find);
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("dialog", { name: "Open logs and shells" });
    const list = within(menu).getByRole("listbox");
    expect(find.getAttribute("aria-controls")).toBe(list.id);
    expect(within(list).getAllByRole("option")).toHaveLength(20);
    // The selected session is the selected option, and the active one to start with.
    const selected = within(list).getByRole("option", { selected: true });
    expect(selected.getAttribute("title")).toBe(`aks-prod-weu / payments / ${longPod(19)} (app)`);
    expect(find.getAttribute("aria-activedescendant")).toBe(selected.id);

    fireEvent.change(find, { target: { value: "CRASH" } });
    const [only, ...rest] = within(list).getAllByRole("option");
    expect(rest).toHaveLength(0);
    expect(only.textContent).toBe("AKScrasher-7f9c6d-x2kq9 · demo");
    expect(only.getAttribute("title")).toBe("aks-prod-weu / demo / crasher-7f9c6d-x2kq9 (app)");
    expect(find.getAttribute("aria-activedescendant")).toBe(only.id);

    fireEvent.keyDown(find, { key: "Enter" });
    const tab = screen.getByRole("tab", { name: /crasher-7f9c6d-x2kq9/ });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("arrows move the active option and a click picks one", () => {
    overflowing();
    renderDock();
    openTwenty();
    const find = openMenu();
    const options = () => within(screen.getByRole("listbox")).getAllByRole("option");
    fireEvent.keyDown(find, { key: "ArrowDown" }); // from the last, round to the first
    expect(find.getAttribute("aria-activedescendant")).toBe(options()[0].id);
    fireEvent.keyDown(find, { key: "ArrowUp" });
    expect(find.getAttribute("aria-activedescendant")).toBe(options()[19].id);
    fireEvent.click(options()[4]);
    const tab = screen.getByRole("tab", { name: /crasher/ });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the menu says when nothing matches", () => {
    overflowing();
    renderDock();
    openTwenty();
    const find = openMenu();
    fireEvent.change(find, { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(within(screen.getByRole("dialog")).getByText('Nothing matches "zzz".')).toBeTruthy();
    // Enter with nothing to pick does nothing.
    fireEvent.keyDown(find, { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("the filter matches the marker and the kind", () => {
    overflowing();
    renderDock();
    openTwenty();
    act(() => dock.dispatch({ type: "open", session: logs("p", { pod: "stuck", pinned: true }) }));
    fireEvent.click(screen.getByRole("button", { name: "All 21 open logs and shells" }));
    const find = screen.getByRole("combobox", { name: "Find a log or shell" });
    fireEvent.change(find, { target: { value: "pinned" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["AKS📌stuck · payments"]);
    fireEvent.change(find, { target: { value: "shell" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    fireEvent.change(find, { target: { value: "logs" } });
    expect(screen.getAllByRole("option")).toHaveLength(21);
  });

  it("escape closes only the menu", () => {
    overflowing();
    renderDock();
    openTwenty();
    const find = openMenu();
    fireEvent.keyDown(find, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(20);
    expect(document.activeElement).toBe(menuButton());
    expect(returns).toBe(0);
    // With the menu open and the keyboard back on its button, Esc there closes only the menu too.
    fireEvent.click(menuButton());
    act(() => menuButton().focus());
    fireEvent.keyDown(menuButton(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(menuButton());
    expect(returns).toBe(0);
  });

  it("a click outside closes the menu and focus returns to its button", () => {
    overflowing();
    renderDock();
    openTwenty();
    openMenu();
    fireEvent.pointerDown(screen.getByRole("region", { name: "Logs and shells" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });

  it("picking a session that closed meanwhile keeps focus on the menu button", () => {
    overflowing();
    renderDock();
    openTwenty();
    const find = openMenu();
    fireEvent.change(find, { target: { value: "crash" } });
    act(() => dock.dispatch({ type: "close", id: "crash" }));
    fireEvent.keyDown(find, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    const button = screen.getByRole("button", { name: "All 19 open logs and shells" });
    expect(document.activeElement).toBe(button);
    expect(dock.state.sessions).toHaveLength(19);
    expect(returns).toBe(0);
  });

  it("picking a session that closed meanwhile, with the menu button gone, focuses the selected tab", () => {
    overflowing();
    renderDock();
    openTwenty();
    const find = openMenu();
    fireEvent.change(find, { target: { value: "crash" } });
    // Everything fits again once it closes.
    delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    act(() => dock.dispatch({ type: "close", id: "crash" }));
    fireEvent.keyDown(find, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /open logs and shells/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("tab", { selected: true }));
    expect(returns).toBe(0);
  });

  it("follow and pinned tabs carry their markers", () => {
    renderDock();
    open(logs("f", { pod: "crasher", follow: true }));
    open(logs("p", { pod: "stuck", pinned: true }));
    const follow = screen.getByRole("tab", { name: /^Logs Follows row: aks-prod-weu \/ payments \/ crasher/ });
    expect(follow.textContent).toContain("◉ follows row");
    const pinned = screen.getByRole("tab", { name: /^Logs Pinned: aks-prod-weu \/ payments \/ stuck/ });
    expect(pinned.textContent).toContain("📌");
    expect(within(pinned).getByText("📌").getAttribute("aria-hidden")).toBe("true");
  });

  it("tabs show the pod name and keep the full identity in the title", () => {
    renderDock();
    open(logs("a", { pod: "payments-api-xk2pq", container: "app" }));
    open(logs("b", { pod: "payments-api-xk2pq", previous: true }));
    const [plain, previous] = screen.getAllByRole("tab");
    expect(plain.textContent).toBe("AKSpayments-api-xk2pq");
    expect(plain.getAttribute("title")).toBe("Logs: aks-prod-weu / payments / payments-api-xk2pq (app)");
    expect(plain.getAttribute("aria-label")).toBe("Logs: aks-prod-weu / payments / payments-api-xk2pq (app)");
    expect(previous.textContent).toBe("AKSPreviouspayments-api-xk2pq");
    expect(previous.getAttribute("aria-label")).toBe("Logs Previous: aks-prod-weu / payments / payments-api-xk2pq (app)");
  });
});
