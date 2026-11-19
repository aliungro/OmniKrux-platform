// frontend/src/App.test.tsx
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FILE_CLUSTER_METADATA } from "./test/clusters";
import userEvent from "@testing-library/user-event";
import { applyMessage, emptyWatchState, type WatchState } from "./api/watchState";
import type { WatchOptions } from "./api/useWatch";
import { FakeWebSocket } from "./features/logs/fakeWebSocket";
import { Shell as Console } from "./features/shell/Shell";
import { seedPodsWorkspace } from "./test/seedWorkspace";
import { KINDS } from "./test/kinds";
import { removePinned } from "./test/pinnedKinds";
import { container } from "./test/describe";

// The dock imports the terminal; jsdom has no canvas for it, and these tests open no shell.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const watch = vi.hoisted(() => ({
  state: null as WatchState | null,
  opts: undefined as WatchOptions | undefined,
  /** The kind the page watches for its table (the call that passes options). */
  kind: undefined as string | undefined,
  /** What a second watch (the Nodes view's pods) sees, and which kind it asked for. */
  side: null as WatchState | null,
  sideKind: undefined as string | null | undefined,
}));
vi.mock("./api/useWatch", () => ({
  useWatch: (kind: string | null, opts?: WatchOptions) => {
    if (opts) {
      watch.kind = kind ?? undefined;
      watch.opts = opts;
      return watch.state;
    }
    watch.sideKind = kind;
    return watch.side;
  },
}));

// Counts renders of the real (memoized) table: the mock keeps its memo and swaps in a counting body.
const tableRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock("./features/territories/TerritoryTable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./features/territories/TerritoryTable")>();
  const memoized = actual.TerritoryTable as unknown as { type: (props: unknown) => unknown };
  return {
    ...actual,
    TerritoryTable: { ...memoized, type: (props: unknown) => { tableRenders.n++; return memoized.type(props); } },
  };
});

const cluster = { ...FILE_CLUSTER_METADATA, id: "c1", name: "kind-omnikrux-dev", context_name: "kind-omnikrux-dev", server: "https://127.0.0.1:6443", original_server: null, provider: "kind", region: null, environment: "development", state: "ready", message: null };
const pod = (uid: string, status: string, cls: string) => ({ uid, cluster_id: "c1", kind: "Pod", namespace: "default", name: uid, created_at: null, labels: {}, columns: { status, status_class: cls, node: "n1", last_restart_at: null } });

/** Answers /api/kinds with the test kinds and everything else with `other`. */
function routes(other: (url: string) => unknown) {
  return vi.fn((url: string) => {
    if (url.startsWith("/api/kinds")) return json(KINDS);
    if (url === "/api/port-forwards" || url.startsWith("/api/cloud/")) return json([]);
    if (url === "/api/settings") return json({ encryption: { source: "environment", path: null }, discovery_interval_s: 600 });
    return json(other(url));
  });
}
const clusterCalls = (fetch: { mock: { calls: unknown[][] } }) => fetch.mock.calls.filter(([url]) => url === "/api/clusters").length;

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
}

it("edit pinned kinds opens settings at the section and changes the live row", async () => {
  vi.stubGlobal("fetch", routes(() => [cluster]));
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:scroll});
  try {
    renderConsole();
    const tab = await screen.findByRole("tab",{name:"Pods"});
    fireEvent.contextMenu(tab);
    fireEvent.click(screen.getByRole("menuitem",{name:"Edit pinned kinds…"}));
    expect(await screen.findByRole("heading",{name:"Settings",level:1})).toBeTruthy();
    expect(scroll).toHaveBeenCalled();
    expect(location.hash).toBe("#/settings");
    removePinned("Services");
    fireEvent.click(screen.getByRole("button",{name:"Kubernetes"}));
    expect(screen.queryByRole("tab",{name:"Services"})).toBeNull();
    expect(screen.getByRole("tab",{name:"Pods"})).toBeTruthy();
  } finally {
    delete (HTMLElement.prototype as {scrollIntoView?: unknown}).scrollIntoView;
  }
});

beforeEach(() => {
  seedPodsWorkspace();
  watch.state = emptyWatchState();
  watch.side = emptyWatchState();
  watch.opts = undefined;
  watch.kind = undefined;
  watch.sideKind = undefined;
  window.history.replaceState(null, "", "/");
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
    let first = true;
    const fetch = vi.fn((url: string) => {
      if (url.startsWith("/api/kinds")) return json(KINDS);
      if (url === "/api/port-forwards") return json([]);
      if (first) {
        first = false;
        return json({ detail: "database is locked" }, 500);
      }
      return json([cluster]);
    });
    vi.stubGlobal("fetch", fetch);
    renderConsole();
    expect(await screen.findByText("Can't load clusters: database is locked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("scope-token")).toBeTruthy();
    expect(clusterCalls(fetch)).toBe(2);
  });
  it("explains how to add clusters when there are none", async () => {
    vi.stubGlobal("fetch", routes(() => []));
    renderConsole();
    expect(await screen.findByText("No clusters yet. Mount your kubeconfig at /kube/config and restart the console.")).toBeTruthy();
  });
});

describe("Audit log route", () => {
  it("the Audit log button opens the full view and back returns to the resources", async () => {
    vi.stubGlobal("fetch", routes((url) => (url.startsWith("/api/audit") ? { records: [], next_before: null } : [cluster])));
    renderConsole();
    fireEvent.click(await screen.findByRole("button", { name: "Audit log" }));
    expect(window.location.hash).toBe("#/audit");
    expect(await screen.findByText("Nothing has been changed from Omnikrux yet.")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Pods" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
    expect(window.location.hash).toMatch(/^#\/kubernetes\//);
    expect(await screen.findByRole("tab", { name: "Pods" })).toBeTruthy();
  });
});

describe("Console wiring", () => {
  it("feeds live watch state into scope tokens, the pods tab and filter counts", async () => {
    let w = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    w = applyMessage(w, { type: "snapshot", cluster_id: "c1", part: 0, last: true,
      rows: [pod("a", "Running", "ok"), pod("b", "CrashLoopBackOff", "bad"), pod("c", "Pending", "warn")] });
    watch.state = w;
    vi.stubGlobal("fetch", routes(() => [cluster]));
    renderConsole();
    const token = await screen.findByTestId("scope-token");
    expect(token.textContent).toBe("KINDkind-omnikrux-dev1 failing");
    expect(within(screen.getByRole("tablist", { name: "Kinds" })).getByRole("tab", { selected: true }).textContent).toBe("Pods3");
    expect(screen.getByRole("button", { name: "Failing 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pending 1" })).toBeTruthy();
    expect(screen.getByRole("grid", { name: "Pods by cluster" })).toBeTruthy();
  });
  it("scope token uses the watch state over the cluster list", async () => {
    watch.state = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "error", message: "Can't reach this cluster: timeout" });
    vi.stubGlobal("fetch", routes(() => [cluster]));
    renderConsole();
    const token = await screen.findByTestId("scope-token");
    await waitFor(() => expect(token.getAttribute("title")).toBe("Can't reach this cluster: timeout"));
  });
});

describe("Console follows cluster changes", () => {
  it("passes the known cluster ids and reloads the list for an unknown cluster", async () => {
    const fetch = routes(() => [cluster]);
    vi.stubGlobal("fetch", fetch);
    renderConsole();
    await screen.findByTestId("scope-token");
    await waitFor(() => expect(watch.opts?.knownClusterIds).toEqual(new Set(["c1"])));
    expect(clusterCalls(fetch)).toBe(1);
    watch.opts?.onUnknownCluster?.("c2");
    await waitFor(() => expect(clusterCalls(fetch)).toBe(2));
  });
});

describe("Shortcut bar", () => {
  it("shortcut bar lists the keys", async () => {
    vi.stubGlobal("fetch", routes(() => [cluster]));
    renderConsole();
    const bar = await screen.findByRole("navigation", { name: /^Keyboard shortcuts/ });
    const items = Array.from(bar.querySelectorAll("li")).map((li) => li.textContent);
    expect(items).toEqual([
      "↑↓ move",
      "Enter details",
      "l logs",
      "Shift L pin a log",
      "p previous logs",
      "s shell",
      "f port-forward",
      "Alt ↓ into the logs",
      "Ctrl Del delete",
      ": kinds",
      "Ctrl K commands",
      "/ filter",
      "? all shortcuts",
    ]);
    fireEvent.keyDown(document.body, { key: "?" });
    const all = screen.getByRole("dialog", { name: "All shortcuts" });
    expect(all.textContent).toContain("Previous logs");
    expect(all.textContent).toContain("Switch the bottom dock between one pane and side by side");
    fireEvent.keyDown(all, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "All shortcuts" })).toBeNull();
  });
});

describe("Console dock wiring", () => {
  const describeBody = {
    pod: { name: "crasher-1", namespace: "default", status: "CrashLoopBackOff", status_class: "bad", node: "n1", pod_ip: null, host_ip: null, qos: null, service_account: null, owner: null, started_at: null, resource_version: "1" },
    containers: [
      container({ name: "sidecar", state: "Running", state_class: "ok", restarts: 0, limit_hit: [] }),
      container({ name: "app", state: "Waiting: CrashLoopBackOff", state_class: "bad" }),
    ],
    init_containers: [container({ name: "init", state: "Terminated: Completed (exit 0)", state_class: "done" })],
    ephemeral_containers: [], volumes: [],
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
    vi.stubGlobal("fetch", routes((url) => (url.endsWith("/describe") ? describeBody : [cluster])));
  });

  it("row keys work on load without a click", async () => {
    watch.state = applyMessage(watch.state!, { type: "snapshot", cluster_id: "c1", part: 0, last: true,
      rows: [pod("alpha", "Running", "ok"), pod("beta", "Running", "ok"), pod("gamma", "Running", "ok")] });
    renderConsole();
    const first = (await screen.findByText("alpha")).closest<HTMLElement>('[role="row"]')!;
    // A page load puts the keyboard on the workspace, never on <body>.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "l" });
    expect(await within(await screen.findByRole("tablist", { name: "Logs and shells" })).findByRole("tab")).toBeTruthy();
    await waitFor(() => expect(FakeWebSocket.last.params.get("pod")).toBe("alpha"));
  });

  it("row keys act on the selected row while a kind tab has focus", async () => {
    renderConsole();
    const row = (await screen.findByText("crasher-1")).closest<HTMLElement>('[role="row"]')!;
    fireEvent.click(row);
    const tab = within(screen.getByRole("tablist", { name: "Kinds" })).getByRole("tab", { name: /^Pods/ });
    fireEvent.click(tab);
    tab.focus();
    fireEvent.keyDown(tab, { key: "d" });
    expect(screen.queryByRole("region", { name: "Details for crasher-1" })).toBeNull();
    tab.focus();
    fireEvent.keyDown(tab, { key: "d" });
    expect(screen.getByRole("region", { name: "Details for crasher-1" })).toBeTruthy();
    expect(document.activeElement).toBe(row);
    tab.focus();
    fireEvent.keyDown(tab, { key: "l" });
    expect(await within(await screen.findByRole("tablist", { name: "Logs and shells" })).findByRole("tab")).toBeTruthy();
  });

  it("row shortcuts work after switching apps without clicking the view", async () => {
    renderConsole();
    await screen.findByText("crasher-1");
    fireEvent.keyDown(document.body, {key:"8",code:"Digit8",altKey:true});
    fireEvent.keyDown(document.body, {key:"1",code:"Digit1",altKey:true});
    const main=screen.getByRole("main");
    await waitFor(()=>expect(document.activeElement).toBe(main));
    fireEvent.keyDown(main,{key:"ArrowDown"});
    fireEvent.keyDown(document.activeElement!,{key:"l"});
    expect(await within(await screen.findByRole("tablist",{name:"Logs and shells"})).findByRole("tab")).toBeTruthy();
  });

  it("row shortcuts work after activating a workspace tab", async () => {
    renderConsole();
    await screen.findByText("crasher-1");
    fireEvent.click(screen.getByRole("button",{name:"New tab"}));
    fireEvent.click(screen.getByRole("tab",{name:"Pods · all clusters"}));
    const main=screen.getByRole("main");
    await waitFor(()=>expect(document.activeElement).toBe(main));
    await screen.findByText("crasher-1");
    fireEvent.keyDown(main,{key:"ArrowDown"});
    fireEvent.keyDown(document.activeElement!,{key:"l"});
    expect(await within(await screen.findByRole("tablist",{name:"Logs and shells"})).findByRole("tab")).toBeTruthy();
  });

  it("switching tabs and apps keeps dock sessions", async () => {
    renderConsole();
    const row = (await screen.findByText("crasher-1")).closest<HTMLElement>('[role="row"]')!;
    fireEvent.keyDown(row, { key: "l" });
    const sessions = await screen.findByRole("tablist", { name: "Logs and shells" });
    expect(within(sessions).getAllByRole("tab")).toHaveLength(1);
    const targetSocket = () => FakeWebSocket.instances.find(ws =>
      new URL(ws.url).pathname === "/api/logs" && ws.params.get("cluster") === "c1" &&
      ws.params.get("namespace") === "default" && ws.params.get("pod") === "crasher-1");
    await waitFor(() => expect(targetSocket()).toBeDefined());
    const socket = targetSocket()!;
    expect(socket.closedByClient).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Audit log" }));
    fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
    expect(within(screen.getByRole("tablist", { name: "Logs and shells" })).getAllByRole("tab")).toHaveLength(1);
    expect(socket.closedByClient).toBe(false);
  });

  it("row keys are not taken from the dock or a dialog", async () => {
    const user = userEvent.setup();
    watch.state = applyMessage(watch.state!, { type: "snapshot", cluster_id: "c1", part: 0, last: true,
      rows: [pod("crasher-1", "CrashLoopBackOff", "bad"), pod("other", "Running", "ok")] });
    renderConsole();
    const row = (await screen.findByText("crasher-1")).closest<HTMLElement>('[role="row"]')!;
    fireEvent.keyDown(row, { key: "l" });
    const sessions = await screen.findByRole("tablist", { name: "Logs and shells" });
    const tab = await within(sessions).findByRole("tab");
    tab.focus();
    await user.keyboard("lp"); // p would create a distinct previous-logs session
    expect(within(sessions).getAllByRole("tab")).toHaveLength(1);
    expect(document.activeElement).toBe(tab);
    fireEvent.keyDown(document.body, { key: "?" });
    const dialog = screen.getByRole("dialog", { name: "All shortcuts" });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("typed keys in a field never act on rows", async () => {
    const user = userEvent.setup();
    renderConsole();
    const row = (await screen.findByText("crasher-1")).closest<HTMLElement>('[role="row"]')!;
    fireEvent.click(row);
    const input = screen.getByPlaceholderText("Filter by name, label or image");
    await user.type(input, "l");
    expect((input as HTMLInputElement).value).toBe("l");
    expect(screen.queryByRole("tablist", { name: "Logs and shells" })).toBeNull();
  });

  it("enter on a chrome button still activates it", async () => {
    const user = userEvent.setup();
    renderConsole();
    const row = (await screen.findByText("crasher-1")).closest<HTMLElement>('[role="row"]')!;
    fireEvent.keyDown(row, { key: "l" }); // select without opening details
    const button = screen.getByRole("button", { name: "Commands and kinds" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Commands" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Details for crasher-1" })).toBeNull();
  });

  it("closing the palette opened from the page puts focus on the table row", async () => {
    renderConsole();
    const row = (await screen.findByText("crasher-1")).closest<HTMLElement>('[role="row"]')!;
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));
    fireEvent.keyDown(document.activeElement!, { key: ":" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(document.activeElement).toBe(row);
  });

  it("l opens the selected pod's logs, p its previous run, both labelled with the cluster", async () => {
    renderConsole();
    expect(await screen.findByText("Open logs (l) or a shell (s) from a pod")).toBeTruthy();
    const row = (await screen.findByText("crasher-1")).closest<HTMLElement>('[role="row"]')!;
    row.focus();
    fireEvent.keyDown(row, { key: "l" });
    const sessions = () => within(screen.getByRole("tablist", { name: "Logs and shells" })).getAllByRole("tab");
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const [tab] = sessions();
    expect(tab.textContent).toContain("KIND");
    expect(tab.textContent).toContain("◉ follows row");
    // L follows the pod on its default container (the first, no annotation); the picker offers
    // every container.
    expect(FakeWebSocket.last.params.get("container")).toBe("sidecar");
    expect(screen.getByRole("combobox", { name: "Container" }).textContent).toBe("initsidecarapp");
    const pane = screen.getAllByRole("tabpanel").find((p) => !p.hidden)!;
    expect(pane.textContent).toContain("kind-omnikrux-dev / default / crasher-1");

    fireEvent.keyDown(row, { key: "l" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(sessions()).toHaveLength(1); // the same session, focused again
    fireEvent.keyDown(row, { key: "p" });
    await waitFor(() => expect(sessions()).toHaveLength(2));
    expect(FakeWebSocket.last.params.get("previous")).toBe("true");
    // p still opens on the failing container, since that's the one worth reading.
    expect(FakeWebSocket.last.params.get("container")).toBe("app");
  });

  it("dock dispatch does not re-render the table", async () => {
    renderConsole();
    const row = (await screen.findByText("crasher-1")).closest<HTMLElement>('[role="row"]')!;
    row.focus();
    fireEvent.keyDown(row, { key: "l" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await screen.findByRole("tab", { name: "Deployments" }); // the kinds have loaded
    const grip = screen.getByRole("separator", { name: "Resize the dock" });
    const before = tableRenders.n;
    const height = Number(grip.getAttribute("aria-valuenow"));
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
    await waitFor(() => expect(Number(grip.getAttribute("aria-valuenow"))).toBeGreaterThan(height));
    expect(tableRenders.n).toBe(before);
  });
});

describe("Console kinds", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  });

  it("kind tabs switch the watched kind", async () => {
    vi.stubGlobal("fetch", routes(() => [cluster]));
    renderConsole();
    expect(watch.kind).toBe("pods");
    fireEvent.click(await screen.findByRole("tab", { name: "Deployments" }));
    expect(watch.kind).toBe("deployments.apps");
    expect(window.location.hash).toMatch(/^#\/kubernetes\//);
    expect(within(screen.getByRole("tablist", { name: "Kinds" })).getByRole("tab", { selected: true }).textContent).toBe("Deployments");
    expect(screen.getByRole("grid", { name: "Deployments by cluster" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Filter by name, label or image")).toBeTruthy();
    // Back goes to the previous kind.
    window.history.back();
    await waitFor(() => expect(watch.kind).toBe("pods"));
    expect(within(screen.getByRole("tablist", { name: "Kinds" })).getByRole("tab", { selected: true }).textContent).toBe("Pods");
  });

  it("selected kind survives reload via hash", async () => {
    window.location.hash = "#kind=events";
    vi.stubGlobal("fetch", routes(() => [cluster]));
    renderConsole();
    expect(watch.kind).toBe("events");
    await waitFor(() => expect(within(screen.getByRole("tablist", { name: "Kinds" })).getByRole("tab", { selected: true }).textContent).toBe("Events"));
    // No cluster has reported events yet: the chip has no number rather than a made-up 0.
    expect(screen.getByRole("button", { name: "Warnings" })).toBeTruthy();
  });

  it("a hash naming no valid kind shows pods", () => {
    window.location.hash = "#kind=Not a kind";
    vi.stubGlobal("fetch", routes(() => [cluster]));
    renderConsole();
    expect(watch.kind).toBe("pods");
  });

  it("the Nodes view also watches pods for its Pods column", async () => {
    window.location.hash = "#kind=nodes";
    const ready = { type: "cluster_status", cluster_id: "c1", state: "ready", message: null } as const;
    const nodeRow = { uid: "n", cluster_id: "c1", kind: "Node", namespace: null, name: "worker", created_at: null, labels: {}, columns: { status: "Ready", status_class: "ok" } };
    watch.state = applyMessage(applyMessage(emptyWatchState(), ready),
      { type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [nodeRow] });
    watch.side = applyMessage(applyMessage(emptyWatchState(), ready),
      { type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [{ ...pod("p1", "Running", "ok"), labels: {}, columns: { status: "Running", status_class: "ok", node: "worker" } }] });
    vi.stubGlobal("fetch", routes(() => [cluster]));
    renderConsole();
    expect(watch.kind).toBe("nodes");
    expect(watch.sideKind).toBe("pods");
    await screen.findByRole("tab", { name: "Deployments" }); // the kinds (and the Nodes columns) have loaded
    const r = (await screen.findByText("worker")).closest<HTMLElement>('[role="row"]')!;
    const cells = Array.from(r.querySelectorAll('[role="gridcell"]'));
    expect(cells[6].textContent).toBe("1");
    // No Namespace chip for a kind without namespaces.
    expect(screen.queryByRole("button", { name: /^Namespace/ })).toBeNull();
  });

  it("other views don't watch pods twice", () => {
    vi.stubGlobal("fetch", routes(() => [cluster]));
    renderConsole();
    expect(watch.sideKind).toBeNull();
  });

  it("retry on an absent kind refreshes the kinds, then the cluster", async () => {
    window.location.hash = "#kind=certificates.cert-manager.io";
    watch.state = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "absent", message: "This cluster doesn't serve certificates.cert-manager.io." });
    const fetch = vi.fn((url: string) =>
      url.startsWith("/api/kinds") ? json(KINDS) : url === "/api/port-forwards" ? json([]) : url.endsWith("/retry") ? Promise.resolve(new Response(null, { status: 204 })) : json([cluster]));
    vi.stubGlobal("fetch", fetch);
    renderConsole();
    expect(await screen.findByText("This cluster doesn't serve certificates.cert-manager.io.")).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole("tablist", { name: "Kinds" })).getByRole("tab", { selected: true }).textContent).toBe("Certificates"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetch.mock.calls.map(([u]) => u)).toContain("/api/clusters/c1/retry"));
    const urls = fetch.mock.calls.map(([u]) => u);
    expect(urls.indexOf("/api/kinds?refresh=true")).toBeGreaterThan(-1);
    expect(urls.indexOf("/api/kinds?refresh=true")).toBeLessThan(urls.indexOf("/api/clusters/c1/retry"));
  });
});

describe("Console kinds, more", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  });

  it("a kind whose API group didn't answer says so on its band", async () => {
    window.location.hash = "#kind=certificates.cert-manager.io";
    watch.state = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "absent", message: "This cluster doesn't serve certificates.cert-manager.io." });
    const reason = "The cert-manager.io API didn't answer (503: the server is currently unable to handle the request); its kinds are hidden until it does.";
    const kinds = { kinds: KINDS.kinds.filter((k) => k.key !== "certificates.cert-manager.io"), clusters: { c1: { state: "ok", message: null, failed_groups: { "cert-manager.io": reason } } } };
    vi.stubGlobal("fetch", vi.fn((url: string) => (url.startsWith("/api/kinds") ? json(kinds) : url === "/api/port-forwards" ? json([]) : json([cluster]))));
    renderConsole();
    expect(await screen.findByText(`Can't list certificates on this cluster right now: ${reason}`)).toBeTruthy();
    expect(screen.queryByText("This cluster doesn't serve certificates.cert-manager.io.")).toBeNull();
    expect(screen.getByTestId("scope-token").getAttribute("title")).toBe(`Can't list certificates on this cluster right now: ${reason}`);
  });

  it("says when the kinds can't be loaded and tries again", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/port-forwards") return json([]);
      if (!url.startsWith("/api/kinds")) return json([cluster]);
      return fail ? json({ detail: "The console's database is locked." }, 500) : json(KINDS);
    }));
    renderConsole();
    expect((await screen.findByRole("alert")).textContent).toBe("Can't load the list of kinds: The console's database is locked.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("tab", { name: "Deployments" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the shortcut bar drops pod-only keys on other kinds", async () => {
    window.location.hash = "#kind=services";
    vi.stubGlobal("fetch", routes(() => [cluster]));
    renderConsole();
    const bar = await screen.findByRole("navigation", { name: /^Keyboard shortcuts/ });
    expect(bar.textContent).not.toContain("previous logs");
    expect(bar.textContent).not.toContain("shell");
    expect(bar.textContent).toContain("move");
  });
});
