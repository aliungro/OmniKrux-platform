import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(new Response(
    JSON.stringify(url.startsWith("/api/kinds") ? { ...KINDS, kinds: [...KINDS.kinds, SECRETS] } : url === "/api/clusters" ? [cluster] : []),
    { status: 200, headers: { "content-type": "application/json" } },
  ))));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderShell() {
  const workspace = defaultWorkspace();
  workspace.kubernetes.tabs[0].view = kindView({ page: "home" }, "pods", [cluster.id]);
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
