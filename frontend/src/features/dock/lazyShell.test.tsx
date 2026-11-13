import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Cluster } from "../../api/types";
import { FakeWebSocket } from "../logs/fakeWebSocket";
import type { Session } from "./dockState";

// The terminal's chunk is gone (the image was upgraded while this tab stayed open).
vi.mock("../shell/ShellPane", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

import { Dock } from "./Dock";
import { useDock, type DockApi } from "./useDock";

const aks: Cluster = {
  id: "c1",
  name: "aks-prod-weu",
  context_name: "aks-prod-weu",
  server: "https://x",
  ...FILE_CLUSTER_METADATA, original_server: null,
  provider: "aks",
  region: null,
  environment: "production",
  state: "ready",
  message: null,
};

let dock: DockApi;
function Harness() {
  dock = useDock([aks]);
  return (
    <>
      <button type="button" onClick={() => dock.askNodeShell("c1", "aks-np1-03")}>node shell</button>
      <Dock dock={dock} />
    </>
  );
}

function renderDock() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.spyOn(console, "error").mockImplementation(() => {}); // React reports the caught error
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("when the terminal's code can't load", () => {
  it("the shell pane says so in plain words, and the rest of the console stays", async () => {
    renderDock();
    const logs: Session = { id: "l", kind: "logs", cluster: aks, namespace: "payments", pod: "api-1", container: "app", containers: ["app"] };
    const shell: Session = { ...logs, id: "s", kind: "shell" };
    act(() => dock.dispatch({ type: "open", session: logs }));
    act(() => dock.dispatch({ type: "open", session: shell }));

    expect(await screen.findByText("Couldn't load the terminal. Reload the page.")).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "node shell" })).toBeTruthy();
  });

  it("a node shell fails at the confirm, before any pod is made", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "node shell" }));
    fireEvent.click(screen.getByRole("button", { name: "Start node shell" }));

    const dialog = screen.getByRole("alertdialog");
    expect(await within(dialog).findByText("Couldn't load the terminal. Reload the page.")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("a debug container fails at the confirm, before it's added", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    renderDock();
    const shell: Session = { id: "s", kind: "shell", cluster: aks, namespace: "payments", pod: "api-1", container: "app", containers: ["app"] };
    act(() => dock.askDebug(shell));
    fireEvent.click(screen.getByRole("button", { name: "Start debug container" }));

    expect(await screen.findByText("Couldn't load the terminal. Reload the page.")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});
