import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KINDS, SECRETS } from "../../test/kinds";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import { Shell } from "./Shell";
import { defaultWorkspace, kindView } from "./workspace";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const cluster = {
  id: "c1", name: "East", provider: "aks", context_name: "east", server: "https://east",
  original_server: null, region: null, environment: "development", state: "ready", message: null,
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(
    JSON.stringify(url.startsWith("/api/kinds") ? { ...KINDS, kinds: [...KINDS.kinds, SECRETS] } : url === "/api/clusters" ? [cluster] : []),
    { status: 200, headers: { "content-type": "application/json" } },
  ))));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

it("offers Edit pinned kinds on the workspace tab, empty kind strip and blank console", async () => {
  renderShell();
  const kinds = await screen.findByRole("tablist", { name: "Kinds" });
  const workspaceTab = within(screen.getByRole("tablist", { name: "Kubernetes tabs" })).getByRole("tab");
  const main = screen.getByRole("main");
  for (const target of [workspaceTab, kinds, main]) {
    fireEvent.contextMenu(target);
    expect(screen.getByRole("menuitem", { name: /Edit pinned kinds/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  }
  fireEvent.contextMenu(main);
  fireEvent.click(screen.getByRole("menuitem", { name: /Edit pinned kinds/ }));
  expect(await screen.findByRole("heading", { name: "Pinned kinds" })).toBeTruthy();
});
