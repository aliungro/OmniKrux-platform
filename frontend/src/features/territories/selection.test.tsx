import { FILE_CLUSTER_METADATA } from "../../test/clusters";
// frontend/src/features/territories/selection.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Plan, PlanRequest, ResourceRow } from "../../api/types";
import type { Territory } from "./model";
import type { TerritoryTableProps } from "./TerritoryTable";
import { resourceDescribe, secretDescribe } from "../../test/describe";
import { DEPLOYMENTS, NODES, PODS, SERVICES } from "../../test/kinds";
import { Table } from "../../test/table";
import { ActionsProvider } from "../actions/ActionDialog";

vi.mock("../actions/lazyCodeMirror", () => ({
  loadCodeMirror: async () => ({
    editor: () => ({ focus: () => {}, destroy: () => {} }),
  }),
}));

const describeBody = {
  pod: {
    name: "pod-0", namespace: "n", status: "Running", status_class: "ok", node: "node-a", pod_ip: null, host_ip: null,
    qos: null, service_account: null, owner: null, started_at: null, resource_version: "1",
  },
  containers: [], init_containers: [], ephemeral_containers: [], volumes: [], conditions: [], labels: {}, annotations: {},
  events: [], events_error: null,
};

beforeEach(() => {
  // R5: jsdom has no layout; give everything a size so the virtualizer renders rows.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  vi.stubGlobal("fetch", vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify(describeBody), { status: 200, headers: { "Content-Type": "application/json" } }))));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const rows = (n: number): ResourceRow[] =>
  Array.from({ length: n }, (_, i) => ({
    uid: String(i), cluster_id: "c1", kind: "Pod", namespace: "n", name: `pod-${i}`, created_at: null, labels: {},
    columns: { status: "Running", status_class: "ok", resource_version: "1" },
  }));

const territory = (rs: ResourceRow[], state: Territory["state"] = "ready"): Territory => ({
  cluster: { id: "c1", name: "big", context_name: "x", server: "https://x", ...FILE_CLUSTER_METADATA, original_server: null, provider: "gke",
    region: null, environment: "development", state: "ready", message: null },
  state, message: null, rows: rs, total: rs.length, failing: 0, pending: 0,
});

function renderTable(n: number, props: Partial<TerritoryTableProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div style={{ height: 600 }}>
        <Table territories={[territory(rows(n))]} kind={PODS} onRetry={() => {}} {...props} />
      </div>
    </QueryClientProvider>,
  );
}

const podRow = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;
const inspector = () => screen.queryByRole("region", { name: /^Details for/ });

describe("selection", () => {
  it("up from the page selects and focuses the last row when no row is selected", () => {
    renderTable(3);
    fireEvent.keyDown(document.body, { key: "ArrowUp" });
    expect(podRow("pod-2").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(podRow("pod-2"));
  });

  it("page escape closes details, and unrelated keys keep their default", () => {
    renderTable(3);
    fireEvent.click(podRow("pod-1"));
    podRow("pod-1").blur();
    expect(fireEvent.keyDown(document.body, { key: "q" })).toBe(true);
    expect(inspector()).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(inspector()).toBeNull();
  });

  it("enter opens inspector under the row and escape closes it", () => {
    renderTable(5);
    const r = podRow("pod-1");
    r.focus();
    fireEvent.keyDown(r, { key: "Enter" });
    const insp = inspector();
    expect(insp).toBeTruthy();
    expect(insp!.getAttribute("aria-label")).toBe("Details for pod-1");
    expect(r.getAttribute("aria-expanded")).toBe("true");
    // Directly under its row: the next row in the grid holds the inspector, then pod-2.
    const all = screen.getAllByRole("row");
    const at = all.indexOf(r);
    expect(all[at + 1].contains(insp)).toBe(true);
    expect(all[at + 2]).toBe(podRow("pod-2"));

    fireEvent.keyDown(insp!, { key: "Escape" });
    expect(inspector()).toBeNull();
    expect(document.activeElement).toBe(podRow("pod-1"));
  });

  it("d and click toggle the inspector too", () => {
    renderTable(5);
    fireEvent.keyDown(podRow("pod-0"), { key: "d" });
    expect(inspector()).toBeTruthy();
    fireEvent.keyDown(podRow("pod-0"), { key: "d" });
    expect(inspector()).toBeNull();
    fireEvent.click(screen.getByText("pod-3"));
    expect(inspector()!.getAttribute("aria-label")).toBe("Details for pod-3");
    fireEvent.click(screen.getByText("pod-3"));
    expect(inspector()).toBeNull();
  });

  it("arrow keys move selection", () => {
    renderTable(5);
    const first = podRow("pod-0");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(podRow("pod-1").getAttribute("aria-selected")).toBe("true");
    expect(podRow("pod-0").getAttribute("aria-selected")).toBe("false");
    expect(document.activeElement).toBe(podRow("pod-1"));
    fireEvent.keyDown(podRow("pod-1"), { key: "ArrowDown" });
    fireEvent.keyDown(podRow("pod-2"), { key: "ArrowUp" });
    expect(podRow("pod-1").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(podRow("pod-1"));
    // The first row stays put on ArrowUp.
    fireEvent.keyDown(podRow("pod-1"), { key: "ArrowUp" });
    fireEvent.keyDown(podRow("pod-0"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(podRow("pod-0"));
  });

  it("arrow keys with the inspector open keep the selected row in view", async () => {
    // A viewport shorter than the inspector, so scrolling to the inspector would hide the row.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
    // jsdom has no scroll height, which would clamp every scroll to 0.
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(5000);
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true });
    try {
      renderTable(5);
      fireEvent.keyDown(podRow("pod-0"), { key: "Enter" });
      fireEvent.keyDown(podRow("pod-0"), { key: "ArrowDown" });
      // The virtualizer settles a scroll over the next few animation frames.
      await act(() => new Promise((done) => setTimeout(done, 100)));

      const r = podRow("pod-1");
      expect(r.getAttribute("aria-selected")).toBe("true");
      expect(r.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(r);
      // The inspector moved with the selection: row, its inspector, then the next row.
      const all = screen.getAllByRole("row");
      const at = all.indexOf(r);
      expect(all[at + 1].contains(inspector())).toBe(true);
      expect(inspector()!.getAttribute("aria-label")).toBe("Details for pod-1");
      expect(all[at + 2]).toBe(podRow("pod-2"));
      // pod-1's top is 52 (band) + 36 (pod-0) = 88px into the body; any scroll must leave it below the header.
      for (const [opts] of scrollTo.mock.calls) expect(opts.top).toBeLessThanOrEqual(88);
    } finally {
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("closes the inspector when its row goes away", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (n: number) => (
      <QueryClientProvider client={client}>
        <Table territories={[territory(rows(n))]} kind={PODS} onRetry={() => {}} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(3));
    fireEvent.keyDown(podRow("pod-2"), { key: "Enter" });
    expect(inspector()).toBeTruthy();
    rerender(ui(2));
    expect(inspector()).toBeNull();
    // It stays closed when the pod comes back.
    rerender(ui(3));
    expect(inspector()).toBeNull();
  });

  it("l, p and s on the selected row open logs, previous logs and shell", () => {
    const onOpenLogs = vi.fn();
    const onOpenShell = vi.fn();
    renderTable(3, { onOpenLogs, onOpenShell });
    const second = podRow("pod-2");
    second.focus();
    fireEvent.keyDown(second, { key: "l" });
    fireEvent.keyDown(second, { key: "l", repeat: true });
    const first = podRow("pod-1");
    first.focus();
    fireEvent.keyDown(first, { key: "p" });
    fireEvent.keyDown(first, { key: "p", repeat: true });
    fireEvent.keyDown(podRow("pod-2"), { key: "s" });
    expect(onOpenLogs).toHaveBeenNthCalledWith(1, expect.objectContaining({ uid: "2" }), false, second);
    expect(onOpenLogs).toHaveBeenNthCalledWith(2, expect.objectContaining({ uid: "1" }), true, first);
    expect(onOpenLogs).toHaveBeenCalledTimes(2);
    expect(onOpenShell).toHaveBeenCalledWith(expect.objectContaining({ uid: "2" }));
  });

  it("virtualizer keeps working with an open inspector at 10000 rows", () => {
    renderTable(10000);
    fireEvent.keyDown(podRow("pod-0"), { key: "Enter" });
    expect(inspector()).toBeTruthy();
    const rendered = screen.queryAllByText(/^pod-\d+$/).length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
  });

  it("inspector survives a reconnect of its cluster", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui = (t: Territory) => (
      <QueryClientProvider client={client}>
        <Table territories={[t]} kind={PODS} onRetry={() => {}} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(territory(rows(3))));
    fireEvent.keyDown(podRow("pod-1"), { key: "Enter" });
    expect(inspector()!.getAttribute("aria-label")).toBe("Details for pod-1");
    // The cluster reconnects: its rows are hidden until they're live again, the inspector with them.
    rerender(ui(territory([], "syncing")));
    expect(inspector()).toBeNull();
    rerender(ui(territory([], "error")));
    expect(inspector()).toBeNull();
    // Back, with the pod still there: the inspector reopens under it.
    rerender(ui(territory(rows(3))));
    expect(inspector()!.getAttribute("aria-label")).toBe("Details for pod-1");
    expect(podRow("pod-1").getAttribute("aria-selected")).toBe("true");
    // Ready and gone: now it closes, and stays closed.
    rerender(ui(territory(rows(1))));
    expect(inspector()).toBeNull();
    rerender(ui(territory(rows(3))));
    expect(inspector()).toBeNull();
  });

  it("every kind opens details; logs and shells stay with pods", () => {
    const onOpenLogs = vi.fn();
    const onOpenShell = vi.fn();
    const deps = rows(3).map((r) => ({ ...r, kind: "Deployment", name: r.name.replace("pod", "web") }));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Table territories={[territory(deps)]} kind={DEPLOYMENTS} onRetry={() => {}} onOpenLogs={onOpenLogs} onOpenShell={onOpenShell} />
      </QueryClientProvider>,
    );
    const r = podRow("web-1");
    for (const key of ["l", "p", "s"]) fireEvent.keyDown(r, { key });
    expect(onOpenLogs).not.toHaveBeenCalled();
    expect(onOpenShell).not.toHaveBeenCalled();
    fireEvent.keyDown(r, { key: "Enter" });
    expect(inspector()).toBeTruthy();
    expect(r.getAttribute("aria-selected")).toBe("true");
    expect(r.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(r, { key: "Escape" });
    expect(inspector()).toBeNull();
    fireEvent.keyDown(r, { key: "ArrowDown" });
    expect(podRow("web-2").getAttribute("aria-selected")).toBe("true");
  });
});

describe("keys per kind", () => {
  const VERBS = ["get", "list", "watch", "update", "patch", "delete"];
  const asKind = (kind: string, name: string) => rows(2).map((r, i) => ({ ...r, kind, name: `${name}-${i}`, columns: { ...r.columns, ready: "2/3" } }));
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));

  function renderKind(kind: typeof PODS, rs: ResourceRow[], props: Partial<TerritoryTableProps> = {}) {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ActionsProvider>
          <div style={{ height: 600 }}>
            <Table territories={[territory(rs)]} kind={{ ...kind, verbs: VERBS }} onRetry={() => {}} {...props} />
          </div>
        </ActionsProvider>
      </QueryClientProvider>,
    );
  }

  it("reviews exact selected UIDs and reports partial results without retrying successful deletes", async () => {
    const plans: PlanRequest[] = [];
    const applies: Array<{ id: string; confirm_text?: string }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/actions/plan") {
        const req = JSON.parse(String(init?.body)) as PlanRequest;
        plans.push(req);
        const { name } = req.target;
        return json({
          plan_id: name, action: "delete", target: req.target, kind: "Pod",
          cluster: { id: "c1", name: "big", provider: "gke", environment: "production" },
          title: `Delete Pod ${name}`, summary: [`Delete Pod n/${name} on big.`, "A replacement pod will start."],
          warnings: [], blocked: [], diff: null, confirm_text: name, apply_label: "Delete", expires_at: "",
        } satisfies Plan);
      }
      const match = url.match(/^\/api\/actions\/([^/]+)\/apply$/);
      if (match) {
        applies.push({ id: match[1], ...JSON.parse(String(init?.body)) });
        if (match[1] === "pod-1") {
          return Promise.resolve(new Response(JSON.stringify({ detail: "Pod pod-1 changed since review." }),
            { status: 409, headers: { "Content-Type": "application/json" } }));
        }
        return json({ outcome: "succeeded", message: "Deleted Pod n/pod-0.", job_id: null, audit_id: 1 });
      }
      return json(describeBody);
    }));
    renderKind(PODS, rows(3));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-0" }));
    fireEvent.keyDown(podRow("pod-1"), { key: " " });
    expect(inspector()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    const dialog = within(screen.getByRole("dialog", { name: "Delete 2 resources" }));
    const first = await dialog.findByRole("textbox", { name: "Type pod-0 to confirm" });
    const second = dialog.getByRole("textbox", { name: "Type pod-1 to confirm" });
    const confirm = dialog.getByRole<HTMLButtonElement>("button", { name: "Delete 2 resources" });
    expect(plans.map(req => [req.target.name, req.params?.expected_uid])).toEqual([["pod-0", "0"], ["pod-1", "1"]]);
    expect(applies).toHaveLength(0);
    fireEvent.change(first, { target: { value: "pod-0" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(second, { target: { value: "pod-1" } });
    fireEvent.click(confirm);
    expect(await dialog.findByText("1 of 2 deleted.")).toBeTruthy();
    expect(dialog.getByText("Pod pod-1 changed since review.")).toBeTruthy();
    expect(applies).toEqual([{ id: "pod-0", confirm_text: "pod-0" }, { id: "pod-1", confirm_text: "pod-1" }]);
    fireEvent.click(dialog.getByRole("button", { name: "Close" }));
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Select pod-0" }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Select pod-1" }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Select pod-2" }).checked).toBe(false);
  });

  it("cancelling a bulk review closes its open reviews on the server", async () => {
    const discarded: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/actions/plan") {
        const req = JSON.parse(String(init?.body)) as PlanRequest;
        const { name } = req.target;
        return json({
          plan_id: `plan-${name}`, action: "delete", target: req.target, kind: "Pod",
          cluster: { id: "c1", name: "big", provider: "gke", environment: "development" },
          title: `Delete Pod ${name}`, summary: [], warnings: [], blocked: [], diff: null, confirm_text: null,
          apply_label: "Delete", expires_at: "",
        } satisfies Plan);
      }
      if (init?.method === "DELETE") {
        discarded.push(url);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return json(describeBody);
    }));
    renderKind(PODS, rows(2));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-0" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    const dialog = within(screen.getByRole("dialog", { name: "Delete 2 resources" }));
    await dialog.findByText("big / n / Pod pod-1");
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(discarded.sort()).toEqual(["/api/actions/plan-pod-0", "/api/actions/plan-pod-1"]));
  });

  it("opens a menu for the pointed pod and sends Logs only to that pod", () => {
    const onOpenLogs = vi.fn();
    const onOpenSplit = vi.fn();
    renderKind(PODS, rows(2), { onOpenLogs, onOpenSplit });
    fireEvent.click(podRow("pod-0"));
    fireEvent.contextMenu(screen.getByText("pod-1"));

    const menu = screen.getByRole("menu", { name: "Actions for pod-1" });
    expect(podRow("pod-0").getAttribute("aria-selected")).toBe("true");
    expect(podRow("pod-1").getAttribute("aria-selected")).toBe("false");
    expect(inspector()?.getAttribute("aria-label")).toBe("Details for pod-0");
    expect(within(menu).queryByRole("menuitem", { name: "Edit pinned kinds…" })).toBeNull();
    expect(onOpenLogs).not.toHaveBeenCalled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Logs" }));
    expect(onOpenLogs).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uid: "1" }), false);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.contextMenu(podRow("pod-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in new split tab" }));
    expect(onOpenSplit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uid: "1" }));
  });

  it("opens Edit for the pointed pod without submitting a write", async () => {
    const fetch = vi.fn((url: string, _init?: RequestInit) => json(url.includes("/yaml") ? { yaml: "kind: Pod" } : describeBody));
    vi.stubGlobal("fetch", fetch);
    renderKind(PODS, rows(2));
    fireEvent.click(podRow("pod-0"));
    fireEvent.contextMenu(podRow("pod-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const details = await screen.findByRole("region", { name: "Details for pod-1" });
    expect(await within(details).findByRole("button", { name: "Review changes" })).toBeTruthy();
    expect(fetch.mock.calls.map(([url]) => url).filter((url) => url.includes("/yaml"))).toEqual([
      expect.stringContaining("/pods/n/pod-1/yaml"),
    ]);
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it.each([
    [SERVICES, "service", ["Details", "YAML", "Edit", "Port-forward", "Delete"]],
    [DEPLOYMENTS, "web", ["Details", "YAML", "Logs", "Edit", "Scale", "Restart", "Roll back", "Delete"]],
    [{ ...SERVICES, key: "helm-releases", kind: "HelmRelease" }, "helm", ["Details", "YAML"]],
  ] as const)("offers the actions supported by $kind", (kind, name, labels) => {
    renderKind(kind, asKind(kind.kind, name), { onWorkloadLogs: vi.fn(), onOpenShell: vi.fn() });
    fireEvent.contextMenu(podRow(`${name}-1`));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(labels);
    expect(inspector()).toBeNull();
  });

  it("uses the pointed cluster's verbs when another cluster offers writes", () => {
    const second = rows(1).map((r) => ({ ...r, cluster_id: "c2", name: "other-pod" }));
    const a = territory(rows(1));
    const b = { ...territory(second), cluster: { ...a.cluster, id: "c2" } };
    renderKind(PODS, [], {
      kind: { ...PODS, verbs: VERBS, verbs_by_cluster: { c1: VERBS, c2: ["get", "list", "watch"] } },
      territories: [a, b],
    });
    fireEvent.contextMenu(podRow("pod-0"));
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    fireEvent.contextMenu(podRow("other-pod"));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu", { name: "Actions for other-pod" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("gives Shift+F10 and Escape to the focused row's menu", () => {
    renderKind(PODS, rows(2));
    fireEvent.click(podRow("pod-0"));
    const trigger = podRow("pod-1");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
    const firstItem = screen.getByRole("menuitem", { name: "Details" });
    expect(document.activeElement).toBe(firstItem);
    fireEvent.keyDown(firstItem, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(inspector()?.getAttribute("aria-label")).toBe("Details for pod-0");
  });

  it.each(["removed", "replaced", "scrolled", "view changed", "pane inactive"] as const)("closes the menu with surviving focus when its row is %s", (change) => {
    const client = new QueryClient();
    const onOpenLogs = vi.fn();
    const originalRows = rows(3);
    const originalView = {};
    const ui = (rs: ResourceRow[], menuView = originalView, paneActive = true) => (
      <QueryClientProvider client={client}>
        <Table territories={[territory(rs)]} kind={PODS} onRetry={() => {}} onOpenLogs={onOpenLogs} menuView={menuView} paneActive={paneActive} />
      </QueryClientProvider>
    );
    const { rerender } = render(ui(originalRows));
    const trigger = podRow("pod-1");
    fireEvent.contextMenu(trigger);
    const logs = screen.getByRole("menuitem", { name: "Logs" });
    if (change === "scrolled") {
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ ...trigger.getBoundingClientRect(), bottom: 20 });
      fireEvent.scroll(screen.getByRole("grid").parentElement!);
    } else if (change === "view changed") {
      rerender(ui(originalRows, {}));
    } else if (change === "pane inactive") {
      rerender(ui(originalRows, originalView, false));
    } else {
      rerender(ui(change === "replaced"
        ? originalRows.map((row) => row.uid === "1" ? { ...row, uid: "replacement" } : row)
        : originalRows.filter((row) => row.uid !== "1")));
    }
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(logs);
    expect(onOpenLogs).not.toHaveBeenCalled();
    expect(inspector()).toBeNull();
    if (change !== "pane inactive") expect(document.activeElement).toBe(change === "view changed" ? trigger : podRow("pod-0"));
  });

  it("same key acts per kind", async () => {
    const onOpenShell = vi.fn();
    const onNodeShell = vi.fn();
    const pods = renderKind(PODS, rows(2), { onOpenShell });
    fireEvent.keyDown(podRow("pod-1"), { key: "s" });
    expect(onOpenShell).toHaveBeenCalledWith(expect.objectContaining({ uid: "1" }));
    expect(screen.queryByLabelText("Replicas")).toBeNull();
    pods.unmount();

    vi.stubGlobal("fetch", vi.fn(() => json(resourceDescribe())));
    const deps = renderKind(DEPLOYMENTS, asKind("Deployment", "web"), { onOpenShell });
    fireEvent.keyDown(podRow("web-1"), { key: "s" });
    expect(((await screen.findByLabelText("Replicas")) as HTMLInputElement).value).toBe("3");
    expect(onOpenShell).toHaveBeenCalledTimes(1);
    deps.unmount();

    const nodes = renderKind(NODES, asKind("Node", "node").map((r) => ({ ...r, namespace: null })), { onOpenShell, onNodeShell });
    fireEvent.keyDown(podRow("node-0"), { key: "s" });
    await waitFor(() => expect(onNodeShell).toHaveBeenCalledWith(expect.objectContaining({ name: "node-0" }), "node-0"));
    expect(onOpenShell).toHaveBeenCalledTimes(1);
    nodes.unmount();
  });

  it("ctrl d opens delete review", async () => {
    const plan = {
      plan_id: "p1", action: "delete", target: { cluster_id: "c1", kind_key: "pods", namespace: "n", name: "pod-1" }, kind: "Pod",
      cluster: { id: "c1", name: "big", provider: "gke", environment: "development" }, title: "Delete Pod pod-1",
      summary: ["Delete Pod n/pod-1."], warnings: [], blocked: [], diff: null, confirm_text: null, apply_label: "Delete",
      expires_at: "2026-11-08T10:05:00Z",
    };
    const fetch = vi.fn((_url: string, init?: RequestInit) => json(init?.method === "POST" ? plan : describeBody));
    vi.stubGlobal("fetch", fetch);
    renderKind(PODS, rows(2));
    const event = new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      podRow("pod-1").dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true); // not the browser's bookmark
    expect(await screen.findByRole("dialog", { name: "Delete Pod pod-1" })).toBeTruthy();
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts.map(([url]) => url)).toEqual(["/api/actions/plan"]);
    expect(JSON.parse(posts[0][1]!.body as string)).toMatchObject({ action: "delete", target: { name: "pod-1", kind_key: "pods" } });
  });

  it("y opens the details on the YAML tab", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => json(url.endsWith("/yaml") || url.includes("/yaml?") ? { yaml: "kind: Deployment" } : resourceDescribe())));
    renderKind(DEPLOYMENTS, asKind("Deployment", "web"));
    fireEvent.keyDown(podRow("web-0"), { key: "y" });
    expect(inspector()!.getAttribute("aria-label")).toBe("Details for web-0");
    await waitFor(() => expect(screen.getByRole("tab", { name: "YAML" }).getAttribute("aria-selected")).toBe("true"));
  });

  it("l on a workload opens the logs of all its pods", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(resourceDescribe({ pod_selector: "app=web" }))));
    const onWorkloadLogs = vi.fn();
    const onOpenLogs = vi.fn();
    renderKind(DEPLOYMENTS, asKind("Deployment", "web"), { onWorkloadLogs, onOpenLogs });
    fireEvent.keyDown(podRow("web-1"), { key: "l" });
    await waitFor(() => expect(onWorkloadLogs).toHaveBeenCalledWith(expect.objectContaining({ name: "web-1" }), "app=web", { focus: true }));
    expect(onOpenLogs).not.toHaveBeenCalled();
  });

  it("a workload that selects its pods with expressions says why its logs can't open", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json(resourceDescribe({ pod_selector: null }))));
    const onWorkloadLogs = vi.fn();
    renderKind(DEPLOYMENTS, asKind("Deployment", "web"), { onWorkloadLogs });
    fireEvent.keyDown(podRow("web-1"), { key: "l" });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Deployment web-1 picks its pods with expressions, so their logs can't be opened together. Open one of its pods' logs instead.",
    );
    expect(onWorkloadLogs).not.toHaveBeenCalled();
  });

  it("x on a secret row opens Describe on its first key; x again reveals that key", async () => {
    const SECRETS = { ...SERVICES, key: "secrets", kind: "Secret", plural: "secrets", label: "Secret", plural_label: "secrets" };
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ key: "password", value: "hunter2", encoding: "utf-8" });
      return json(url.includes("/yaml") ? { yaml: "kind: Secret" } : secretDescribe({ name: "db-0", namespace: "n" }));
    });
    vi.stubGlobal("fetch", fetch);
    renderKind(SECRETS, asKind("Secret", "db"));
    const row = podRow("db-0");
    row.focus();
    // Whatever tab was showing, x goes to Describe, where the keys are.
    fireEvent.keyDown(row, { key: "y" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "YAML" }).getAttribute("aria-selected")).toBe("true"));
    row.focus();
    fireEvent.keyDown(row, { key: "x" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("secret-key-password")));
    expect(screen.getByRole("tab", { name: "Describe" }).getAttribute("aria-selected")).toBe("true");
    // Nothing revealed yet: that's the next x, on the focused key, through the audited reveal.
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.keyDown(document.activeElement!, { key: "x" });
    expect(await screen.findByText("hunter2")).toBeTruthy();
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts.map(([url]) => url)).toEqual(["/api/clusters/c1/secrets/n/db-0/reveal"]);
    expect(JSON.parse(posts[0][1]!.body as string)).toEqual({ key: "password" });
  });

  it("holding x on a secret row never reveals: key repeats are ignored on the row and on the key", async () => {
    const SECRETS = { ...SERVICES, key: "secrets", kind: "Secret", plural: "secrets", label: "Secret", plural_label: "secrets" };
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json({ key: "password", value: "hunter2", encoding: "utf-8" });
      return json(url.includes("/yaml") ? { yaml: "kind: Secret" } : secretDescribe({ name: "db-0", namespace: "n" }));
    });
    vi.stubGlobal("fetch", fetch);
    renderKind(SECRETS, asKind("Secret", "db"));
    const row = podRow("db-0");
    row.focus();
    fireEvent.keyDown(row, { key: "x" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("secret-key-password")));
    // The held key keeps repeating, wherever focus is now.
    fireEvent.keyDown(document.activeElement!, { key: "x", repeat: true });
    fireEvent.keyDown(row, { key: "x", repeat: true });
    fireEvent.keyDown(document.activeElement!, { key: "x", repeat: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(screen.queryByText("hunter2")).toBeNull();
  });
});
