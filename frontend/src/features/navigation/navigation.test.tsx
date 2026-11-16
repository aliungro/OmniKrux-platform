import { FILE_CLUSTER_METADATA } from "../../test/clusters";
// frontend/src/features/navigation/navigation.test.tsx — links that jump to the object they name.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Cluster, ResourceRow } from "../../api/types";
import { applyMessage, emptyWatchState, type WatchState } from "../../api/watchState";
import { Shell as Console } from "../../features/shell/Shell";
import { seedPodsWorkspace } from "../../test/seedWorkspace";
import { describeBody, container, resourceDescribe, secretDescribe } from "../../test/describe";
import { KINDS } from "../../test/kinds";
import { NO_FILTER, NO_SELECTION, type Filters, type Selection } from "../territories/model";
import { missingCopy, useNavigator } from "./navigation";

vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

/** What the watch of each kind holds; a kind not listed has heard nothing yet. */
const watches = vi.hoisted(() => ({ byKind: {} as Record<string, WatchState> }));
vi.mock("../../api/useWatch", async () => {
  const { emptyWatchState: empty } = await import("../../api/watchState");
  const none = empty();
  return { useWatch: (kind: string | null) => (kind !== null ? (watches.byKind[kind] ?? none) : none) };
});

const cluster: Cluster = {
  id: "c1", name: "kind-omnikrux-dev", context_name: "kind-omnikrux-dev", server: "https://127.0.0.1:6443",
  ...FILE_CLUSTER_METADATA, original_server: null, provider: "kind", region: null, environment: "development", state: "ready", message: null,
};

const row = (uid: string, kind: string, namespace: string | null, name: string, columns: Record<string, unknown> = {}): ResourceRow =>
  ({ uid, cluster_id: "c1", kind, namespace, name, created_at: null, labels: {}, columns });

/** A ready cluster whose snapshot holds `rows`. */
function ready(rows: ResourceRow[]): WatchState {
  const w = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "ready", message: null });
  return applyMessage(w, { type: "snapshot", cluster_id: "c1", part: 0, last: true, rows });
}

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const POD = row("p1", "Pod", "payments", "payments-api-1", { columns: [], sort: null, status: "CrashLoopBackOff", status_class: "bad", resource_version: "1" });
const OTHER_POD = row("p0", "Pod", "payments", "aaa-first", { columns: [], sort: null, status: "Running", status_class: "ok", resource_version: "1" });
const RS = row("rs1", "ReplicaSet", "payments", "payments-api-7f9c4", { ready: "0/1" });
const SECRET = row("s1", "Secret", "payments", "payments-db", { type: "Opaque", keys: 2 });

const replicaset = resourceDescribe({
  kind_key: "replicasets.apps", kind: "ReplicaSet", name: "payments-api-7f9c4", namespace: "payments",
  fields: [{ label: "Replicas", value: "1 desired, 0 current, 0 ready", link: null }],
});

/** The console's server: kinds, clusters, the pod's describe (with an env var read from a Secret) and the others'. */
function server() {
  const env = [{ name: "DB_PASSWORD", value: null, source: "Secret payments-db key password",
    link: { kind_key: "secrets", namespace: "payments", name: "payments-db" } }];
  return vi.fn((url: string) => {
    if (url.startsWith("/api/kinds")) return json(KINDS);
    if (url === "/api/clusters") return json([cluster]);
    if (url.endsWith("/pods/payments/payments-api-1/describe")) return json(describeBody({ containers: [container({ env })] }));
    if (url.includes("/resources/replicasets.apps/payments-api-7f9c4/describe")) return json(replicaset);
    if (url.includes("/resources/secrets/payments-db/describe")) return json(secretDescribe());
    if (url.startsWith("/api/metrics/")) return json({ kind: "pods", clusters: {} });
    return json({ detail: `unexpected ${url}` }, 404);
  });
}

function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><Console /></QueryClientProvider>);
}

const rowOf = (name: string) => screen.getByText(name, { selector: '[role="gridcell"]' }).closest<HTMLElement>('[role="row"]')!;

/** Opens the pod's details and waits for its describe. */
async function openPod() {
  renderConsole();
  fireEvent.click(await screen.findByText("payments-api-1", { selector: '[role="gridcell"]' }));
  return screen.findByRole("region", { name: "Details for payments-api-1" });
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
  watches.byKind = {
    pods: ready([OTHER_POD, POD]),
    "replicasets.apps": ready([RS]),
    secrets: ready([SECRET]),
  };
  vi.stubGlobal("fetch", server());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("links in the console", () => {
  it("owner link navigates to the replicaset and opens it", async () => {
    const details = await openPod();
    fireEvent.click(await within(details).findByRole("button", { name: "ReplicaSet payments-api-7f9c4" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/kubernetes\//));
    const opened = await screen.findByRole("region", { name: "Details for payments-api-7f9c4" });
    expect(await within(opened).findByText("1 desired, 0 current, 0 ready")).toBeTruthy();
    const r = rowOf("payments-api-7f9c4");
    expect(r.getAttribute("aria-selected")).toBe("true");
    expect(r.getAttribute("aria-expanded")).toBe("true");
    // Back returns to the pods.
    window.history.back();
    await waitFor(() => expect(within(screen.getByRole("tablist", { name: "Kinds" })).getByRole("tab", { selected: true }).textContent).toContain("Pods"));
  });

  it("env secret link navigates to the secret", async () => {
    const details = await openPod();
    fireEvent.click(await within(details).findByRole("button", { name: "Secret payments-db key password" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/kubernetes\//));
    const opened = await screen.findByRole("region", { name: "Details for payments-db" });
    expect(await within(opened).findByTestId("secret-key-password")).toBeTruthy();
    expect(rowOf("payments-db").getAttribute("aria-selected")).toBe("true");
  });

  it("link to a missing object says it isn't there", async () => {
    watches.byKind.secrets = ready([]);
    const details = await openPod();
    fireEvent.click(await within(details).findByRole("button", { name: "Secret payments-db key password" }));
    const note = await screen.findByText("Secret payments/payments-db isn't on kind-omnikrux-dev any more.");
    expect(note.closest('[role="status"]')).toBeTruthy();
    // Nothing is selected or opened in its place.
    expect(screen.queryByRole("region", { name: /^Details for/ })).toBeNull();
  });

  it("changing a filter drops a jump still waiting for its row", async () => {
    watches.byKind.secrets = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "syncing", message: null });
    const details = await openPod();
    fireEvent.click(await within(details).findByRole("button", { name: "Secret payments-db key password" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/kubernetes\//));
    const filter = screen.getByPlaceholderText("Filter by name, label or image");
    fireEvent.change(filter, { target: { value: "x" } });
    // The Secret arrives; the next render sees it, but the jump was dropped.
    watches.byKind.secrets = ready([SECRET]);
    fireEvent.change(filter, { target: { value: "" } });
    expect(await screen.findByText("payments-db", { selector: '[role="gridcell"]' })).toBeTruthy();
    expect(rowOf("payments-db").getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByRole("region", { name: "Details for payments-db" })).toBeNull();
  });

  it("filters that would hide the target are cleared", async () => {
    renderConsole();
    const filter = await screen.findByPlaceholderText("Filter by name, label or image");
    fireEvent.change(filter, { target: { value: "payments-api-1" } });
    fireEvent.click(await screen.findByText("payments-api-1", { selector: '[role="gridcell"]' }));
    const details = await screen.findByRole("region", { name: "Details for payments-api-1" });
    fireEvent.click(await within(details).findByRole("button", { name: "ReplicaSet payments-api-7f9c4" }));
    expect(await screen.findByRole("region", { name: "Details for payments-api-7f9c4" })).toBeTruthy();
    expect((screen.getByPlaceholderText("Filter by name, label or image") as HTMLInputElement).value).toBe("");
  });

  it("an object cell in the table jumps to its object", async () => {
    window.location.hash = "#kind=events";
    const object = { kind_key: "pods", namespace: "payments", name: "payments-api-1", label: "Pod/payments-api-1" };
    watches.byKind.events = ready([row("e1", "Event", "payments", "payments-api-1.17", { columns: [], sort: null, status: "Warning", status_class: "warn", object, reason: "BackOff" })]);
    renderConsole();
    fireEvent.click(await screen.findByRole("button", { name: "Pod/payments-api-1" }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/kubernetes\//));
    expect(await screen.findByRole("region", { name: "Details for payments-api-1" })).toBeTruthy();
  });
});

describe("useNavigator", () => {
  function harness(watch: WatchState, kindKey = "secrets") {
    const setFilters = vi.fn<(f: Filters | ((f: Filters) => Filters)) => void>();
    const setSelection = vi.fn<(s: Selection | ((s: Selection) => Selection)) => void>();
    const onKind = vi.fn<(key: string) => void>();
    const hook = renderHook((p: { watch: WatchState }) =>
      useNavigator({ kindKey, watch: p.watch, clusters: [cluster], kinds: KINDS.kinds, onKind, setFilters, setSelection }),
      { initialProps: { watch } });
    return { hook, setFilters, setSelection, onKind };
  }

  it("the missing copy drops the namespace for a cluster-scoped object", () => {
    expect(missingCopy("Node", null, "worker", "kind-omnikrux-dev")).toBe("Node worker isn't on kind-omnikrux-dev any more.");
    expect(missingCopy("Secret", "payments", "db", "kind-omnikrux-dev")).toBe("Secret payments/db isn't on kind-omnikrux-dev any more.");
  });

  it("the missing line goes after 6 s", () => {
    vi.useFakeTimers();
    const { hook, setSelection } = harness(ready([]));
    act(() => hook.result.current.goTo({ clusterId: "c1", kind_key: "secrets", namespace: "payments", name: "gone" }));
    expect(hook.result.current.notice).toBe("Secret payments/gone isn't on kind-omnikrux-dev any more.");
    act(() => { vi.advanceTimersByTime(5_900); });
    expect(hook.result.current.notice).not.toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(hook.result.current.notice).toBeNull();
    expect(setSelection).not.toHaveBeenCalled();
  });

  it("a found row is selected and opened, filters that hide it are cleared, and it is revealed", () => {
    const { hook, setFilters, setSelection, onKind } = harness(ready([SECRET]));
    const before = hook.result.current.reveal;
    act(() => hook.result.current.goTo({ clusterId: "c1", kind_key: "secrets", namespace: "payments", name: "payments-db" }));
    expect(onKind).not.toHaveBeenCalled(); // already there
    const sel = setSelection.mock.calls.at(-1)![0];
    expect(typeof sel === "function" ? sel(NO_SELECTION) : sel).toEqual({ selected: { clusterId: "c1", uid: "s1" }, open: true });
    const next = setFilters.mock.calls.at(-1)![0];
    const filters: Filters = { columns: [], sort: null, status: "failing", text: "zzz", namespace: "kube-system" };
    expect(typeof next === "function" ? next(filters) : next).toEqual(NO_FILTER);
    // A filter that already shows it is kept.
    const keep: Filters = { columns: [], sort: null, status: "all", text: "payments", namespace: "payments" };
    expect(typeof next === "function" ? next(keep) : next).toEqual(keep);
    expect(hook.result.current.reveal).toBe(before + 1);
  });

  it("a link keeps column filters that show the target and drops those that hide it", () => {
    const { hook, setFilters } = harness(ready([SECRET]));
    act(() => hook.result.current.goTo({ clusterId: "c1", kind_key: "secrets", namespace: "payments", name: "payments-db" }));
    const next = setFilters.mock.calls.at(-1)![0];
    const f: Filters = { ...NO_FILTER, columns: [{key:"name",op:"contains",text:"payments"}, {key:"age",op:"within",seconds:0}] };
    const result = typeof next === "function" ? next(f) : next;
    expect(result.columns).toEqual([f.columns[0]]);
  });

  it("asks for the link's kind, then waits for it", () => {
    const { hook, onKind, setSelection } = harness(ready([POD]), "pods");
    act(() => hook.result.current.goTo({ clusterId: "c1", kind_key: "secrets", namespace: "payments", name: "payments-db" }));
    expect(onKind).toHaveBeenCalledWith("secrets");
    // Still on pods: a pod row by that name is not the Secret.
    hook.rerender({ watch: ready([row("x", "Pod", "payments", "payments-db")]) });
    expect(setSelection).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toBeNull();
  });

  it("a kind the cluster doesn't serve says so", () => {
    const absent = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "absent", message: "This cluster doesn't serve secrets." });
    const { hook } = harness(absent);
    act(() => hook.result.current.goTo({ clusterId: "c1", kind_key: "secrets", namespace: "payments", name: "payments-db" }));
    expect(hook.result.current.notice).toBe("This cluster doesn't serve secrets.");
  });

  it("a jump waits 6 s at most, saying what it waits for", () => {
    vi.useFakeTimers();
    const syncing = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "syncing", message: null });
    const { hook, setSelection } = harness(syncing);
    act(() => hook.result.current.goTo({ clusterId: "c1", kind_key: "secrets", namespace: "payments", name: "payments-db" }));
    act(() => { vi.advanceTimersByTime(400); });
    expect(hook.result.current.notice).toBe("Waiting for kind-omnikrux-dev…");
    expect(hook.result.current.waiting).toBe(true);
    act(() => { vi.advanceTimersByTime(5_700); });
    expect(hook.result.current.notice).toBe("Secret payments/payments-db wasn't opened: kind-omnikrux-dev isn't ready. Try the link again once it is.");
    expect(hook.result.current.waiting).toBe(false);
    hook.rerender({ watch: ready([SECRET]) });
    expect(setSelection).not.toHaveBeenCalled();
  });

  it("a cluster that reports an error ends the wait", () => {
    const syncing = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "syncing", message: null });
    const { hook, setSelection } = harness(syncing);
    act(() => hook.result.current.goTo({ clusterId: "c1", kind_key: "secrets", namespace: "payments", name: "payments-db" }));
    hook.rerender({ watch: applyMessage(syncing, { type: "cluster_status", cluster_id: "c1", state: "error", message: "Can't reach this cluster: timeout" }) });
    expect(hook.result.current.notice).toBe("Secret payments/payments-db wasn't opened: kind-omnikrux-dev isn't ready. Try the link again once it is.");
    hook.rerender({ watch: ready([SECRET]) });
    expect(setSelection).not.toHaveBeenCalled();
  });

  it("a row found quickly shows no waiting note", () => {
    vi.useFakeTimers();
    const { hook } = harness(ready([SECRET]));
    act(() => hook.result.current.goTo({ clusterId: "c1", kind_key: "secrets", namespace: "payments", name: "payments-db" }));
    act(() => { vi.advanceTimersByTime(7_000); });
    expect(hook.result.current.notice).toBeNull();
  });

  it("waits for the cluster's rows before deciding", () => {
    const syncing = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "syncing", message: null });
    const { hook, setSelection } = harness(syncing);
    act(() => hook.result.current.goTo({ clusterId: "c1", kind_key: "secrets", namespace: "payments", name: "payments-db" }));
    expect(hook.result.current.notice).toBeNull();
    // The cluster says ready before its snapshot lands: still no verdict.
    hook.rerender({ watch: applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "ready", message: null }) });
    expect(hook.result.current.notice).toBeNull();
    expect(setSelection).not.toHaveBeenCalled();
    hook.rerender({ watch: ready([SECRET]) });
    expect(setSelection).toHaveBeenCalledTimes(1);
  });

  it("selecting something else meanwhile drops the jump", () => {
    const syncing = applyMessage(emptyWatchState(), { type: "cluster_status", cluster_id: "c1", state: "syncing", message: null });
    const { hook, setSelection } = harness(syncing);
    act(() => hook.result.current.goTo({ clusterId: "c1", kind_key: "secrets", namespace: "payments", name: "payments-db" }));
    act(() => hook.result.current.cancel());
    hook.rerender({ watch: ready([SECRET]) });
    expect(setSelection).not.toHaveBeenCalled();
  });
});

it("revealed values stay out of storage and are dropped on tab switch", async () => {
  const base = server();
  vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/reveal")
    ? json({ key: "password", value: "never-store-this-value", encoding: "utf-8" })
    : base(url)));
  const details = await openPod();
  fireEvent.click(await within(details).findByRole("button", { name: "Secret payments-db key password" }));
  const key = await screen.findByTestId("secret-key-password");
  fireEvent.click(within(key).getByRole("button", { name: "Reveal" }));
  await screen.findByText("never-store-this-value");
  expect(JSON.stringify(localStorage)).not.toContain("never-store-this-value");
  expect(location.hash).not.toContain("never-store-this-value");
  expect(JSON.stringify(history.state)).not.toContain("never-store-this-value");
  fireEvent.click(screen.getByRole("button", { name: "New tab" }));
  const tabs = screen.getByRole("tablist", { name: "Kubernetes tabs" });
  fireEvent.click(within(tabs).getAllByRole("tab")[0]);
  const restored = await screen.findByTestId("secret-key-password");
  expect(within(restored).getByRole("button", { name: "Reveal" })).toBeTruthy();
  expect(screen.queryByText("never-store-this-value")).toBeNull();
});
