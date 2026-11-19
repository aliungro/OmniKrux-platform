import { KINDS } from "../../test/kinds";
import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import { defaultWorkspace, HOME, kindView } from "./workspace";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Shell } from "./Shell";

const gate = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve, delay: false };
});
vi.mock("../audit/AuditView", async importOriginal => {
  if (gate.delay) await gate.promise;
  return importOriginal();
});

vi.mock("../settings/SettingsView", () => { throw new Error("missing settings chunk"); });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps navigation and the new destination's focus while Audit loads", async () => {
  gate.delay = true;
  vi.stubGlobal("fetch", async () => Response.json([]));
  render(<QueryClientProvider client={new QueryClient()}><Shell /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Audit log" }));
  expect(screen.getByText("Loading the audit log…").getAttribute("role")).toBe("status");
  const home = screen.getByRole("button", { name: "Kubernetes" });
  fireEvent.click(home);
  home.focus();
  await act(async () => { gate.resolve(); await vi.dynamicImportSettled(); });
  expect(screen.getByRole("heading", { name: "Where do you want to look?" })).toBeTruthy();
  expect(document.activeElement).toBe(home);
});

it("keeps the rail usable after the Settings import fails", async () => {
  vi.stubGlobal("fetch", async () => Response.json([]));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(<QueryClientProvider client={new QueryClient()}><Shell /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't load settings. Reload the page.");
    fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
    expect(screen.getByRole("heading", { name: "Where do you want to look?" })).toBeTruthy();
  } finally { log.mockRestore(); }
});

const tableGate = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
});
vi.mock("../territories/TerritoryTable", async importOriginal => {
  await tableGate.promise;
  return importOriginal();
});

it("offers restored row actions only after the table mounts and keeps focus in the peer pane", async () => {
  const east = { ...FILE_CLUSTER_METADATA, id: "c1", name: "East", provider: "aks", state: "ready" };
  vi.stubGlobal("fetch", async (url: string) => Response.json(url === "/api/clusters" ? [east] : url.startsWith("/api/kinds") ? KINDS : []));
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const ws = defaultWorkspace();
  const tab = ws.kubernetes.tabs[0];
  tab.view = { ...kindView(HOME, "pods"), selected: { clusterId: "c1", uid: "first" } };
  ws.kubernetes.tabs.push({ id: "peer", view: HOME, back: [], forward: [], scrollTop: 0 });
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws));
  render(<QueryClientProvider client={new QueryClient()}><Shell /></QueryClientProvider>);
  await screen.findByText("Loading resources…");
  const watch = await waitFor(() => {
    const socket = FakeWebSocket.instances.find(s => s.params.get("kind") === "pods" && !s.closedByClient);
    expect(socket).toBeTruthy();
    return socket!;
  });
  act(() => {
    watch.emit({ type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    watch.emit({ type: "snapshot", cluster_id: "c1", part: 0, last: true,
      rows: [{ uid: "first", cluster_id: "c1", kind: "Pod", namespace: "demo", name: "api-first", created_at: null, labels: {}, columns: {} }] });
  });
  await within(screen.getByRole("tablist", { name: "Kinds" })).findByText("1");
  const palette = screen.getByRole("button", { name: "Commands and kinds" });
  fireEvent.click(palette);
  expect(screen.queryByRole("group", { name: /Actions/ })).toBeNull();
  fireEvent.keyDown(within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox"), { key: "Escape" });
  fireEvent.contextMenu(screen.getByRole("tab", { name: "Home" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Split side by side" }));
  const peer = screen.getByRole("region", { name: "Home" });
  act(() => peer.focus());
  await act(async () => { tableGate.resolve(); await vi.dynamicImportSettled(); });
  expect(document.activeElement).toBe(peer);
  fireEvent.click(palette);
  expect(screen.queryByRole("group", { name: /Actions/ })).toBeNull();
  fireEvent.keyDown(within(screen.getByRole("dialog", { name: "Commands" })).getByRole("combobox"), { key: "Escape" });
  const origin = screen.getByRole("region", { name: /^Pods .*all clusters$/ });
  act(() => origin.focus());
  fireEvent.click(palette);
  fireEvent.click(await screen.findByRole("option", { name: /Details of api-first/ }));
  await waitFor(() => {
    const saved = JSON.parse(localStorage.getItem("omnikrux.workspace")!);
    expect(saved.kubernetes.tabs[0].view.open).toBe(true);
    expect(saved.kubernetes.tabs[1].view.page).toBe("home");
  });
});
