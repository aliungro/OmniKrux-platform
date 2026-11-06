// frontend/src/App.test.tsx
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { applyMessage, emptyWatchState, type WatchState } from "./api/watchState";
import type { WatchOptions } from "./api/useWatch";
import { Console } from "./App";

const watch = vi.hoisted(() => ({ state: null as WatchState | null, opts: undefined as WatchOptions | undefined }));
vi.mock("./api/useWatch", () => ({
  useWatch: (_kind: string, opts?: WatchOptions) => {
    watch.opts = opts;
    return watch.state;
  },
}));

const cluster = { id: "c1", name: "kind-omnikrux-dev", context_name: "kind-omnikrux-dev", server: "https://127.0.0.1:6443", original_server: null, provider: "kind", region: null, environment: "development", state: "ready", message: null };
const pod = (uid: string, status: string, cls: string) => ({ uid, cluster_id: "c1", kind: "Pod", namespace: "default", name: uid, created_at: null, columns: { status, status_class: cls, node: "n1", last_restart_at: null } });

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
}

beforeEach(() => {
  watch.state = emptyWatchState();
  watch.opts = undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Console page states", () => {
  it("says it is loading clusters", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderConsole();
    expect(screen.getByText("Loading clusters…")).toBeTruthy();
  });
  it("shows the load error and tries again", async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => json({ detail: "database is locked" }, 500))
      .mockImplementation(() => json([cluster]));
    vi.stubGlobal("fetch", fetch);
    renderConsole();
    expect(await screen.findByText("Can't load clusters: database is locked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("scope-token")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("explains how to add clusters when there are none", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json([])));
    renderConsole();
    expect(await screen.findByText("No clusters yet. Mount your kubeconfig at /kube/config and restart the console.")).toBeTruthy();
  });
});

describe("Console wiring", () => {
  it("feeds live watch state into scope tokens, the pods tab and filter counts", async () => {
    let w = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
    w = applyMessage(w, { type: "snapshot", cluster_id: "c1", part: 0, last: true,
      rows: [pod("a", "Running", "ok"), pod("b", "CrashLoopBackOff", "bad"), pod("c", "Pending", "warn")] });
    watch.state = w;
    vi.stubGlobal("fetch", vi.fn(() => json([cluster])));
    renderConsole();
    const token = await screen.findByTestId("scope-token");
    expect(token.textContent).toBe("KINDkind-omnikrux-dev1 failing");
    expect(screen.getByRole("tab").textContent).toBe("Pods3");
    expect(screen.getByRole("button", { name: "Failing 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pending 1" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Pods by cluster" })).toBeTruthy();
  });
  it("scope token uses the watch state over the cluster list", async () => {
    watch.state = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "error", message: "Can't reach this cluster: timeout" });
    vi.stubGlobal("fetch", vi.fn(() => json([cluster])));
    renderConsole();
    const token = await screen.findByTestId("scope-token");
    await waitFor(() => expect(token.getAttribute("title")).toBe("Can't reach this cluster: timeout"));
  });
});

describe("Console follows cluster changes", () => {
  it("passes the known cluster ids and reloads the list for an unknown or removed cluster", async () => {
    const fetch = vi.fn(() => json([cluster]));
    vi.stubGlobal("fetch", fetch);
    renderConsole();
    await screen.findByTestId("scope-token");
    await waitFor(() => expect(watch.opts?.knownClusterIds).toEqual(new Set(["c1"])));
    expect(fetch).toHaveBeenCalledTimes(1);
    watch.opts?.onUnknownCluster?.("c2");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    watch.opts?.onClusterRemoved?.("c1");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });
});
