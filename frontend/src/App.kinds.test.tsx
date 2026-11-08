// frontend/src/App.kinds.test.tsx — Console with the real watch (App.test.tsx mocks it).
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FakeWebSocket } from "./features/logs/fakeWebSocket";
import { Console } from "./App";
import { KINDS } from "./test/kinds";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const cluster = { id: "c1", name: "kind-omnikrux-dev", context_name: "kind-omnikrux-dev", server: "https://127.0.0.1:6443", original_server: null, provider: "kind", region: null, environment: "development", state: "ready", message: null };
const pod = { uid: "p1", cluster_id: "c1", kind: "Pod", namespace: "demo", name: "crasher-1", created_at: null, labels: {}, columns: { status: "CrashLoopBackOff", status_class: "bad", node: "n1" } };

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn((url: string) => json(url.startsWith("/api/kinds") ? KINDS : url === "/api/port-forwards" ? [] : [cluster])));
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
      tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null,
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
    await waitFor(() => expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Pods1"));

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
