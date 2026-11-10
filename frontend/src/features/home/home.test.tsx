import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Cluster, ResourceRow } from "../../api/types";
import { KINDS } from "../../test/kinds";
import { describeBody } from "../../test/describe";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import { Shell } from "../shell/Shell";
import { defaultWorkspace, HOME, kindView, type KubeView } from "../shell/workspace";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const cluster: Cluster = { id: "c1", name: "prod-east", context_name: "prod", server: "https://east:6443", original_server: null, provider: "aks", region: "east", environment: "production", state: "ready", message: null };
const pod: ResourceRow = { uid: "p1", cluster_id: "c1", name: "web-pod", kind: "Pod", namespace: "demo", created_at: null, columns: { status: "Running", status_class: "ok", restarts: 0 }, labels: {} };
let clusters: Cluster[];
const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  clusters = [cluster];
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.startsWith("/api/kinds")) return json(KINDS);
    if (url === "/api/clusters") return json(clusters);
    if (url.includes("/describe")) return json(describeBody());
    if (url.startsWith("/api/metrics")) return json({ kind: "pods", clusters: {} });
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Shell /></QueryClientProvider>);
}
const search = () => screen.getByRole("combobox", { name: "Search Kubernetes" });
async function ready(rows = [pod]) {
  const ws = FakeWebSocket.last;
  act(() => {
    ws.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows });
    ws.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
  });
  await screen.findByText(rows.some(r => r.columns.status_class === "bad") ? `1 of ${rows.length} pods failing` : `${rows.length} pods, all healthy`);
}
function seedClosed(view: KubeView, back: KubeView[] = [HOME]) {
  const ws = defaultWorkspace();
  ws.kubernetes.closed = [{ tab: { id: "closed", view, back, forward: [], scrollTop: 18 }, closedAt: Date.now() - 120_000 }];
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws));
}

it("home leads with the search", () => {
  show();
  const heading = screen.getByRole("heading", { name: "Where do you want to look?" });
  expect(screen.getByText("Search every cluster at once, or open one to start a tab.")).toBeTruthy();
  expect(search().getAttribute("placeholder")).toBe("Search pods, deployments, nodes or a cluster");
  expect(heading.compareDocumentPosition(search()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(search().compareDocumentPosition(screen.getByRole("heading", { name: "Clusters" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Recently closed" })).toBeNull();
});
it("slash focuses the home search", () => {
  show(); fireEvent.keyDown(document.body, { key: "/" });
  expect(document.activeElement).toBe(search());
});
it("typing in the home search triggers no shortcut", () => {
  show(); search().focus();
  for (const key of ["j", "k", ":", "?", "/"]) fireEvent.keyDown(search(), { key });
  fireEvent.keyDown(search(), { key: "t", code: "KeyT", altKey: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(within(screen.getByRole("tablist", { name: "Kubernetes tabs" })).getAllByRole("tab")).toHaveLength(1);
  expect(document.activeElement).toBe(search());
});
it("search finds clusters, kinds and pods", async () => {
  show(); await ready();
  for (const [query, label] of [["prod", "prod-east"], ["deploy", "Deployments"], ["web", "web-pod"]]) {
    fireEvent.change(search(), { target: { value: query } });
    expect(within(screen.getByRole("group", { name: query === "prod" ? "Clusters" : query === "deploy" ? "Kinds" : "Pods" })).getByRole("option", { name: new RegExp(label) })).toBeTruthy();
  }
  expect(screen.getByRole("option", { name: /web-pod/ }).textContent).toContain("demo · prod-east");
});
it("find in a kind opens it filtered", async () => {
  show(); await screen.findByRole("button", { name: /prod-east/ });
  fireEvent.change(search(), { target: { value: "needle" } });
  fireEvent.click(screen.getByRole("option", { name: 'Find "needle" in Deployments' }));
  expect((await screen.findByPlaceholderText("Filter by name, label or image") as HTMLInputElement).value).toBe("needle");
  expect(screen.getByRole("tab", { name: "Deployments · all clusters" })).toBeTruthy();
});
it("opening a pod result selects it with details open", async () => {
  show(); await ready();
  fireEvent.change(search(), { target: { value: "web-pod" } });
  fireEvent.click(within(screen.getByRole("group", { name: "Pods" })).getByRole("option", { name: /web-pod/ }));
  act(() => {
    FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [pod] });
    FakeWebSocket.last.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
  });
  expect(await screen.findByRole("region", { name: "Details for web-pod" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Pods · prod-east" })).toBeTruthy();
});
it("cluster cards show live health from the pods watch", async () => {
  show(); await ready([pod, { ...pod, uid: "bad", columns: { status: "Error", status_class: "bad" } }]);
  const card = screen.getByRole("button", { name: /prod-east/ });
  expect(within(card).getByText("Production")).toBeTruthy();
  expect(within(card).getByText("east · east:6443")).toBeTruthy();
  expect(within(card).getByText("◆").getAttribute("aria-hidden")).toBe("true");
  act(() => FakeWebSocket.last.emit({ type: "delete", cluster_id: "c1", uid: "bad" }));
  expect(await screen.findByText("1 pods, all healthy")).toBeTruthy();
});
it("a card never shows counts before its cluster is ready", async () => {
  show(); const card = await screen.findByRole("button", { name: /prod-east/ });
  act(() => FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [pod] }));
  await waitFor(() => expect(within(card).getByText("Connecting…")).toBeTruthy());
  expect(card.textContent).not.toContain("1 pods");
  act(() => FakeWebSocket.last.emit({ type: "cluster_status", cluster_id: "c1", state: "syncing", message: null }));
  expect(within(card).getByText("Connecting…")).toBeTruthy();
});
it("a cluster that can't be reached says so", async () => {
  show(); await screen.findByRole("button", { name: /prod-east/ });
  act(() => FakeWebSocket.last.emit({ type: "cluster_status", cluster_id: "c1", state: "error", message: "certificate expired" }));
  expect(await screen.findByText("Can't reach it: certificate expired")).toBeTruthy();
});
it("opening a card scopes the tab to that cluster and back returns home", async () => {
  show(); fireEvent.click(await screen.findByRole("button", { name: /prod-east/ }));
  expect(screen.getByRole("tab", { name: "Pods · prod-east" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Where do you want to look?" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(search()).toBeTruthy();
});
it("recently closed tabs reopen with their state", async () => {
  const view = kindView(HOME, "deployments.apps", ["c1"]);
  if (view.page === "kind") view.filters.text = "needle";
  seedClosed(view); show();
  fireEvent.click(await screen.findByRole("button", { name: /Deployments · prod-east.*2 min ago/ }));
  expect((await screen.findByPlaceholderText("Filter by name, label or image") as HTMLInputElement).value).toBe("needle");
  expect(screen.getByRole("tab", { name: "Deployments · prod-east" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(search()).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Recently closed" })).toBeNull();
});
it("reopening a closed tab whose cluster left says so", async () => {
  seedClosed(kindView(HOME, "pods", ["gone"])); show();
  fireEvent.click(await screen.findByRole("button", { name: /Pods · gone.*2 min ago/ }));
  expect(await screen.findByText("The cluster this tab looked at is gone from Omnikrux, so it shows every cluster.")).toBeTruthy();
});
it("a storage problem is said once on home", async () => {
  localStorage.setItem("omnikrux.workspace", "bad json"); show();
  const notice = screen.getByRole("alert");
  expect(notice.textContent).toContain("Your saved tabs couldn't be read");
  expect(notice.compareDocumentPosition(screen.getByRole("heading", { level: 1 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(within(notice).getByRole("button", { name: "Dismiss" }));
  fireEvent.click(screen.getByRole("button", { name: "New tab" }));
  fireEvent.click(within(screen.getByRole("tablist", { name: "Kubernetes tabs" })).getAllByRole("tab")[0]);
  expect(screen.queryByText(/Your saved tabs couldn't be read/)).toBeNull();
});
it("home opens one pods watch only", async () => {
  show(); await screen.findByRole("button", { name: /prod-east/ });
  expect(FakeWebSocket.instances.map(w => w.params.get("kind"))).toEqual(["pods"]);
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("/api/metrics"))).toBe(false);
});
it("keyboard results move, open on Enter and clear on Escape", async () => {
  show(); await screen.findByRole("button", { name: /prod-east/ });
  fireEvent.change(search(), { target: { value: "deploy" } });
  const options = screen.getAllByRole("option");
  expect(options[0].getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(search(), { key: "ArrowDown" });
  expect(options[1].getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(search(), { key: "ArrowUp" });
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(await screen.findByRole("tab", { name: "Deployments · all clusters" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.change(search(), { target: { value: "missing" } });
  fireEvent.keyDown(search(), { key: "Escape" });
  expect((search() as HTMLInputElement).value).toBe("");
  expect(screen.queryByRole("listbox")).toBeNull();
});
it("the palette returns focus to the home search", () => {
  show(); fireEvent.click(screen.getByRole("button", { name: "Commands and kinds" }));
  const combo = within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox");
  fireEvent.keyDown(combo, { key: "Escape" });
  expect(document.activeElement).toBe(search());
});
it("workspace and pinned storage notices dismiss independently across Home and Settings", () => {
  localStorage.setItem("omnikrux.workspace", "bad json");
  localStorage.setItem("omnikrux.pinnedKinds", "bad json"); show();
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss pinned kinds notice" }));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.queryByText(/Your saved pinned kinds couldn't be read/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  expect(screen.getByRole("alert").textContent).toContain("Your saved tabs couldn't be read");
});
it("Find lets you edit pinned kinds in Settings", async () => {
  show(); await screen.findByRole("button", { name: /prod-east/ });
  fireEvent.change(search(), { target: { value: "needle" } });
  fireEvent.click(screen.getByRole("button", { name: "Edit pinned kinds…" }));
  expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeTruthy();
});
it("home explains missing clusters and retries a failed cluster list", async () => {
  let failed = true;
  vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/clusters" ? failed ? json({ detail: "database is locked" }, 500) : json([]) : json(url.startsWith("/api/kinds") ? KINDS : [])));
  show();
  expect(screen.getByText("Loading clusters…")).toBeTruthy();
  expect(await screen.findByText("Can't load clusters: database is locked")).toBeTruthy();
  failed = false; fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("No clusters yet. Mount your kubeconfig at /kube/config and restart the console.")).toBeTruthy();
});

it.each(["Pending", "ContainerCreating", "Not ready", "Unknown"])("a %s pod needs attention rather than being called healthy", async status => {
  show();
  const warning = { ...pod, uid: "warning", columns: { status, status_class: "warn" } };
  act(() => {
    FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [pod, warning] });
    FakeWebSocket.last.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
  });
  const health = await screen.findByText("2 pods, 1 need attention");
  expect(health.className).toContain("warning");
  expect(screen.queryByText(/all healthy/)).toBeNull();
});
it("failing pods take precedence over warnings on a card", async () => {
  show();
  await ready([{ ...pod, columns: { status: "Pending", status_class: "warn" } }, { ...pod, uid: "bad", columns: { status: "Error", status_class: "bad" } }]);
  expect(screen.getByText("1 of 2 pods failing").className).toContain("failed");
  expect(screen.queryByText(/need attention/)).toBeNull();
});
it("Find limits its filter text to the supported length and survives reload", async () => {
  const first = show(); await screen.findByRole("button", { name: /prod-east/ });
  fireEvent.change(search(), { target: { value: "x".repeat(501) } });
  expect((search() as HTMLInputElement).value).toHaveLength(500);
  fireEvent.click(screen.getByRole("option", { name: `Find "${"x".repeat(500)}" in Deployments` }));
  expect((await screen.findByPlaceholderText("Filter by name, label or image") as HTMLInputElement).value).toHaveLength(500);
  act(() => window.dispatchEvent(new Event("pagehide")));
  first.unmount(); show();
  expect((await screen.findByPlaceholderText("Filter by name, label or image") as HTMLInputElement).value).toHaveLength(500);
  expect(screen.queryByText(/Your saved tabs couldn't be read/)).toBeNull();
});
it("shows no matches when no pinned kind is served", async () => {
  localStorage.setItem("omnikrux.pinnedKinds", JSON.stringify({ version: 1, kinds: ["unserved.example.io"] }));
  show(); await screen.findByRole("button", { name: /prod-east/ });
  fireEvent.change(search(), { target: { value: "zzzz" } });
  expect(screen.getByText('Nothing matches "zzzz".')).toBeTruthy();
  expect(screen.queryByRole("option")).toBeNull();
});
it("recently closed entries show relative times", () => {
  const ws = defaultWorkspace();
  ws.kubernetes.closed = [0, 2, 120, 1440, 4320].map((minutes, i) => ({ tab: { id: `old-${i}`, view: kindView(HOME, "pods"), back: [], forward: [], scrollTop: 0 }, closedAt: Date.now() - minutes * 60_000 }));
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws)); show();
  for (const label of ["just now", "2 min ago", "2 h ago", "yesterday", "3 days ago"]) expect(screen.getByText(label)).toBeTruthy();
});
it("a finite saved close time outside the date range does not break Home", () => {
  const ws = defaultWorkspace();
  ws.kubernetes.closed = [{ tab: { id: "future", view: kindView(HOME, "pods"), back: [], forward: [], scrollTop: 0 }, closedAt: Number.MAX_VALUE }];
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws)); show();
  expect(search()).toBeTruthy();
  expect(screen.getByText("just now")).toBeTruthy();
});
it("cards share rewritten host locations and omit unknown environments", async () => {
  clusters = [{ ...cluster, region: null, original_server: "https://127.0.0.1:6443", server: "https://host.docker.internal:6443", environment: "unknown" }];
  show(); const card = await screen.findByRole("button", { name: /prod-east/ });
  expect(within(card).getByText("via host.docker.internal:6443")).toBeTruthy();
  expect(within(card).queryByText("Production")).toBeNull();
  expect(within(card).queryByText("Development")).toBeNull();
});

it("a failed kind catalog keeps healthy partial results honest and can be retried", async () => {
  let failed = true;
  const originalFetch = vi.mocked(fetch);
  vi.stubGlobal("fetch", vi.fn((url: string) => url.startsWith("/api/kinds") ? failed ? json({ detail: "discovery timed out" }, 503) : json(KINDS) : originalFetch(url)));
  show(); await ready();
  fireEvent.change(search(), { target: { value: "deploy" } });
  expect(await screen.findByText("Can't load the list of kinds: discovery timed out. Search results are incomplete.")).toBeTruthy();
  expect(screen.queryByText('Nothing matches "deploy".')).toBeNull();
  fireEvent.change(search(), { target: { value: "prod" } });
  expect(within(screen.getByRole("group", { name: "Clusters" })).getByRole("option", { name: /prod-east/ })).toBeTruthy();
  failed = false; fireEvent.click(screen.getByRole("button", { name: "Try kinds again" }));
  fireEvent.change(search(), { target: { value: "deploy" } });
  expect(await screen.findByRole("group", { name: "Kinds" })).toBeTruthy();
  expect(screen.queryByText(/Search results are incomplete/)).toBeNull();
});

it("a loading kind catalog never claims a completed no-match search", async () => {
  let complete!: (value: Response) => void;
  const originalFetch = vi.mocked(fetch);
  vi.stubGlobal("fetch", vi.fn((url: string) => url.startsWith("/api/kinds") ? new Promise<Response>(resolve => { complete = resolve; }) : originalFetch(url)));
  show(); await ready();
  fireEvent.change(search(), { target: { value: "deploy" } });
  expect(screen.getByText("Loading the list of kinds… Search results are incomplete.")).toBeTruthy();
  expect(screen.queryByText('Nothing matches "deploy".')).toBeNull();
  await act(async () => { complete(await json(KINDS)); });
  expect(await screen.findByRole("group", { name: "Kinds" })).toBeTruthy();
  expect(screen.queryByText(/Search results are incomplete/)).toBeNull();
});

it("keyboard selection scrolls overflowing search results into view and wraps visibly", async () => {
  const calls: { element: Element; options: ScrollIntoViewOptions }[] = [];
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: function(this: Element, options: ScrollIntoViewOptions) { calls.push({ element: this, options }); } });
  try {
    clusters = Array.from({ length: 8 }, (_, i) => ({ ...cluster, id: `c${i}`, name: `web-cluster-${i}` }));
    const kinds = Array.from({ length: 8 }, (_, i) => ({ ...KINDS.kinds[1], key: `web-${i}.apps`, plural_label: `web kind ${i}` }));
    localStorage.setItem("omnikrux.pinnedKinds", JSON.stringify({ version: 1, kinds: kinds.map(k => k.key) }));
    const originalFetch = vi.mocked(fetch);
    vi.stubGlobal("fetch", vi.fn((url: string) => url.startsWith("/api/kinds") ? json({ ...KINDS, kinds }) : originalFetch(url)));
    show(); await ready(Array.from({ length: 8 }, (_, i) => ({ ...pod, uid: `p${i}`, name: `web-pod-${i}` })));
    fireEvent.change(search(), { target: { value: "web" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(32);
    for (let i = 1; i < options.length; i++) {
      fireEvent.keyDown(search(), { key: "ArrowDown" });
      expect(calls.at(-1)).toEqual({ element: options[i], options: { block: "nearest" } });
    }
    screen.getByRole("listbox").scrollTop = 700;
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(calls.at(-1)).toEqual({ element: options[0], options: { block: "nearest" } });
  } finally { delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView; }
});

it("a workspace write failure is visible outside Settings and clears after a successful save", async () => {
  show(); await screen.findByRole("button", { name: /prod-east/ });
  const originalSet = Storage.prototype.setItem;
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, key, value) {
    if (key === "omnikrux.workspace") throw new DOMException("full", "QuotaExceededError");
    originalSet.call(this, key, value);
  });
  fireEvent.click(screen.getByRole("button", { name: "New tab" }));
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(screen.getByRole("alert").textContent).toBe("Tabs can't be saved in this browser (storage is full). They last until you close this page.");
  fireEvent.click(await screen.findByRole("button", { name: /prod-east/ }));
  expect(screen.getByRole("alert").textContent).toContain("Tabs can't be saved");
  set.mockRestore();
  fireEvent.click(screen.getByRole("button", { name: "New tab" }));
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("a pinned-only write failure stays accurately visible after leaving Settings", async () => {
  show(); await screen.findByRole("button", { name: /prod-east/ });
  const originalSet = Storage.prototype.setItem;
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, key, value) {
    if (key === "omnikrux.pinnedKinds") throw new DOMException("full", "QuotaExceededError");
    originalSet.call(this, key, value);
  });
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Pods" }));
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  expect(screen.getByRole("alert").textContent).toBe("Pinned kinds can't be saved in this browser (storage is full). Your changes last until you close this page.");
  set.mockRestore(); fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  expect(screen.queryByRole("alert")).toBeNull();
});
