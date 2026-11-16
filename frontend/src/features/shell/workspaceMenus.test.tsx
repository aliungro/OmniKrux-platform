import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KINDS, SECRETS } from "../../test/kinds";
import { describeBody } from "../../test/describe";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import { Shell } from "./Shell";
import { defaultWorkspace, kindView } from "./workspace";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const cluster = {
  id: "c1", name: "East", provider: "aks", context_name: "east", server: "https://east",
  ...FILE_CLUSTER_METADATA, original_server: null, region: null, environment: "development", state: "ready", message: null,
};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(
    JSON.stringify(url.startsWith("/api/kinds") ? { ...KINDS, kinds: [...KINDS.kinds, SECRETS] }
      : url === "/api/clusters" ? [cluster]
      : url === "/api/settings" ? { encryption: { source: "environment", path: null }, discovery_interval_s: 600 }
      : url.endsWith("/describe") ? describeBody() : []),
    { status: 200, headers: { "content-type": "application/json" } },
  ))));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function renderShell(splitReady = false, peerKind = "secrets") {
  const workspace = defaultWorkspace();
  workspace.kubernetes.tabs[0].view = kindView({ page: "home" }, "pods", [cluster.id]);
  if (splitReady) {
    workspace.kubernetes.tabs.push(
      { ...workspace.kubernetes.tabs[0], id: "peer", view: kindView({ page: "home" }, peerKind, [cluster.id]) },
      { ...workspace.kubernetes.tabs[0], id: "nodes", view: kindView({ page: "home" }, "nodes", [cluster.id]) },
    );
  }
  localStorage.setItem("omnikrux.workspace", JSON.stringify(workspace));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Shell /></QueryClientProvider>);
}

it("opens a kind in a fresh tab in the current scope and middle-click closes only the target tab", async () => {
  renderShell();
  const kinds = await screen.findByRole("tablist", { name: "Kinds" });
  const filter = screen.getByRole("textbox", { name: "Filter by name, label or image" });
  fireEvent.change(filter, { target: { value: "current-filter" } });
  fireEvent.contextMenu(await within(kinds).findByRole("tab", { name: "Secrets" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open in new tab" }));
  const tabs = within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
  const secrets = tabs.getByRole("tab", { name: "Secrets · East", selected: true });
  expect((screen.getByRole("textbox", { name: "Filter by name, label or image" }) as HTMLInputElement).value).toBe("");
  const pods = tabs.getByRole("tab", { name: "Pods · East" });
  fireEvent(pods, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(tabs.getAllByRole("tab")).toEqual([secrets]);
  fireEvent(secrets, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(tabs.getByRole("tab", { name: "Home", selected: true })).toBeTruthy();
});

it("shares a socket between visible same-kind panes and releases all Kubernetes watches in Settings", async () => {
  renderShell(true, "pods");
  const tabs = within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
  await screen.findByRole("grid", { name: "Pods by cluster" });
  fireEvent.contextMenu(tabs.getByRole("tab", { name: "Pods · East", selected: false }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Split side by side" }));
  expect(screen.getAllByRole("grid", { name: "Pods by cluster" })).toHaveLength(2);
  const openKinds = () => FakeWebSocket.instances.filter((ws) => !ws.closedByClient).map((ws) => ws.params.get("kind"));
  await waitFor(() => expect(openKinds()).toEqual(["pods"]));
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await waitFor(() => expect(openKinds()).toEqual([]));
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  await waitFor(() => expect(openKinds()).toEqual(["pods"]));
  fireEvent.click(tabs.getByRole("tab", { name: "Nodes · East" }));
  await waitFor(() => expect(openKinds().sort()).toEqual(["nodes", "pods"]));
  fireEvent(tabs.getByRole("tab", { name: "Nodes · East" }), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  await waitFor(() => expect(openKinds()).toEqual(["pods"]));
  expect(screen.getAllByRole("grid", { name: "Pods by cluster" })).toHaveLength(1);
});

it("shares a committed column width between same-kind panes while drag previews stay local", async () => {
  renderShell(true, "pods");
  const tabs = within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
  await screen.findByRole("grid", { name: "Pods by cluster" });
  fireEvent.contextMenu(tabs.getByRole("tab", { name: "Pods · East", selected: false }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Split side by side" }));
  const [left, right] = screen.getAllByRole("grid", { name: "Pods by cluster" });
  const handle = within(left).getByRole("separator", { name: "Resize Name" });
  vi.spyOn(handle.closest("[role=columnheader]")!, "getBoundingClientRect")
    .mockReturnValue({ width: 200 } as DOMRect);
  const pointer = (type: string, clientX: number) =>
    fireEvent(handle, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), { pointerId: 1 }));
  const columns = (grid: HTMLElement) => grid.style.getPropertyValue("--cols");
  const original = columns(right);
  pointer("pointerdown", 100);
  pointer("pointermove", 130);
  await waitFor(() => expect(columns(left)).toMatch(/^230px /));
  expect(columns(right)).toBe(original);
  pointer("pointerup", 140);
  expect(columns(left)).toMatch(/^240px /);
  expect(columns(right)).toBe(columns(left));
  fireEvent.keyDown(handle, { key: "Enter" });
  expect(columns(right)).toBe(original);
});

it("splits workspace tabs, routes focus and history, and keeps the peer when a third tab replaces the active pane", async () => {
  renderShell(true);
  const tabs = within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
  const secrets = await tabs.findByRole("tab", { name: "Secrets · East" });
  fireEvent.contextMenu(secrets);
  fireEvent.click(screen.getByRole("menuitem", { name: "Split side by side" }));
  const podsPane = await screen.findByRole("region", { name: "Pods · East" });
  const secretsPane = screen.getByRole("region", { name: "Secrets · East" });
  const podsFilter = within(podsPane).getByRole("textbox", { name: "Filter by name, label or image" });
  const secretsFilter = within(secretsPane).getByRole("textbox", { name: "Filter by name, label or image" });
  fireEvent.focus(podsFilter);
  fireEvent.change(podsFilter, { target: { value: "one" } });
  fireEvent.focus(secretsFilter);
  fireEvent.change(secretsFilter, { target: { value: "two" } });
  fireEvent.keyDown(document.body, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
  expect((podsFilter as HTMLInputElement).value).toBe("one");
  expect((secretsFilter as HTMLInputElement).value).toBe("");

  fireEvent.click(tabs.getByRole("tab", { name: "Nodes · East" }));
  expect(screen.getByRole("region", { name: "Nodes · East" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Pods · East" })).toBe(podsPane);
  expect(screen.queryByRole("region", { name: "Secrets · East" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.queryByRole("region", { name: "Pods · East" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  expect(await screen.findByRole("region", { name: "Pods · East" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close split" }));
  expect(screen.queryByRole("region", { name: "Pods · East" })).toBeNull();
  expect(tabs.getByRole("tab", { name: "Nodes · East", selected: true })).toBeTruthy();
});

it("offers Edit pinned kinds only on actual tabs", async () => {
  renderShell();
  const kinds = await screen.findByRole("tablist", { name: "Kinds" });
  const workspace = screen.getByRole("tablist", { name: "Kubernetes tabs" });
  const workspaceTab = within(workspace).getByRole("tab");
  const kindTab = await within(kinds).findByRole("tab", { name: "Secrets" });
  const main = screen.getByRole("main");
  for (const target of [main, kinds, workspace]) {
    expect(fireEvent.contextMenu(target)).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  }
  for (const target of [workspaceTab, kindTab]) {
    fireEvent.contextMenu(target);
    expect(screen.getByRole("menuitem", { name: /Edit pinned kinds/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  }
  fireEvent.contextMenu(workspaceTab);
  fireEvent.click(screen.getByRole("menuitem", { name: /Edit pinned kinds/ }));
  expect(await screen.findByRole("heading", { name: "Pinned kinds" })).toBeTruthy();
});

it("opens a kind and then a pointed pod in new split tabs while keeping their source panes", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  renderShell();
  const pods = await waitFor(() => {
    const socket = FakeWebSocket.instances.find(w => w.params.get("kind") === "pods");
    expect(socket).toBeDefined();
    return socket!;
  });
  act(() => {
    pods.emit({ type: "cluster_status", cluster_id: cluster.id, state: "ready", message: null });
    pods.emit({ type: "snapshot", cluster_id: cluster.id, part: 0, last: true, rows: [
      { uid: "first", cluster_id: cluster.id, kind: "Pod", name: "first-pod", namespace: "demo", labels: {}, columns: {}, created_at: null },
      { uid: "second", cluster_id: cluster.id, kind: "Pod", name: "second-pod", namespace: "demo", labels: {}, columns: {}, created_at: null },
    ] });
  });
  fireEvent.contextMenu(await screen.findByRole("tab", { name: "Secrets" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open in new split tab" }));
  const sourcePane = await screen.findByRole("region", { name: "Pods · East" });
  expect(screen.getByRole("region", { name: "Secrets · East" }).dataset.activePane).toBe("true");
  fireEvent.click(await within(sourcePane).findByText("first-pod"));
  fireEvent.contextMenu(within(sourcePane).getByText("second-pod"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open in new split tab" }));
  const newPane = screen.getAllByRole("region", { name: "Pods · East" }).find(pane => pane !== sourcePane)!;
  expect(newPane.dataset.activePane).toBe("true");
  expect(within(newPane).getByRole("region", { name: "Details for second-pod" })).toBeTruthy();
  expect(within(sourcePane).getByRole("region", { name: "Details for first-pod" })).toBeTruthy();
  const tabs = within(screen.getByRole("tablist", { name: "Kubernetes tabs" }));
  expect(tabs.getByRole("tab", { name: "Secrets · East", selected: false })).toBeTruthy();
});
