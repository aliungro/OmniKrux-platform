import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FakeWebSocket } from "./features/logs/fakeWebSocket";
import { Shell } from "./features/shell/Shell";
import { seedPodsWorkspace } from "./test/seedWorkspace";
import { KINDS } from "./test/kinds";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("./features/territories/TerritoryTable", async (original) => {
  const actual = await original<typeof import("./features/territories/TerritoryTable")>();
  const { useGoTo } = await import("./features/navigation/navigation");
  function Table(props: ComponentProps<typeof actual.TerritoryTable>) {
    const goTo = useGoTo();
    return <><button onClick={() => goTo({ clusterId: "c2", kind_key: props.kind.key === "pods" ? "deployments.apps" : "pods", namespace: "demo", name: "target" })}>Cross-kind link</button><button onClick={() => goTo({ clusterId: "c2", kind_key: props.kind.key, namespace: "demo", name: "target" })}>Same-kind link</button><actual.TerritoryTable {...props} /></>;
  }
  return { ...actual, TerritoryTable: Table };
});
const clusters = ["c1", "c2"].map(id => ({ id, name: id, context_name: id, server: "https://x", original_server: null, provider: "kind", region: null, environment: "development", state: "ready", message: null }));
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
beforeEach(() => {
  seedPodsWorkspace();
  const saved = JSON.parse(localStorage.getItem("omnikrux.workspace")!);
  saved.kubernetes.tabs[0].view.clusters = ["c1"];
  localStorage.setItem("omnikrux.workspace", JSON.stringify(saved));
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn((url: string) => json(url.startsWith("/api/kinds") ? KINDS : url === "/api/clusters" ? clusters : [])));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([ ["Same-kind link", "pods"], ["Cross-kind link", "deployments.apps"] ])("%s includes an excluded target and Back restores its origin", async (link, kind) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Shell /></QueryClientProvider>);
  await screen.findByRole("button", { name: link });
  fireEvent.click(screen.getByRole("button", { name: link }));
  await waitFor(() => expect(FakeWebSocket.instances.some(w => w.params.get("kind") === kind && !w.closedByClient)).toBe(true));
  const socket = FakeWebSocket.instances.filter(w => w.params.get("kind") === kind && !w.closedByClient).at(-1)!;
  act(() => {
    socket.emit({ type: "cluster_status", cluster_id: "c2", state: "ready", message: null });
    socket.emit({ type: "snapshot", cluster_id: "c2", part: 0, last: true, rows: [{ uid: "target-uid", cluster_id: "c2", kind: kind === "pods" ? "Pod" : "Deployment", namespace: "demo", name: "target", created_at: null, labels: {}, columns: {} }] });
  });
  expect(await screen.findByRole("region", { name: "Details for target" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clusters" }).textContent).toContain("2 clusters");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("grid", { name: "Pods by cluster" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Clusters" }).textContent).toContain("c1");
  expect(screen.queryByRole("region", { name: "Details for target" })).toBeNull();
});
