// frontend/src/App.test.tsx
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { applyMessage, emptyWatchState, type WatchState } from "./api/watchState";
import type { WatchOptions } from "./api/useWatch";
import { FakeWebSocket } from "./features/logs/fakeWebSocket";
import { Console } from "./App";

// The dock imports the terminal; jsdom has no canvas for it, and these tests open no shell.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const watch = vi.hoisted(() => ({ state: null as WatchState | null, opts: undefined as WatchOptions | undefined }));
vi.mock("./api/useWatch", () => ({
  useWatch: (_kind: string, opts?: WatchOptions) => {
    watch.opts = opts;
    return watch.state;
  },
}));

const cluster = { id: "c1", name: "kind-omnikrux-dev", context_name: "kind-omnikrux-dev", server: "https://127.0.0.1:6443", original_server: null, provider: "kind", region: null, environment: "development", state: "ready", message: null };
const pod = (uid: string, status: string, cls: string) => ({ uid, cluster_id: "c1", kind: "Pod", namespace: "default", name: uid, created_at: null, columns: { status, status_class: cls, node: "n1", last_restart_at: null } });

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
}

beforeEach(() => {
  watch.state = emptyWatchState();
  watch.opts = undefined;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Console page states", () => {
  it("says it is loading clusters", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderConsole();
    expect(screen.getByText("Loading clusters…")).toBeTruthy();
  });
  it("shows the load error and tries again", async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => json({ detail: "database is locked" }, 500))
      .mockImplementation(() => json([cluster]));
    vi.stubGlobal("fetch", fetch);
    renderConsole();
    expect(await screen.findByText("Can't load clusters: database is locked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("scope-token")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("explains how to add clusters when there are none", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json([])));
    renderConsole();
    expect(await screen.findByText("No clusters yet. Mount your kubeconfig at /kube/config and restart the console.")).toBeTruthy();
  });
});

describe("Console wiring", () => {
  it("feeds live watch state into scope tokens, the pods tab and filter counts", async () => {
    let w = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    w = applyMessage(w, { type: "snapshot", cluster_id: "c1", part: 0, last: true,
      rows: [pod("a", "Running", "ok"), pod("b", "CrashLoopBackOff", "bad"), pod("c", "Pending", "warn")] });
    watch.state = w;
    vi.stubGlobal("fetch", vi.fn(() => json([cluster])));
    renderConsole();
    const token = await screen.findByTestId("scope-token");
    expect(token.textContent).toBe("KINDkind-omnikrux-dev1 failing");
    expect(screen.getByRole("tab").textContent).toBe("Pods3");
    expect(screen.getByRole("button", { name: "Failing 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pending 1" })).toBeTruthy();
    expect(screen.getByRole("grid", { name: "Pods by cluster" })).toBeTruthy();
  });
  it("scope token uses the watch state over the cluster list", async () => {
    watch.state = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "error", message: "Can't reach this cluster: timeout" });
    vi.stubGlobal("fetch", vi.fn(() => json([cluster])));
    renderConsole();
    const token = await screen.findByTestId("scope-token");
    await waitFor(() => expect(token.getAttribute("title")).toBe("Can't reach this cluster: timeout"));
  });
});

describe("Console follows cluster changes", () => {
  it("passes the known cluster ids and reloads the list for an unknown or removed cluster", async () => {
    const fetch = vi.fn(() => json([cluster]));
    vi.stubGlobal("fetch", fetch);
    renderConsole();
    await screen.findByTestId("scope-token");
    await waitFor(() => expect(watch.opts?.knownClusterIds).toEqual(new Set(["c1"])));
    expect(fetch).toHaveBeenCalledTimes(1);
    watch.opts?.onUnknownCluster?.("c2");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    watch.opts?.onClusterRemoved?.("c1");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });
});

describe("Shortcut bar", () => {
  it("shortcut bar lists the keys", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json([cluster])));
    renderConsole();
    const bar = await screen.findByRole("navigation", { name: "Keyboard shortcuts" });
    const items = Array.from(bar.querySelectorAll("li")).map((li) => li.textContent);
    expect(items).toEqual([
      "↑↓ move",
      "Enter details",
      "l logs",
      "p previous logs",
      "s shell",
      "Ctrl F search logs",
      "Ctrl \\ layout",
      "/ filter",
      "? all shortcuts",
    ]);
    fireEvent.keyDown(document.body, { key: "?" });
    const all = screen.getByRole("dialog", { name: "All shortcuts" });
    expect(all.textContent).toContain("Previous logs");
    expect(all.textContent).toContain("Switch between one pane and side by side");
    fireEvent.keyDown(all, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "All shortcuts" })).toBeNull();
  });
});

describe("Console dock wiring", () => {
  const describeBody = {
    pod: { name: "crasher-1", namespace: "default", status: "CrashLoopBackOff", status_class: "bad", node: "n1", pod_ip: null, host_ip: null, qos: null, service_account: null, owner: null, started_at: null, resource_version: "1" },
    containers: [
      { name: "sidecar", state: "Running", state_class: "ok" },
      { name: "app", state: "Waiting: CrashLoopBackOff", state_class: "bad" },
    ],
    init_containers: [{ name: "init", state: "Terminated: Completed (exit 0)", state_class: "done" }],
    ephemeral_containers: [],
    conditions: [], labels: {}, annotations: {}, events: [], events_error: null,
  };

  beforeEach(() => {
    // jsdom has no layout; give everything a size so the virtualizer renders rows.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    watch.state = applyMessage(
      applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "ready", message: null }),
      { type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [pod("crasher-1", "CrashLoopBackOff", "bad")] },
    );
    vi.stubGlobal("fetch", vi.fn((url: string) => json(url.endsWith("/describe") ? describeBody : [cluster])));
  });

  it("l opens the selected pod's logs, p its previous run, both labelled with the cluster", async () => {
    renderConsole();
    expect(await screen.findByText("Open logs (l) or a shell (s) from a pod")).toBeTruthy();
    const row = (await screen.findByText("crasher-1")).closest<HTMLElement>('[role="row"]')!;
    row.focus();
    fireEvent.keyDown(row, { key: "l" });
    const sessions = () => within(screen.getByRole("tablist", { name: "Sessions" })).getAllByRole("tab");
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const [tab] = sessions();
    expect(tab.textContent).toContain("KIND");
    expect(tab.textContent).toContain("Logs");
    // The failing container is the one shown first; the picker offers every container.
    expect(FakeWebSocket.last.params.get("container")).toBe("app");
    expect(screen.getByRole("combobox", { name: "Container" }).textContent).toBe("initsidecarapp");
    const pane = screen.getAllByRole("tabpanel").find((p) => !p.hidden)!;
    expect(pane.textContent).toContain("kind-omnikrux-dev / default / crasher-1");

    fireEvent.keyDown(row, { key: "l" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(sessions()).toHaveLength(1); // the same session, focused again
    fireEvent.keyDown(row, { key: "p" });
    await waitFor(() => expect(sessions()).toHaveLength(2));
    expect(FakeWebSocket.last.params.get("previous")).toBe("true");
  });
});
