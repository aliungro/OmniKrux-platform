// frontend/src/App.kinds.test.tsx — Console with the real watch (App.test.tsx mocks it).
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FakeWebSocket } from "./features/logs/fakeWebSocket";
import { Shell as Console } from "./features/shell/Shell";
import { seedPodsWorkspace } from "./test/seedWorkspace";
import { KINDS } from "./test/kinds";
import { describeBody } from "./test/describe";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const cluster = { id: "c1", name: "kind-omnikrux-dev", context_name: "kind-omnikrux-dev", server: "https://127.0.0.1:6443", original_server: null, provider: "kind", region: null, environment: "development", state: "ready", message: null };
const pod = { uid: "p1", cluster_id: "c1", kind: "Pod", namespace: "demo", name: "crasher-1", created_at: null, labels: {}, columns: { status: "CrashLoopBackOff", status_class: "bad", node: "n1" } };

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  seedPodsWorkspace();
  window.history.replaceState(null, "", "/");
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.startsWith("/api/kinds")) return json(KINDS);
    if (url === "/api/port-forwards" || url.startsWith("/api/cloud/")) return json([]);
    if (url.endsWith("/pods/demo/crasher-1/describe")) {
      const details = describeBody();
      return json({ ...details, pod: { ...details.pod, name: pod.name, namespace: pod.namespace } });
    }
    return json([cluster]);
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("kind switches", () => {
  it("the first render after a switch shows neither the previous kind's rows nor its count", async () => {
    /** What each commit put on screen. */
    const commits: { grid: string | null; crasher: boolean; tab: string | null }[] = [];
    const record = () => commits.push({
      grid: document.querySelector('[role="grid"]')?.getAttribute("aria-label") ?? null,
      crasher: document.body.textContent?.includes("crasher-1") ?? false,
      tab: document.querySelector('[aria-label="Kinds"] [role="tab"][aria-selected="true"]')?.textContent ?? null,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Profiler id="console" onRender={record}>
          <Console />
        </Profiler>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(FakeWebSocket.instances.some((w) => w.params.get("kind") === "pods")).toBe(true));
    const pods = FakeWebSocket.instances.find((w) => w.params.get("kind") === "pods")!;
    act(() => {
      pods.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
      pods.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [pod] });
    });
    expect(await screen.findByText("crasher-1")).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole("tablist", { name: "Kinds" })).getByRole("tab", { selected: true }).textContent).toBe("Pods1"));

    const tab = await screen.findByRole("tab", { name: "Deployments" });
    commits.length = 0;
    fireEvent.click(tab);
    await waitFor(() => expect(FakeWebSocket.instances.some((w) => w.params.get("kind") === "deployments.apps")).toBe(true));
    const after = commits.filter((c) => c.grid === "Deployments by cluster");
    expect(after.length).toBeGreaterThan(0);
    for (const c of after) {
      expect(c.crasher).toBe(false);
      expect(c.tab).toBe("Deployments");
    }
    expect(pods.closedByClient).toBe(true);
  });
});

it("unmounts the background Kubernetes view when a home tab opens", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  await waitFor(() => expect(FakeWebSocket.instances.some(w => w.params.get("kind") === "pods")).toBe(true));
  const socket = FakeWebSocket.instances.find(w => w.params.get("kind") === "pods")!;
  fireEvent.click(screen.getByRole("button", {name:"New tab"}));
  expect(screen.getByRole("heading",{name:"Where do you want to look?"})).toBeTruthy();
  expect(socket.closedByClient).toBe(true);
});

it("typing a filter makes one history entry and back restores it", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  const input = await screen.findByPlaceholderText("Filter by name, label or image") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "a" } });
  fireEvent.change(input, { target: { value: "ab" } });
  fireEvent.change(input, { target: { value: "abc" } });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(input.value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Forward" }));
  expect(input.value).toBe("abc");
});

it("scoping a tab shows only the selected cluster and its stripe", async () => {
  const second = { ...cluster, id: "c2", name: "second", provider: "gke" };
  vi.stubGlobal("fetch", vi.fn((url: string) => json(url.startsWith("/api/kinds") ? KINDS : url === "/api/port-forwards" || url.startsWith("/api/cloud/") ? [] : [cluster, second])));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Clusters" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /second/ }));
  const filters = within(screen.getByRole("group", { name: "Filter rows" }));
  expect(filters.getByText("kind-omnikrux-dev")).toBeTruthy();
  expect(document.activeElement).toBe(filters.getByRole("button", { name: "Show all clusters" }));
  expect(screen.getAllByTestId("scope-token")).toHaveLength(1);
  expect(screen.getByRole("tab", { name: "Pods · kind-omnikrux-dev" })).toBeTruthy();
  expect(screen.queryByText("second", { selector: '[role="rowheader"] b' })).toBeNull();
});

it("restored details wait for the complete snapshot", async () => {
  const saved = JSON.parse(localStorage.getItem("omnikrux.workspace")!);
  saved.kubernetes.tabs[0].view.selected = { clusterId: "c1", uid: "p1" };
  saved.kubernetes.tabs[0].view.open = true;
  localStorage.setItem("omnikrux.workspace", JSON.stringify(saved));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  await waitFor(() => expect(FakeWebSocket.instances.some(w => w.params.get("kind") === "pods")).toBe(true));
  const socket = FakeWebSocket.instances.find(w => w.params.get("kind") === "pods")!;
  await screen.findByRole("grid", { name: "Pods by cluster" });
  act(() => socket.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null }));
  await screen.findByText("No pods");
  act(() => socket.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [pod] }));
  expect(await screen.findByRole("region", { name: "Details for crasher-1" })).toBeTruthy();
});

it("typing after back starts a new history entry", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  const input = await screen.findByPlaceholderText("Filter by name, label or image") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "first" } });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.change(input, { target: { value: "second" } });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(input.value).toBe("");
});

it("a removed scoped cluster falls back to all clusters with a note", async () => {
  const saved = JSON.parse(localStorage.getItem("omnikrux.workspace")!);
  saved.kubernetes.tabs[0].view.clusters = ["missing"];
  localStorage.setItem("omnikrux.workspace", JSON.stringify(saved));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  expect(await screen.findByText("The cluster this tab looked at is gone from Omnikrux, so it shows every cluster.")).toBeTruthy();
  const filters = within(screen.getByRole("group", { name: "Filter rows" }));
  expect(filters.getByText("kind-omnikrux-dev")).toBeTruthy();
  expect(filters.queryByRole("button", { name: "Show all clusters" })).toBeNull();
});

it("a tab restores its filter after switching away and back", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  const input = await screen.findByPlaceholderText("Filter by name, label or image") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "crasher" } });
  fireEvent.click(screen.getByRole("button", { name: "New tab" }));
  fireEvent.click(within(screen.getByRole("tablist", { name: "Kubernetes tabs" })).getAllByRole("tab")[0]);
  expect((await screen.findByPlaceholderText("Filter by name, label or image") as HTMLInputElement).value).toBe("crasher");
});

it("scope token collapse follows the scoped cluster count", async () => {
  const clusters = Array.from({ length: 6 }, (_, i) => ({ ...cluster, id: `c${i}`, name: `cluster-${i}` }));
  vi.stubGlobal("fetch", vi.fn((url: string) => json(url.startsWith("/api/kinds") ? KINDS : url === "/api/port-forwards" || url.startsWith("/api/cloud/") ? [] : clusters)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Clusters" }));
  expect(screen.getByText("+2")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /cluster-5/ }));
  expect(screen.getByText("+1")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /cluster-4/ }));
  expect(screen.queryByText("+1")).toBeNull();
  expect(screen.getAllByTestId("scope-token")).toHaveLength(4);
});

it("reload restores filters and open details", async () => {
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = render(<QueryClientProvider client={client()}><Console /></QueryClientProvider>);
  await waitFor(() => expect(FakeWebSocket.instances.some(w => w.params.get("kind") === "pods")).toBe(true));
  const send = (socket: FakeWebSocket) => act(() => {
    socket.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    socket.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [pod] });
  });
  send(FakeWebSocket.instances.find(w => w.params.get("kind") === "pods")!);
  fireEvent.change(await screen.findByPlaceholderText("Filter by name, label or image"), { target: { value: "crasher" } });
  fireEvent.click(await screen.findByText("crasher-1", { selector: '[role="gridcell"]' }));
  expect(await screen.findByRole("region", { name: "Details for crasher-1" })).toBeTruthy();
  first.unmount();
  render(<QueryClientProvider client={client()}><Console /></QueryClientProvider>);
  await waitFor(() => expect(FakeWebSocket.instances.filter(w => w.params.get("kind") === "pods")).toHaveLength(2));
  send(FakeWebSocket.instances.filter(w => w.params.get("kind") === "pods")[1]);
  expect((await screen.findByPlaceholderText("Filter by name, label or image") as HTMLInputElement).value).toBe("crasher");
  expect(await screen.findByRole("region", { name: "Details for crasher-1" })).toBeTruthy();
});

it("background tabs hold no watch", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  await waitFor(() => expect(FakeWebSocket.instances.some(w => w.params.get("kind") === "pods")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "New tab" }));
  fireEvent.click(await screen.findByRole("button", { name: /kind-omnikrux-dev/ }));
  fireEvent.click(await screen.findByRole("tab", { name: "Deployments" }));
  await waitFor(() => expect(FakeWebSocket.instances.some(w => w.params.get("kind") === "deployments.apps" && !w.closedByClient)).toBe(true));
  expect(FakeWebSocket.instances.filter(w => !w.closedByClient).map(w => w.params.get("kind"))).toEqual(["deployments.apps"]);
  fireEvent.click(within(screen.getByRole("tablist", { name: "Kubernetes tabs" })).getAllByRole("tab")[0]);
  await waitFor(() => expect(FakeWebSocket.instances.filter(w => !w.closedByClient).map(w => w.params.get("kind"))).toEqual(["pods"]));
});

it("keeps the removed-scope notice when no clusters remain", async () => {
  const saved = JSON.parse(localStorage.getItem("omnikrux.workspace")!);
  saved.kubernetes.tabs[0].view.clusters = ["missing"];
  localStorage.setItem("omnikrux.workspace", JSON.stringify(saved));
  vi.stubGlobal("fetch", vi.fn((url: string) => json(url.startsWith("/api/kinds") ? KINDS : [])));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  expect(await screen.findByText("The cluster this tab looked at is gone from Omnikrux, so it shows every cluster.")).toBeTruthy();
});

it("a removed-scope notice disappears when Back restores a different scope", async () => {
  const saved = JSON.parse(localStorage.getItem("omnikrux.workspace")!);
  const tab = saved.kubernetes.tabs[0];
  tab.back = [{ ...tab.view, clusters: ["c1"] }];
  tab.view.clusters = ["missing"];
  localStorage.setItem("omnikrux.workspace", JSON.stringify(saved));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  const notice = "The cluster this tab looked at is gone from Omnikrux, so it shows every cluster.";
  expect(await screen.findByText(notice)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  const filters = within(screen.getByRole("group", { name: "Filter rows" }));
  expect(filters.getByText("kind-omnikrux-dev")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Pods · kind-omnikrux-dev" })).toBeTruthy();
  expect(screen.queryByText(notice)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Forward" }));
  expect(screen.getByText(notice)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Deployments" }));
  expect(screen.queryByText(notice)).toBeNull();
});

it("reload restores the saved scroll position when rows arrive", async () => {
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const first = render(<QueryClientProvider client={client()}><Console /></QueryClientProvider>);
  await waitFor(() => expect(FakeWebSocket.instances.some(w => w.params.get("kind") === "pods")).toBe(true));
  const rows = Array.from({ length: 80 }, (_, i) => ({ ...pod, uid: `p${i}`, name: `pod-${i}` }));
  const send = (socket: FakeWebSocket) => act(() => {
    socket.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    socket.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows });
  });
  send(FakeWebSocket.instances[0]);
  const grid = await screen.findByRole("grid", { name: "Pods by cluster" });
  await screen.findByText("pod-0", { selector: '[role="gridcell"]' });
  const scroller = grid.parentElement!;
  fireEvent.scroll(scroller, { target: { scrollTop: 360 } });
  await waitFor(() => expect(JSON.parse(localStorage.getItem("omnikrux.workspace")!).kubernetes.tabs[0].scrollTop).toBe(360), { timeout: 2000 });
  first.unmount();
  render(<QueryClientProvider client={client()}><Console /></QueryClientProvider>);
  await waitFor(() => expect(FakeWebSocket.instances.filter(w => w.params.get("kind") === "pods")).toHaveLength(2));
  send(FakeWebSocket.instances.filter(w => w.params.get("kind") === "pods")[1]);
  const restored = (await screen.findByRole("grid", { name: "Pods by cluster" })).parentElement!;
  await waitFor(() => expect(restored.scrollTop).toBe(360));
});

it("Back to deleted details returns to a closed list", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  await waitFor(() => expect(FakeWebSocket.instances.some(w => w.params.get("kind") === "pods")).toBe(true));
  const socket = FakeWebSocket.instances.find(w => w.params.get("kind") === "pods")!;
  act(() => {
    socket.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    socket.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true, rows: [pod] });
  });
  fireEvent.click(await screen.findByText("crasher-1", { selector: '[role="gridcell"]' }));
  expect(await screen.findByRole("region", { name: "Details for crasher-1" })).toBeTruthy();
  fireEvent.click(screen.getByText("crasher-1", { selector: '[role="gridcell"]' }));
  act(() => socket.emit({ type: "delete", cluster_id: "c1", uid: "p1" }));
  await waitFor(() => expect(screen.queryByText("crasher-1", { selector: '[role="gridcell"]' })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.queryByRole("region", { name: "Details for crasher-1" })).toBeNull();
  expect(screen.getByRole("grid", { name: "Pods by cluster" })).toBeTruthy();
});

it("a restored kind no cluster serves shows the absent band", async () => {
  const saved = JSON.parse(localStorage.getItem("omnikrux.workspace")!);
  saved.kubernetes.tabs[0].view.kind = "widgets.example.io";
  localStorage.setItem("omnikrux.workspace", JSON.stringify(saved));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
  await waitFor(() => expect(FakeWebSocket.instances.some(w => w.params.get("kind") === "widgets.example.io")).toBe(true));
  const socket = FakeWebSocket.instances.find(w => w.params.get("kind") === "widgets.example.io")!;
  act(() => socket.emit({ type: "cluster_status", cluster_id: "c1", state: "absent", message: "This cluster doesn't serve widgets.example.io." }));
  expect((await screen.findByTestId("band-absent")).textContent).toContain("doesn't serve widgets.example.io");
});
