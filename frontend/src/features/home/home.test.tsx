import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Cluster, ResourceRow } from "../../api/types";
import { KINDS } from "../../test/kinds";
import { removePinned } from "../../test/pinnedKinds";
import { describeBody } from "../../test/describe";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import { Shell } from "../shell/Shell";
import { defaultWorkspace, HOME, kindView, type KubeView } from "../shell/workspace";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const cluster: Cluster = { id: "c1", name: "prod-east", context_name: "prod", server: "https://east:6443", ...FILE_CLUSTER_METADATA, original_server: null, provider: "aks", region: "east", environment: "production", state: "ready", message: null };
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
    if (url === "/api/settings") return json({ encryption: { source: "environment", path: null }, discovery_interval_s: 600 });
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
const failingPod: ResourceRow = { ...pod, columns: { status: "CrashLoopBackOff", status_class: "bad" } };
const nextFrame = () => act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
const pod2 = (): ResourceRow => ({ ...pod, uid: "p2", name: "api-pod" });
const podLink = () => screen.getByRole("button", { name: /web-pod.*demo.*prod-east.*CrashLoopBackOff/ });
const coldTable = vi.hoisted(() => ({ wait: undefined as Promise<void> | undefined }));
vi.mock("../territories/TerritoryTable", async importOriginal => {
  await coldTable.wait;
  return importOriginal();
});
// Records the table's scroll requests; the real virtualizer still performs them.
const scrollRequests = vi.hoisted(() => [] as Array<{ index: number; align: string | undefined }>);
vi.mock("@tanstack/react-virtual", async importOriginal => {
  const actual = await importOriginal<typeof import("@tanstack/react-virtual")>();
  const wrapped = new WeakSet<object>();
  return { ...actual, useVirtualizer: ((options: Parameters<typeof actual.useVirtualizer>[0]) => {
    const instance = actual.useVirtualizer(options);
    if (!wrapped.has(instance)) {
      wrapped.add(instance);
      const scrollToIndex = instance.scrollToIndex;
      instance.scrollToIndex = (index, opts) => { scrollRequests.push({ index, align: opts?.align }); scrollToIndex(index, opts); };
    }
    return instance;
  }) as typeof actual.useVirtualizer };
});
// jsdom has no scrolling layout. Deliver the browser's scroll notification on
// demand so the real virtualizer mounts the distant row in a separate commit.
function delayQueueScroll() {
  const originalFetch = vi.mocked(fetch);
  vi.stubGlobal("fetch", vi.fn((url: string) => url.startsWith("/api/kinds")
    ? json({ ...KINDS, kinds: KINDS.kinds.map(k => k.key === "pods" ? { ...k, sort: "recent" } : k) })
    : originalFetch(url)));
  const peers = Array.from({ length: 180 }, (_, i) => ({ ...pod, created_at: "2026-11-18T12:00:00Z", uid: `other-${i}`, name: `api-${i}` }));
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(16000);
  let scroll: (() => void) | undefined;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    if (options.top && options.top > 600) {
      const offset = options.top;
      scroll = () => { this.scrollTop = offset; fireEvent.scroll(this); };
    }
  } });
  return {
    rows: [...peers, failingPod],
    async mountRow(beforeMount?: () => void) {
      await waitFor(() => expect(scroll).toBeTypeOf("function"));
      expect(document.querySelector('[data-row-key="c1/p1"]')).toBeNull();
      beforeMount?.();
      act(() => scroll!());
      return waitFor(() => {
        const exact = document.querySelector<HTMLElement>('[data-row-key="c1/p1"]');
        expect(exact).toBeTruthy();
        return exact!;
      });
    },
    restore() {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollTo", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    },
  };
}
it("focuses the verified offscreen queue Pod after the cold table and its row mount separately", async () => {
  let release!: () => void;
  coldTable.wait = new Promise<void>(resolve => { release = resolve; });
  const delayed = delayQueueScroll();
  try {
    show(); await ready(delayed.rows);
    fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" }));
    podLink().focus(); await userEvent.keyboard("{Enter}");
    await screen.findByText(/Loading resources/);
    await waitFor(() => expect(screen.queryByText(/Opening Pod/)).toBeNull());
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("expected_uid=p1"))).toBe(true);
    await act(async () => { release(); await vi.dynamicImportSettled(); });
    const exact = await delayed.mountRow();
    await waitFor(() => expect(document.activeElement).toBe(exact));
  } finally { release(); delayed.restore(); }
});
it("mounting the offscreen queue Pod preserves focus moved to the filter", async () => {
  const delayed = delayQueueScroll();
  try {
    show(); await ready(delayed.rows);
    fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" }));
    podLink().focus(); await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByText(/Opening Pod/)).toBeNull());
    const filter = screen.getByPlaceholderText("Filter by name, label or image");
    filter.focus();
    await delayed.mountRow();
    expect(document.activeElement).toBe(filter);
  } finally { delayed.restore(); }
});
it.each(["help", "dock"] as const)("a proved Home Pod deleted during a %s return retains its owned fallback", async source => {
  const peers = Array.from({ length: 160 }, (_, i) => ({ ...pod, uid: `z${i}`, name: `z${i}` }));
  show(); await ready([failingPod, ...peers]);
  fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" }));
  podLink().focus(); await userEvent.keyboard("{Enter}");
  const exact = await waitFor(() => {
    const row = document.querySelector<HTMLElement>('[data-row-key="c1/p1"]');
    expect(row).toBeTruthy();
    expect(document.activeElement).toBe(row);
    return row!;
  });
  const watch = FakeWebSocket.last;
  const grid = exact.closest<HTMLElement>('[role="grid"]')!;
  if (source === "help") {
    fireEvent.keyDown(exact, { key: "?" });
    await screen.findByRole("dialog", { name: "All shortcuts" });
  } else {
    fireEvent.click(await screen.findByRole("button", { name: "Logs" }));
    const tab = await screen.findByRole("tab", { name: /Logs.*web-pod/ });
    tab.focus();
    const viewport = grid.parentElement!;
    Object.defineProperty(viewport, "scrollHeight", { value: 9000 });
    fireEvent.scroll(viewport, { target: { scrollTop: 3200 } });
    expect(exact.isConnected).toBe(false);
    viewport.scrollTo = vi.fn();
    fireEvent.keyDown(tab, { key: "Escape" });
    expect(viewport.scrollTo).toHaveBeenCalled();
    expect(document.activeElement).toBe(tab);
  }
  act(() => watch.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true,
    rows: [{ ...pod, uid: "replacement" }, ...peers] }));
  await screen.findByText("This Pod is no longer available");
  if (source === "help") fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => {
    const focus = document.activeElement;
    expect(focus === grid.closest("main") || (source === "help" && grid.contains(focus) && focus?.hasAttribute("data-row-key"))).toBe(true);
  });
  expect(grid.querySelector('[aria-selected="true"]')).toBeNull();
  expect(screen.queryByRole("tab", { name: "Describe" })).toBeNull();
});
it.each(["upsert", "multipart"] as const)("same-UID %s watch updates preserve the queue Pod's pending YAML draft and focus", async (update) => {
  // jsdom supplies DOM ranges but not browser layout measurements used by real CodeMirror.
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = createRange();
    range.getClientRects = () => [] as unknown as DOMRectList;
    range.getBoundingClientRect = () => new DOMRect();
    return range;
  });
  const originalFetch = vi.mocked(fetch);
  let updating = false;
  let completeDescribe!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.startsWith("/api/kinds")) return json({ ...KINDS, kinds: KINDS.kinds.map(k => k.key === "pods" ? { ...k, verbs: [...k.verbs, "update"] } : k) });
    if (url.includes("/yaml")) return json({ yaml: "apiVersion: v1\nkind: Pod\nmetadata:\n  name: web-pod\n" });
    if (url.includes("/describe") && updating) return new Promise<Response>(resolve => { completeDescribe = resolve; });
    return originalFetch(url);
  }));
  show(); await ready([{ ...failingPod, columns: { ...failingPod.columns, resource_version: "1" } }]);
  fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" })); fireEvent.click(podLink());
  await screen.findByRole("tab", { name: /Describe/ });
  fireEvent.click(screen.getByRole("button", { name: /^Edit/ }));
  const editor = await screen.findByRole("textbox", { name: "Edit Pod YAML" });
  const cm = EditorView.findFromDOM(editor)!;
  const draft = "# keep my unsaved change\n";
  act(() => cm.dispatch({ changes: { from: 0, insert: draft } }));
  editor.focus();
  expect((screen.getByRole("button", { name: /Review changes/ }) as HTMLButtonElement).disabled).toBe(false);
  updating = true;
  const updated = { ...failingPod, columns: { ...failingPod.columns, resource_version: "2" } };
  if (update === "multipart") {
    act(() => FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: false, rows: [updated] }));
    // Cross the shared watch's publication frame before checking mounted editor state.
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
    expect(editor.isConnected).toBe(true);
    expect(screen.getByRole("textbox", { name: "Edit Pod YAML" })).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect(cm.state.doc.toString()).toContain(draft);
    expect(screen.getByRole("tab", { name: /YAML/ }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByRole("button", { name: /Review changes/ }) as HTMLButtonElement).disabled).toBe(false);
    act(() => FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 1, last: true, rows: [] }));
  } else {
    act(() => FakeWebSocket.last.emit({ type: "upsert", cluster_id: "c1", row: updated }));
  }
  await waitFor(() => expect(completeDescribe).toBeTypeOf("function"));
  expect(editor.isConnected).toBe(true);
  expect(document.activeElement).toBe(editor);
  expect(cm.state.doc.toString()).toContain(draft);
  expect(screen.getByRole("tab", { name: /YAML/ }).getAttribute("aria-selected")).toBe("true");
  expect((screen.getByRole("button", { name: /Review changes/ }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => completeDescribe(await json(describeBody())));
  expect(screen.getByRole("textbox", { name: "Edit Pod YAML" })).toBe(editor);
  expect(cm.state.doc.toString()).toContain(draft);
  expect(document.activeElement).toBe(editor);
});
it("shows connections before the collapsed Pod queue and preserves discovery", async () => {
  clusters = [cluster, { ...cluster, id: "offline", name: "offline-cloud", source: "cloud", state: "error", message: "https://private.example:6443 refused" }];
  show(); await ready([failingPod]);
  const queue = screen.getByRole("heading", { name: "Problems right now" }).closest("section")!;
  const disclosure = within(queue).getByRole("button", { name: "Show 1 failing Pods" });
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(within(queue).getByRole("button", { name: /offline-cloud/ }).compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.body.textContent).not.toContain("private.example");
  fireEvent.click(disclosure); expect(podLink()).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Discovered clusters" })).toBeTruthy();
});
it("Home does not display retained or incomplete health", async () => {
  show(); await ready([failingPod]);
  act(() => FakeWebSocket.last.emit({ type: "cluster_status", cluster_id: "c1", state: "syncing", message: "retry" }));
  act(() => FakeWebSocket.last.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null }));
  await waitFor(() => expect(screen.queryByText("1 of 1 pods failing")).toBeNull());
  expect(screen.queryByRole("button", { name: "Show 1 failing Pods" })).toBeNull();
  act(() => FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: false, rows: [failingPod] }));
  expect(screen.queryByRole("button", { name: "Show 1 failing Pods" })).toBeNull();
  act(() => FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [] }));
  expect(await screen.findByText("No failing Pods")).toBeTruthy();
});
it("caps the Pod preview per cluster and offers the matched filter", async () => {
  show(); await screen.findByRole("button", { name: /prod-east/ });
  act(() => { FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: Array.from({ length: 7 }, (_, i) => ({ ...failingPod, uid: `bad-${i}`, name: `bad-${i}` })) }); FakeWebSocket.last.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null }); });
  fireEvent.click(await screen.findByRole("button", { name: "Show 7 failing Pods" }));
  expect(screen.getAllByRole("button", { name: /bad-.*CrashLoopBackOff/ })).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: "View all 7 failing Pods in prod-east" }));
  act(() => window.dispatchEvent(new Event("pagehide")));
  expect(JSON.parse(localStorage.getItem("omnikrux.workspace")!).kubernetes.tabs[0].view).toMatchObject({ clusters: ["c1"], filters: { status: "failing", namespace: null } });
});
it("Back restores the Pod link and the expanded queue", async () => {
  show(); await ready([failingPod]); fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" }));
  podLink().focus(); fireEvent.click(podLink());
  await landingSnapshot();
  await screen.findByRole("tab", { name: /Describe/ });
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("expected_uid=p1"))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await landingSnapshot();
  expect(await screen.findByRole("button", { name: "Hide 1 failing Pods" })).toBeTruthy();
  expect(document.activeElement).toBe(podLink());
});
it("recovers focus when the active link disappears", async () => {
  show(); await ready([failingPod]); fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" })); podLink().focus();
  act(() => FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [] }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Problems right now" })));
});
it("missing or replaced Pod never opens by name", async () => {
  const originalFetch = vi.mocked(fetch);
  vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/describe") ? json({ detail: "Not found" }, 404) : originalFetch(url)));
  show(); await ready([failingPod]); fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" })); fireEvent.click(podLink());
  await landingSnapshot();
  expect(await screen.findByText("This Pod is no longer available")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /Describe/ })).toBeNull();
});
it("a guarded landing waits for current completion and never selects a same-name replacement", async () => {
  const ws = defaultWorkspace();
  ws.kubernetes.tabs[0].view = { ...kindView(HOME, "pods", ["c1"]), filters: { ...kindView(HOME, "pods").filters, namespace: "demo" }, selected: { clusterId: "c1", uid: "p1" }, open: true, fromAttention: { clusterId: "c1", uid: "p1", namespace: "demo" } };
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws));
  show(); await screen.findByText(/Opening Pod/);
  act(() => { FakeWebSocket.last.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null }); FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: false, rows: [failingPod] }); });
  await waitFor(() => expect(screen.queryByRole("tab", { name: /Describe/ })).toBeNull());
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/describe"))).toHaveLength(0);
  await landingSnapshot([{ ...failingPod, uid: "replacement" }]);
  expect(await screen.findByText("This Pod is no longer available")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /Describe/ })).toBeNull();
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/describe"))).toHaveLength(0);
});
it("an unresolved queue landing stays held through a multipart refresh and requires fresh proof", async () => {
  const originalFetch = vi.mocked(fetch);
  const reads: Array<(response: Response) => void> = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/describe")
    ? new Promise<Response>(resolve => reads.push(resolve)) : originalFetch(url)));
  show(); await ready([failingPod]);
  fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" })); fireEvent.click(podLink());
  await waitFor(() => expect(reads).toHaveLength(1));
  act(() => FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: false, rows: [failingPod] }));
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  await act(async () => reads[0](await json(describeBody())));
  expect(screen.getByText(/Opening Pod/)).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /Describe/ })).toBeNull();
  act(() => FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 1, last: true, rows: [] }));
  await waitFor(() => expect(reads).toHaveLength(2));
  expect(screen.queryByRole("tab", { name: /Describe/ })).toBeNull();
  await act(async () => reads[1](await json(describeBody())));
  expect(await screen.findByRole("tab", { name: /Describe/ })).toBeTruthy();
});
it("the first move after a queue landing does not reveal the next row again", async () => {
  const peers = Array.from({ length: 40 }, (_, i) => ({ ...pod, uid: `z${i}`, name: `z${i}` }));
  show(); await ready([failingPod, ...peers]);
  fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" }));
  podLink().focus(); await userEvent.keyboard("{Enter}");
  const landed = await waitFor(() => {
    const row = document.querySelector<HTMLElement>('[data-row-key="c1/p1"]');
    expect(document.activeElement).toBe(row);
    return row!;
  });
  await screen.findByRole("tab", { name: /Describe/ });
  scrollRequests.length = 0;
  fireEvent.keyDown(landed, { key: "ArrowDown" });
  await waitFor(() => expect(document.activeElement?.getAttribute("data-row-key")).not.toBe("c1/p1"));
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  // An ordinary move keeps the list where it is; only a new landing aligns to the top.
  expect(scrollRequests.filter(r => r.align === "start")).toEqual([]);
});
it("a reconnect keeps an opened queue Pod selected like any other selection", async () => {
  show(); await ready([failingPod, pod2()]);
  fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" }));
  podLink().focus(); await userEvent.keyboard("{Enter}");
  await screen.findByRole("tab", { name: /Describe/ });
  const ws = FakeWebSocket.last;
  act(() => ws.emit({ type: "cluster_status", cluster_id: "c1", state: "syncing", message: "Watch restarted" }));
  await nextFrame();
  expect(screen.queryByText(/Opening Pod/)).toBeNull();
  act(() => {
    ws.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    ws.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [failingPod, pod2()] });
  });
  await nextFrame();
  expect(screen.queryByText(/Opening Pod/)).toBeNull();
  await screen.findByRole("tab", { name: /Describe/ });
  expect(document.querySelector('[data-row-key="c1/p1"]')?.getAttribute("aria-selected")).toBe("true");
});
it("a reconnect that loses the opened queue Pod says it is gone", async () => {
  show(); await ready([failingPod, pod2()]);
  fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" }));
  podLink().focus(); await userEvent.keyboard("{Enter}");
  await screen.findByRole("tab", { name: /Describe/ });
  const ws = FakeWebSocket.last;
  act(() => {
    ws.emit({ type: "cluster_status", cluster_id: "c1", state: "syncing", message: null });
    ws.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    ws.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [{ ...failingPod, uid: "p1-new" }, pod2()] });
  });
  expect(await screen.findByText("This Pod is no longer available")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /Describe/ })).toBeNull();
  expect(document.querySelector('[data-row-key="c1/p1-new"]')?.getAttribute("aria-selected")).not.toBe("true");
});
it("each queue visit rechecks identity and late proof preserves deliberate focus", async () => {
  const originalFetch = vi.mocked(fetch);
  let resolve!: (value: Response) => void;
  let delayed = false;
  vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/describe") && delayed ? new Promise<Response>(r => { resolve = r; }) : originalFetch(url)));
  show(); await ready([failingPod]); fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" }));
  podLink().focus(); await userEvent.keyboard("{Enter}");
  await screen.findByRole("tab", { name: /Describe/ });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("button", { name: "Hide 1 failing Pods" });
  delayed = true; fireEvent.click(podLink());
  expect(screen.queryByRole("tab", { name: /Describe/ })).toBeNull();
  const filter = await screen.findByPlaceholderText("Filter by name, label or image"); filter.focus();
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  await act(async () => resolve(await json(describeBody())));
  await screen.findByRole("tab", { name: /Describe/ });
  expect(document.activeElement).toBe(filter);
});
it("a recovering exact UID remains selectable and Back creates only one step", async () => {
  const originalFetch = vi.mocked(fetch);
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/describe") ? new Promise<Response>(r => { resolve = r; }) : originalFetch(url)));
  show(); await ready([failingPod]); fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" })); fireEvent.click(podLink());
  await landingSnapshot([pod]);
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  await act(async () => resolve(await json(describeBody())));
  await screen.findByRole("tab", { name: /Describe/ });
  act(() => window.dispatchEvent(new Event("pagehide")));
  const saved = JSON.parse(localStorage.getItem("omnikrux.workspace")!);
  expect(saved.kubernetes.tabs[0].back).toHaveLength(1);
  expect(saved.kubernetes.tabs[0].view.filters).toMatchObject({ status: "all", namespace: "demo" });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Problems right now" }));
});
it("last-cluster removal recovers Home search and unrelated updates preserve focus", async () => {
  show(); await ready([failingPod]); fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" }));
  search().focus(); await landingSnapshot([failingPod, { ...pod, uid: "healthy" }]);
  expect(document.activeElement).toBe(search());
  podLink().focus();
  act(() => FakeWebSocket.last.emit({ type: "cluster_removed", cluster_id: "c1" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Problems right now" })).toBeNull());
  expect(document.activeElement).toBe(search());
});
it("View all returns to its own surviving button", async () => {
  show(); await ready([failingPod]);
  const rows = Array.from({ length: 7 }, (_, i) => ({ ...failingPod, uid: `bad-${i}`, name: `bad-${i}` }));
  await landingSnapshot(rows);
  fireEvent.click(await screen.findByRole("button", { name: "Show 7 failing Pods" }));
  const label = "View all 7 failing Pods in prod-east";
  screen.getByRole("button", { name: label }).focus(); fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(document.activeElement).toBe(await screen.findByRole("button", { name: label }));
});
it("a keyboard queue link stays in its initiating split pane among duplicate names", async () => {
  const ws = defaultWorkspace();
  ws.kubernetes.tabs.push({ id: "peer", view: HOME, back: [], forward: [], scrollTop: 0 });
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws));
  show(); await ready([failingPod, { ...failingPod, uid: "other", namespace: "other" }]);
  const tabs = within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
  fireEvent.contextMenu(tabs.getAllByRole("tab", { name: "Home" })[1]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Split side by side" }));
  const panes = screen.getAllByRole("region", { name: "Home" });
  const right = panes[1];
  fireEvent.click(within(right).getByRole("button", { name: "Show 2 failing Pods" }));
  const target = within(right).getByRole("button", { name: /web-pod.*demo.*prod-east.*CrashLoopBackOff/ });
  target.focus(); await userEvent.keyboard("{Enter}");
  await within(right).findByRole("tab", { name: /Describe/ });
  await waitFor(() => expect((document.activeElement as HTMLElement)?.dataset.rowKey).toBe("c1/p1"));
  expect(right.getAttribute("data-active-pane")).toBe("true");
  expect(within(panes[0]).getByRole("heading", { name: "Where do you want to look?" })).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/describe")).every(([url]) => String(url).includes("/demo/web-pod/describe?expected_uid=p1"))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(document.activeElement).toBe(within(right).getByRole("button", { name: /web-pod.*demo.*prod-east.*CrashLoopBackOff/ }));
});
it("a late guarded result cannot reveal after navigating away", async () => {
  const originalFetch = vi.mocked(fetch);
  let resolve!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/describe") ? new Promise<Response>(r => { resolve = r; }) : originalFetch(url)));
  show(); await ready([failingPod]); fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" })); fireEvent.click(podLink());
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Back" })); search().focus();
  await act(async () => resolve(await json(describeBody())));
  expect(document.activeElement).toBe(search());
  expect(screen.queryByRole("tab", { name: /Describe/ })).toBeNull();
});
it("removing the opening Pod's last cluster keeps focus in its pane", async () => {
  const originalFetch = vi.mocked(fetch);
  vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/describe") ? new Promise<Response>(() => {}) : originalFetch(url)));
  show(); await ready([failingPod]); fireEvent.click(screen.getByRole("button", { name: "Show 1 failing Pods" }));
  podLink().focus(); await userEvent.keyboard("{Enter}");
  const pane = document.querySelector<HTMLElement>('[data-active-pane="true"]')!;
  act(() => FakeWebSocket.last.emit({ type: "cluster_removed", cluster_id: "c1" }));
  await screen.findByText(/No clusters yet/);
  expect(document.activeElement).toBe(pane);
});
async function landingSnapshot(rows = [failingPod]) {
  act(() => { FakeWebSocket.last.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows }); FakeWebSocket.last.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null }); });
}
async function ready(rows = [pod]) {
  const ws = FakeWebSocket.last;
  act(() => {
    ws.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows });
    ws.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
  });
  await screen.findByText(rows.some(r => r.columns.status_class === "bad") ? `${rows.filter(r => r.columns.status_class === "bad").length} of ${rows.length} pods failing` : `${rows.length} pods, all healthy`);
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
it("cluster cards show the cloud location and node pool counts", async () => {
  clusters = [{
    ...cluster, source: "cloud", provider: "gke", region: "europe-west1", server: null,
    cloud: { account_id: "gcp-1", account_name: "Production project", resource_id: "prod-east" },
    node_pools: [{ name: "system", count: 1, machine_type: "e2-standard-4", version: null }], node_count: 1,
  }];
  show();
  const card = await screen.findByRole("button", { name: /prod-east/ });
  expect(within(card).getByText("Google Cloud · europe-west1")).toBeTruthy();
  expect(within(card).getByText("1 node pool · 1 node")).toBeTruthy();
});
it("only the cloud card shows zero pools when node counts are unknown", async () => {
  clusters = [cluster, {
    ...cluster, id: "c2", name: "prod-west", source: "cloud", provider: "eks", server: null,
    cloud: { account_id: "aws-1", account_name: "West account", resource_id: "west" },
    node_pools: [], node_count: null,
  }];
  show();
  const cloudCard = await screen.findByRole("button", { name: /prod-west/ });
  const fileCard = screen.getByRole("button", { name: /prod-east/ });
  expect(within(cloudCard).getByText("0 node pools")).toBeTruthy();
  expect(within(cloudCard).queryByText(/0 nodes/)).toBeNull();
  expect(within(fileCard).queryByText(/node pools/)).toBeNull();
});
it("scope token tooltips follow the active split pane", async () => {
  const east: Cluster = {
    ...cluster, source: "cloud", server: null,
    cloud: { account_id: "azure-1", account_name: "East subscription", resource_id: "east" },
  };
  const west: Cluster = {
    ...east, id: "c2", name: "prod-west", provider: "eks",
    cloud: { account_id: "aws-1", account_name: "West account", resource_id: "west" },
  };
  clusters = [east, west];
  const workspace = defaultWorkspace();
  const active = workspace.kubernetes.tabs[0];
  active.view = kindView(HOME, "pods", [east.id]);
  workspace.kubernetes.tabs.push({ ...active, id: "peer", view: kindView(HOME, "deployments.apps", [west.id]) });
  localStorage.setItem("omnikrux.workspace", JSON.stringify(workspace));
  show();
  const tabs = within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
  const peer = await tabs.findByRole("tab", { name: "Deployments · prod-west" });
  fireEvent.contextMenu(peer);
  fireEvent.click(screen.getByRole("menuitem", { name: "Split side by side" }));
  const peerPane = screen.getByRole("region", { name: "Deployments · prod-west" });
  const peerWatch = FakeWebSocket.instances.find(ws => ws.params.get("kind") === "deployments.apps")!;
  const message = "West cluster is unavailable";
  act(() => peerWatch.emit({ type: "cluster_status", cluster_id: west.id, state: "error", message }));
  expect(await within(peerPane).findByText(message)).toBeTruthy();
  const activeToken = screen.getByTestId("scope-token");
  expect(activeToken.textContent).toContain(east.name);
  expect(activeToken.title).toContain(east.cloud!.account_name);
  expect(activeToken.title).not.toContain(west.cloud!.account_name);
  fireEvent.focus(within(peerPane).getByRole("textbox", { name: "Filter by name, label or image" }));
  const peerToken = screen.getByTestId("scope-token");
  expect(peerToken.textContent).toContain(west.name);
  expect(peerToken.title).toContain(west.cloud!.account_name);
  expect(peerToken.title).toContain(message);
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
  expect((await screen.findAllByText("Can't reach it: certificate expired")).length).toBeGreaterThan(0);
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
  removePinned("Pods");
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  expect(screen.getByRole("alert").textContent).toBe("Pinned kinds can't be saved in this browser (storage is full). Your changes last until you close this page.");
  set.mockRestore(); fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  expect(screen.queryByRole("alert")).toBeNull();
});
