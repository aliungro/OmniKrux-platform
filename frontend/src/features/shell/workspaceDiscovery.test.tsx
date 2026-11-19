import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Cluster, ForwardOut, ResourceRow } from "../../api/types";
import { addDiscovered } from "../../api/useCloud";
import { CLUSTERS_QUERY_KEY, removeCluster } from "../../api/useClusters";
import { useWatch } from "../../api/useWatch";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import { PORT_FORWARDS_KEY } from "../portforward/usePortForwards";
import { Shell } from "./Shell";
import { parseWorkspace, serializeWorkspace, STORAGE_KEY } from "./storage";
import { defaultWorkspace, HOME, kindView, sameView } from "./workspace";
import { hashFor } from "../../route";
import { KINDS, PODS } from "../../test/kinds";
import { container, describeBody } from "../../test/describe";

vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80;
  rows = 24;
  loadAddon() {}
  open() {}
  focus() {}
  write() {}
  dispose() {}
  onData() { return { dispose() {} }; }
  onResize() { return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const east = {
  id: "c1", name: "East", provider: "kind" as const, context_name: "east", server: "https://east.test",
  original_server: null, region: null, environment: "development" as const, state: "ready" as const, message: null,
  source: "file" as const, kubernetes_version: null, node_pools: [], node_count: null, cloud: null, cloud_note: null,
};
const west = { ...east, id: "c2", name: "West", context_name: "west", server: "https://west.test" };
const kinds = {
  ...KINDS,
  kinds: KINDS.kinds.map(kind => kind.key === PODS.key ? { ...kind, clusters: [east.id, west.id] } : kind),
  clusters: { ...KINDS.clusters, [west.id]: KINDS.clusters.c1 },
};
const checkedAt = "2026-11-12T08:00:00Z";
const account = {
  id: "account-1", provider: "aws", kube_provider: "eks", name: "Example account", source: "entered",
  scope: "123456789012", principal: "test principal", regions: ["eu-west-1"], profile: null, has_secret: true,
  check: { state: "ok", checked_at: checkedAt, message: null, problems: [] },
  counts: { found: 1, added: 0, new: 1 },
};
const discovered = {
  id: "discovered-1", account_id: account.id, account_name: account.name, provider: "eks", name: "Canary",
  region: "eu-west-1", kubernetes_version: "1.33", node_pools: [], node_count: null, environment: "development",
  private: false, why_not: null, state: "new", cluster_id: null, first_seen: checkedAt, last_seen: checkedAt,
  missing_since: null,
};
const anchor = { page: "home", section: "discovered" } as const;
const pods = kindView(HOME, "pods", [east.id]);
const pod = (name: string): ResourceRow => ({
  uid: name, cluster_id: east.id, kind: "Pod", name, namespace: "demo", labels: {},
  columns: { status: "Running", status_class: "ok" }, created_at: null,
});

const json = (body: unknown) => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json" },
});

function mockRoutes(readRegistry: () => unknown | Promise<unknown> = () => [east, west]) {
  const registry = vi.fn(readRegistry);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") throw new Error(`Unexpected write ${init.method} ${url}`);
    const path = new URL(url, "http://frontend.test").pathname;
    switch (path) {
      case "/api/clusters": return json(await registry());
      case "/api/kinds": return json(kinds);
      case "/api/cloud/accounts": return json([account]);
      case "/api/cloud/discovered": return json([discovered]);
      case "/api/metrics/pods": return json({ clusters: {} });
      case "/api/port-forwards": return json([]);
      default: throw new Error(`Unexpected read ${url}`);
    }
  }));
  return registry;
}

function savePods(scope: string[] | null = [east.id]) {
  const workspace = defaultWorkspace();
  workspace.kubernetes.tabs[0].view = kindView(HOME, "pods", scope);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(<QueryClientProvider client={client}><Shell /></QueryClientProvider>);
  return { ...rendered, client };
}

function sizeVirtualTable() {
  for (const key of ["clientHeight", "clientWidth", "offsetHeight", "offsetWidth"] as const) {
    vi.spyOn(HTMLElement.prototype, key, "get").mockReturnValue(600);
  }
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600, toJSON: () => ({}),
  });
}

function podsSocket(index = 0) {
  return waitFor(() => {
    const socket = FakeWebSocket.instances.filter(ws => ws.params.get("kind") === "pods")[index];
    expect(socket).toBeDefined();
    return socket!;
  }, { timeout: 2500 });
}

async function frame(send: () => void) {
  await act(async () => {
    send();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
}

function snapshot(socket: FakeWebSocket, name: string) {
  socket.emit({ type: "cluster_status", cluster_id: east.id, state: "ready", message: null });
  socket.emit({ type: "snapshot", cluster_id: east.id, part: 0, last: true, rows: [pod(name)] });
}

function band(name: RegExp) {
  return within(screen.getByRole("grid", { name: "Pods by cluster" })).queryByRole("rowheader", { name });
}

const cachedIds = (client: QueryClient) => client.getQueryData<Cluster[]>(CLUSTERS_QUERY_KEY)?.map(cluster => cluster.id);

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  mockRoutes();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens discovery in the Pods pane with one Back entry and leaves the Home peer independent", async () => {
  const user = userEvent.setup();
  const workspace = defaultWorkspace();
  const podTab = { id: "pods-tab", view: { ...pods, filters: { ...pods.filters, text: "east filter" } }, back: [], forward: [], scrollTop: 0 };
  workspace.kubernetes.tabs.push(podTab);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  renderShell();

  const tabs = within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
  fireEvent.contextMenu(await tabs.findByRole("tab", { name: "Pods · East" }));
  await user.click(screen.getByRole("menuitem", { name: "Split side by side" }));
  const peer = screen.getByRole("region", { name: "Home" });
  const peerSearch = within(peer).getByRole<HTMLInputElement>("combobox", { name: "Search Kubernetes" });
  await user.type(peerSearch, "peer search");
  expect(document.activeElement).toBe(peerSearch);
  expect(tabs.getByRole("tab", { name: "Home", selected: true })).toBeTruthy();

  const source = screen.getByRole("region", { name: "Pods · East" });
  const notice = await within(source).findByRole("button", { name: "1 new cluster found" });
  act(() => notice.focus());
  const hash = hashFor("kubernetes", podTab.id);
  expect(location.hash).toBe(hash);
  expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
  const push = vi.spyOn(history, "pushState");
  await user.click(notice);

  const heading = await within(source).findByRole("heading", { name: /discover/i });
  expect(within(source).getByRole("heading", { name: "Where do you want to look?" })).toBeTruthy();
  await within(source).findByText(discovered.name);
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(location.hash).toBe(hash);
  expect(push).toHaveBeenCalledTimes(1);
  expect(tabs.getAllByRole("tab")).toHaveLength(2);
  expect(tabs.getByRole("tab", { name: "Home", selected: true })).toBeTruthy();
  expect(within(peer).getByRole("combobox", { name: "Search Kubernetes" })).toBe(peerSearch);
  expect(peerSearch.value).toBe("peer search");

  await user.click(screen.getByRole("button", { name: "Back" }));
  await within(source).findByRole("grid", { name: "Pods by cluster" });
  expect(screen.getByRole("region", { name: "Pods · East" })).toBe(source);
  expect(within(source).getByRole<HTMLInputElement>("textbox", { name: "Filter by name, label or image" }).value).toBe("east filter");
  expect(tabs.getByRole("tab", { name: "Pods · East", selected: true })).toBeTruthy();
  expect(location.hash).toBe(hash);
  expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
  expect(peerSearch.value).toBe("peer search");
  await user.click(peerSearch);
  expect(document.activeElement).toBe(peerSearch);
  expect(tabs.getByRole("tab", { name: "Home", selected: true })).toBeTruthy();

  await user.click(tabs.getByRole("tab", { name: "Pods · East" }));
  await user.click(screen.getByRole("button", { name: "Forward" }));
  const returned = await within(source).findByRole("heading", { name: /discover/i });
  await waitFor(() => expect(document.activeElement).toBe(returned));
  await user.click(peerSearch);
  const discoverySearch = within(source).getByRole("combobox", { name: "Search Kubernetes" });
  await user.click(discoverySearch);
  expect(document.activeElement).toBe(discoverySearch);
});

it("keeps the discovery section distinct and round trips it in version 1 views and history", () => {
  const workspace = defaultWorkspace();
  const tab = workspace.kubernetes.tabs[0];
  tab.view = anchor;
  tab.back = [HOME, pods];
  tab.forward = [anchor];

  expect.soft(sameView(HOME, anchor)).toBe(false);
  expect(sameView(anchor, { ...anchor })).toBe(true);
  const parsed = parseWorkspace(serializeWorkspace(workspace));
  expect(parsed.problem).toBeNull();
  expect(parsed.workspace.version).toBe(1);
  expect(parsed.workspace.kubernetes.tabs[0]).toEqual(tab);
});

it("focuses a saved discovery heading on reload and keeps the tab's Back scope", async () => {
  const workspace = defaultWorkspace();
  const tab = workspace.kubernetes.tabs[0];
  tab.view = anchor;
  tab.back = [pods];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  const hash = hashFor("kubernetes", tab.id);
  history.replaceState(null, "", hash);

  renderShell();
  const heading = await within(screen.getByRole("main")).findByRole("heading", { name: /discover/i });
  await screen.findByText(discovered.name);
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(location.hash).toBe(hash);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("tab", { name: "Pods · East", selected: true })).toBeTruthy();
  expect(location.hash).toBe(hash);
});

it("keeps focus on the discovery heading after activating a saved Home discovery tab", async () => {
  const workspace = defaultWorkspace();
  workspace.kubernetes.tabs.push({ id: "discovered", view: anchor, back: [pods], forward: [], scrollTop: 0 });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  renderShell();
  const tabs = within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
  const saved = tabs.getByRole("tab", { name: "Home", selected: false });
  await frame(() => fireEvent.click(saved));

  const heading = await within(screen.getByRole("main")).findByRole("heading", { name: "Discovered clusters" });
  expect(tabs.getByRole("tab", { name: "Home", selected: true })).toBe(saved);
  expect(document.activeElement).toBe(heading);
  expect(location.hash).toBe(hashFor("kubernetes", "discovered"));
});

it("evicts a removed cluster before the pending registry response and falls back from its scope", async () => {
  const refreshed = deferred<Cluster[]>();
  let removing = false;
  const registry = mockRoutes(() => removing ? refreshed.promise : [east, west]);
  savePods();
  sizeVirtualTable();
  const { client } = renderShell();
  const socket = await podsSocket();
  await frame(() => snapshot(socket, "east-pod"));
  await screen.findByText("east-pod");
  expect(band(/East/)).toBeTruthy();

  removing = true;
  await frame(() => socket.emit({ type: "cluster_removed", cluster_id: east.id }));
  await waitFor(() => expect(registry.mock.calls.length).toBeGreaterThan(1));
  expect(client.getQueryState(CLUSTERS_QUERY_KEY)?.fetchStatus).toBe("fetching");
  expect.soft(cachedIds(client)).toEqual([west.id]);
  expect.soft(band(/East/)).toBeNull();
  expect.soft(band(/West/)).toBeTruthy();
  expect.soft(screen.queryByText(/gone from OmniKrux, so it shows every cluster/i)).toBeTruthy();

  await act(async () => refreshed.resolve([west]));
});

it("ignores old watch frames across reconnect and a stale registry reply until absence is confirmed", async () => {
  const stale = deferred<Cluster[]>();
  let registryReply: Cluster[] | Promise<Cluster[]> = [east, west];
  const registry = mockRoutes(() => registryReply);
  savePods(null);
  sizeVirtualTable();
  const { client } = renderShell();
  const watch = renderHook(() => useWatch("pods"), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  const socket = await podsSocket();
  expect(FakeWebSocket.instances.filter(ws => ws.params.get("kind") === "pods")).toEqual([socket]);
  await frame(() => snapshot(socket, "east-pod"));
  await screen.findByText("east-pod");

  registryReply = stale.promise;
  await frame(() => socket.emit({ type: "cluster_removed", cluster_id: east.id }));
  await waitFor(() => expect(registry.mock.calls.length).toBeGreaterThan(1));
  await frame(() => snapshot(socket, "late-pod"));
  expect.soft(watch.result.current.rows[east.id]).toBeUndefined();
  expect.soft(watch.result.current.clusters[east.id]).toBeUndefined();

  act(() => socket.drop());
  const reconnected = await podsSocket(1);
  await frame(() => snapshot(reconnected, "replayed-pod"));
  expect.soft(watch.result.current.rows[east.id]).toBeUndefined();
  expect.soft(watch.result.current.clusters[east.id]).toBeUndefined();

  const updatedWest = { ...west, name: "West updated" };
  await act(async () => stale.resolve([east, updatedWest]));
  await waitFor(() => {
    expect(client.getQueryState(CLUSTERS_QUERY_KEY)?.fetchStatus).toBe("idle");
    expect(band(/West updated/)).toBeTruthy();
  });
  expect.soft(cachedIds(client)).toEqual([west.id]);
  expect.soft(band(/East/)).toBeNull();
  expect.soft(screen.queryByText("replayed-pod")).toBeNull();

  await frame(() => {
    const row = pod("late-after-registry");
    reconnected.emit({ type: "upsert", cluster_id: east.id, row });
    reconnected.emit({ type: "snapshot", cluster_id: east.id, part: 0, last: false, rows: [row] });
  });
  expect.soft(watch.result.current.rows[east.id]).toBeUndefined();
  expect.soft(watch.result.current.pending[east.id]).toBeUndefined();

  registryReply = [updatedWest];
  const callsBeforeConfirmation = registry.mock.calls.length;
  await act(async () => client.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY }));
  expect(registry.mock.calls.length).toBeGreaterThan(callsBeforeConfirmation);
  await waitFor(() => expect(cachedIds(client)).toEqual([west.id]));

  registryReply = [east, updatedWest];
  await frame(() => snapshot(reconnected, "returned-pod"));
  await screen.findByText("returned-pod");
  expect(cachedIds(client)).toEqual([east.id, west.id]);
  expect(watch.result.current.rows[east.id]?.has("returned-pod")).toBe(true);
});

it("keeps an older successful add from undoing a later removal and accepts a new add", async () => {
  const olderAdd = deferred<Response>();
  const registry = vi.fn(() => [east, west]);
  mockRoutes(registry);
  const reads = vi.mocked(fetch).getMockImplementation()!;
  let addCalls = 0;
  vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) => {
    if (path === "/api/cloud/discovered/add") {
      addCalls++;
      return addCalls === 1 ? olderAdd.promise : Promise.resolve(json({ added: [east], failed: [] }));
    }
    if (path === "/api/clusters/c1" && init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    return reads(path, init);
  }));
  sizeVirtualTable();
  savePods(null);
  const { client } = renderShell();
  await screen.findByRole("rowheader", { name: /East/ });
  let add!: ReturnType<typeof addDiscovered>;
  act(() => { add = addDiscovered(client, [discovered.id]); });
  await act(async () => removeCluster(client, east.id));
  await waitFor(() => expect(client.getQueryState(CLUSTERS_QUERY_KEY)?.fetchStatus).toBe("idle"));
  await act(async () => {
    olderAdd.resolve(json({ added: [east], failed: [] }));
    await add;
  });
  await waitFor(() => expect(client.getQueryState(CLUSTERS_QUERY_KEY)?.fetchStatus).toBe("idle"));
  expect.soft(cachedIds(client)).toEqual([west.id]);
  expect.soft(band(/East/)).toBeNull();
  const socket = await podsSocket();
  await frame(() => snapshot(socket, "late-add-pod"));
  expect.soft(screen.queryByText("late-add-pod")).toBeNull();

  await act(async () => addDiscovered(client, [discovered.id]));
  await screen.findByRole("rowheader", { name: /East/ });
  const active = FakeWebSocket.instances.filter(ws => !ws.closedByClient && ws.params.get("kind") === "pods").at(-1)!;
  await frame(() => snapshot(active, "new-add-pod"));
  expect(await screen.findByText("new-add-pod")).toBeTruthy();
});

const forward = (cluster: Cluster): ForwardOut => ({
  id: `forward-${cluster.id}`, cluster_id: cluster.id, cluster_name: cluster.name, provider: cluster.provider,
  namespace: "demo", kind: "pod", name: `${cluster.context_name}-pod`, remote_port: 8080, local_port: 30001,
  address: "127.0.0.1:30001", pod: null, state: "listening", message: null, connections: 0, started_at: checkedAt,
});

it.each(["watch", "Settings"] as const)("closes matching dock sockets and forwards on removal from %s", async source => {
  const registryReply = deferred<Cluster[]>();
  const forwardsReply = deferred<ForwardOut[]>();
  let removed = false;
  mockRoutes(() => removed ? registryReply.promise : [east, west]);
  const reads = vi.mocked(fetch).getMockImplementation()!;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/port-forwards") return json(removed ? await forwardsReply.promise : [forward(east), forward(west)]);
    if (path.endsWith("/describe")) return json(describeBody({ containers: [container({ name: "app" })] }));
    if (path === "/api/settings") return json({ encryption: { source: "environment", path: null }, discovery_interval_s: 600 });
    if (path === "/api/cloud/logins") return json([]);
    if (path === "/api/clusters/c1" && init?.method === "DELETE") {
      removed = true;
      return new Response(null, { status: 204 });
    }
    return reads(path, init);
  }));
  sizeVirtualTable();
  savePods(null);
  const { client } = renderShell();
  const socket = await podsSocket();
  await frame(() => {
    snapshot(socket, "east-pod");
    socket.emit({ type: "cluster_status", cluster_id: west.id, state: "ready", message: null });
    socket.emit({ type: "snapshot", cluster_id: west.id, part: 0, last: true, rows: [{ ...pod("west-pod"), cluster_id: west.id }] });
  });

  const findSocket = (path: string, cluster: Cluster) => waitFor(() => {
    const stream = FakeWebSocket.instances.find(ws => new URL(ws.url).pathname === path && ws.params.get("cluster") === cluster.id);
    expect(stream).toBeDefined();
    return stream!;
  });
  // Pinned logs (Shift+L): a tab per pod that never follows the selection.
  async function openSession(podName: string, key: "L" | "s") {
    fireEvent.click(await screen.findByRole("gridcell", { name: podName }));
    fireEvent.keyDown(document.body, { key, shiftKey: key === "L" });
  }
  await openSession("east-pod", "L");
  const eastLog = await findSocket("/api/logs", east);
  await openSession("west-pod", "L");
  const westLog = await findSocket("/api/logs", west);
  await openSession("east-pod", "s");
  const eastShell = await findSocket("/api/exec", east);
  fireEvent.keyDown(window, { key: "\\", code: "Backslash", ctrlKey: true });
  const dock = within(screen.getByRole("region", { name: "Logs and shells" }));
  expect(dock.getAllByRole("tabpanel")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "2 port-forwards" })).toBeTruthy();

  if (source === "Settings") {
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove East" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove East from OmniKrux?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  } else {
    removed = true;
    await frame(() => socket.emit({ type: "cluster_removed", cluster_id: east.id }));
  }
  await waitFor(() => expect(removed).toBe(true));
  await frame(() => {});
  expect.soft(eastLog.closedByClient).toBe(true);
  expect.soft(eastShell.closedByClient).toBe(true);
  expect(westLog.closedByClient).toBe(false);
  expect.soft(dock.getAllByRole("tab")).toHaveLength(1);
  expect.soft(screen.queryByRole("button", { name: "1 port-forward" })).toBeTruthy();
  expect.soft(client.getQueryData<ForwardOut[]>(PORT_FORWARDS_KEY)?.map(f => f.cluster_id)).toEqual([west.id]);
  await act(async () => {
    registryReply.resolve([west]);
    forwardsReply.resolve([forward(west)]);
  });
});

it("does not open logs whose describe finishes after a registry read observes removal", async () => {
  const lateRegistry = deferred<Cluster[]>();
  const lateDescribe = deferred<Response>();
  let readRegistry = () => [east, west] as Cluster[] | Promise<Cluster[]>;
  const registry = mockRoutes(() => readRegistry());
  const reads = vi.mocked(fetch).getMockImplementation()!;
  const describe = vi.fn(() => lateDescribe.promise);
  vi.stubGlobal("fetch", vi.fn((path: string, init?: RequestInit) =>
    path.endsWith("/describe") ? describe() : reads(path, init)));
  sizeVirtualTable();
  savePods(null);
  const { client } = renderShell();
  const socket = await podsSocket();
  await frame(() => snapshot(socket, "east-pod"));
  const cell = await screen.findByRole("gridcell", { name: "east-pod" });

  readRegistry = () => lateRegistry.promise;
  let refresh!: Promise<void>;
  act(() => { refresh = client.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY }); });
  await waitFor(() => expect(registry).toHaveBeenCalledTimes(2));
  fireEvent.keyDown(cell.closest('[role="row"]')!, { key: "l" });
  await waitFor(() => expect(describe).toHaveBeenCalledTimes(1));

  await act(async () => {
    lateRegistry.resolve([west]);
    await refresh;
  });
  await waitFor(() => expect(band(/East/)).toBeNull());
  await act(async () => lateDescribe.resolve(json(describeBody())));
  await frame(() => {});
  expect(FakeWebSocket.instances.filter(ws => new URL(ws.url).pathname === "/api/logs")).toHaveLength(0);
});
