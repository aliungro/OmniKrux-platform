// frontend/src/features/territories/components.test.tsx
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActionsProvider } from "../actions/ActionDialog";
import { ProviderBadge } from "./ProviderBadge";
import { ClusterBand } from "./ClusterBand";
import { ResourceRowView } from "./ResourceRowView";
import { Status } from "./Status";
import { CERTIFICATES, DEPLOYMENTS, EVENTS, HELM, NODES, PODS, SERVICES } from "../../test/kinds";
import { Cell, gridTemplate, minTableWidth } from "./cells";
import type { MetricsLookup } from "../../api/useMetrics";
import type { ContainerState, Usage } from "../../api/types";
import { Table } from "../../test/table";
import { describeBody } from "../../test/describe";
import rowStyles from "./ResourceRowView.module.css";
import statusStyles from "./Status.module.css";
import bulletStyles from "./ContainerBullets.module.css";
import bandStyles from "./ClusterBand.module.css";
import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { componentCss } from "../../test/css";

const rowCss = componentCss(import.meta.url, "./ResourceRowView.module.css", rowStyles);
const statusCss = componentCss(import.meta.url, "./Status.module.css", statusStyles);
const bulletsCss = componentCss(import.meta.url, "./ContainerBullets.module.css", bulletStyles);
const tokensCss = componentCss(import.meta.url, "../../design/tokens.css", {});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("components", () => {
  it.each([["aks", "AKS"], ["oke", "OKE"], ["kind", "KIND"], ["onprem", "K8S"]])("badge %s", (p, txt) => {
    render(<ProviderBadge provider={p as any} />); expect(screen.getByText(txt)).toBeTruthy();
  });
  it("ClusterBand shows error and retry", () => {
    const onRetry = vi.fn();
    const t = { cluster: { id: "c1", name: "eks-prod", provider: "eks", environment: "production" } as any, state: "error", message: "Can't reach this cluster: timeout", rows: [], total: 0, failing: 0, pending: 0 } as any;
    render(<ClusterBand t={t} kind={PODS} onRetry={onRetry} />);
    expect(screen.getByText("Can't reach this cluster: timeout")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(onRetry).toHaveBeenCalledWith("c1", "error");
  });
  it("virtualizes large tables", () => {
    // R5: jsdom has no layout, so give the scroll container a real size; otherwise nothing renders
    // and "< 200" would pass trivially.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
    const rows = Array.from({ length: 10000 }, (_, i) => ({ uid: String(i), cluster_id: "c1", kind: "Pod", namespace: "n", name: `pod-${i}`, created_at: "", columns: { status: "Running", status_class: "ok" } }));
    const t = { cluster: { id: "c1", name: "big", provider: "gke", environment: "development" } as any, state: "ready", message: null, rows, total: 10000, failing: 0, pending: 0 } as any;
    render(<div style={{ height: 600 }}><Table territories={[t]} kind={PODS} onRetry={() => {}} /></div>);
    const rendered = screen.queryAllByText(/^pod-/).length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(200);
  });
});

const cluster = (over = {}) => ({ id: "c1", name: "aks-prod-weu", context_name: "x", server: "https://weu.azmk8s.io:443", original_server: null, provider: "aks", region: null, environment: "production", state: "ready", message: null, ...over }) as any;
const terr = (over = {}) => ({ cluster: cluster(), state: "ready", message: null, rows: [], total: 0, failing: 0, pending: 0, ...over }) as any;
const pod = (over = {}) => ({ uid: "u1", cluster_id: "c1", kind: "Pod", namespace: "payments", name: "payments-api-1", created_at: null, columns: { status: "CrashLoopBackOff", status_class: "bad", ready: "0/2", restarts: 14, node: null, last_restart_at: null }, ...over }) as any;
const cloud = (over = {}) => cluster({
  ...FILE_CLUSTER_METADATA, name: "eks-prod", source: "cloud", provider: "eks", region: "eu-west-1", server: null,
  cloud: { account_id: "aws-1", account_name: "Production AWS", resource_id: "eks-prod" }, ...over,
});

describe("cluster band copy", () => {
  it.each([
    ["aks", "Azure"], ["eks", "AWS"], ["gke", "Google Cloud"], ["oke", "Oracle Cloud"],
  ])("band shows cloud and region for cloud clusters (%s)", (provider, label) => {
    render(<ClusterBand t={terr({ cluster: cloud({ provider }) })} kind={PODS} onRetry={() => {}} />);
    const location = `${label} · eu-west-1`;
    expect(screen.getByText(location).title).toBe(location);
  });
  it.each(["1.31.3", "v1.31.3"])("band shows kubernetes version (%s)", (version) => {
    render(<ClusterBand t={terr({ cluster: cloud({ kubernetes_version: version }) })} kind={PODS} onRetry={() => {}} />);
    expect(screen.getByText("v1.31.3")).toBeTruthy();
  });
  it("band summarizes node pools with a title", () => {
    const node_pools = [
      { name: "system", count: 3, machine_type: "m7i.large", version: "1.31.3" },
      { name: "jobs", count: 0, machine_type: null, version: null },
      { name: "gpu", count: null, machine_type: "g6.xlarge", version: null },
      { name: "spare", count: null, machine_type: null, version: null },
    ];
    render(<ClusterBand t={terr({ cluster: cloud({ node_pools, node_count: 3 }) })} kind={PODS} onRetry={() => {}} />);
    expect(screen.getByText("4 node pools · 3 nodes").title).toBe(
      "system: 3 × m7i.large (1.31.3)\njobs: 0\ngpu: g6.xlarge\nspare",
    );
  });
  it("unknown node count shows pools only", () => {
    const node_pools = [{ name: "system", count: null, machine_type: null, version: "1.31.3" }];
    render(<ClusterBand t={terr({ cluster: cloud({ node_pools }) })} kind={PODS} onRetry={() => {}} />);
    expect(screen.getByText("1 node pool").title).toBe("system: (1.31.3)");
  });
  it("shows zero cloud node pools when the node count is unknown", () => {
    render(<ClusterBand t={terr({ cluster: cloud({ node_pools: [], node_count: null }) })} kind={PODS} onRetry={() => {}} />);
    expect(screen.getByText("0 node pools")).toBeTruthy();
    expect(screen.queryByText(/0 nodes/)).toBeNull();
  });
  it("node pools the cloud couldn't list read as unknown, never as zero", () => {
    render(<ClusterBand t={terr({ cluster: cloud({ node_pools: null, node_count: null }) })} kind={PODS} onRetry={() => {}} />);
    expect(screen.getByText("node pools unknown").title).toBe("The cloud provider didn't list this cluster's node pools.");
    expect(screen.queryByText(/0 node pools/)).toBeNull();
  });
  it("vanished cluster note shows on the band", () => {
    const note = "Not found in Production AWS any more: it may have been deleted. Remove it from Omnikrux under Settings.";
    const metricsNote = "Metrics server is unavailable";
    render(<ClusterBand t={terr({ cluster: cloud({ cloud_note: note }) })} kind={PODS} metricsNote={metricsNote} onRetry={() => {}} />);
    expect(screen.getByText(note).title).toBe(note);
    expect(screen.getByTestId("band-summary").textContent).toBe("No pods");
    expect(screen.getByTestId("band-metrics").title).toBe(metricsNote);
  });
  it("kubeconfig cluster band unchanged without metadata", () => {
    render(<ClusterBand t={terr({ cluster: cluster({ ...FILE_CLUSTER_METADATA, region: "east" }) })} kind={PODS} onRetry={() => {}} />);
    expect(screen.getByRole("rowheader").textContent).toBe("AKSaks-prod-weueast · weu.azmk8s.ioProductionNo pods");
  });
  it("keeps long name and location in titles and lets them shrink before the summary", () => {
    const name = "production-cluster-".repeat(30);
    const region = "region-".repeat(30);
    const loc = `AWS · ${region}`;
    const css = document.createElement("style");
    css.textContent = componentCss(import.meta.url, "./ClusterBand.module.css", bandStyles);
    document.head.append(css);
    try {
      render(<ClusterBand t={terr({ cluster: cloud({ name, region }) })} kind={PODS} onRetry={() => {}} />);
      for (const text of [name, loc]) {
        const element = screen.getByText(text);
        expect(element.title).toBe(text);
        expect(getComputedStyle(element).minWidth).toBe("0px");
        expect(getComputedStyle(element).textOverflow).toBe("ellipsis");
      }
      expect(getComputedStyle(screen.getByTestId("band-summary")).flexShrink).toBe("0");
    } finally {
      css.remove();
    }
  });
  it.each([
    { label: "error", state: "error", message: "Can't reach the cluster: the connection timed out" },
    { label: "retry", state: "syncing", message: "Retrying — The connection to the cluster timed out" },
    { label: "absent kind", state: "absent", message: "This cluster doesn't serve widgets" },
    { label: "failed discovery", state: "absent", discoveryFailed: "Can't list widgets on this cluster right now: the connection timed out" },
  ])("reserves space for the $label explanation in a narrow band", ({ state, message, discoveryFailed }) => {
    const name = "production-cluster-".repeat(30);
    const region = "region-".repeat(30);
    const css = document.createElement("style");
    css.textContent = componentCss(import.meta.url, "./ClusterBand.module.css", bandStyles);
    document.head.append(css);
    try {
      const node_pools = [{ name: "system", count: 1, machine_type: "m7i.large", version: "1.31.3" }];
      const t = terr({ cluster: cloud({ name, region, kubernetes_version: "1.31.3", node_pools, node_count: 1 }), state, message, discoveryFailed });
      const kind = { ...NODES, key: "widgets.example.dev", plural_label: "widgets", columns: NODES.columns.filter(column => column.key === "name" || column.key === "age") };
      render(<div style={{ width: minTableWidth(kind.columns) - 32 }}><ClusterBand t={t} kind={kind} onRetry={() => {}} /></div>);
      const reason = (discoveryFailed ?? message)!;
      const summary = screen.getByText(reason);
      expect(summary.title).toBe(reason);
      const style = getComputedStyle(summary);
      expect(Number.parseFloat(style.minWidth)).toBeGreaterThan(0);
      expect(style.textOverflow).toBe("ellipsis");
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    } finally {
      css.remove();
    }
  });
  it("shows name, server host, environment and failing count", () => {
    render(<ClusterBand t={terr({ rows: [pod()], total: 48, failing: 1 })} kind={PODS} onRetry={() => {}} />);
    expect(screen.getByText("aks-prod-weu")).toBeTruthy();
    expect(screen.getByText("weu.azmk8s.io")).toBeTruthy();
    expect(screen.getByText("Production")).toBeTruthy();
    expect(screen.getByTestId("band-summary").textContent).toBe("48 pods, 1 failing");
  });
  it("says when the cluster address was rewritten", () => {
    const { rerender } = render(<ClusterBand t={terr({ cluster: cluster({ server: "https://host.docker.internal:6443", original_server: "https://127.0.0.1:6443" }) })} kind={PODS} onRetry={() => {}} />);
    expect(screen.getByText("via host.docker.internal:6443")).toBeTruthy();
    const note = screen.getByTestId("band-rewrite");
    expect(note.textContent).toBe("(kubeconfig: 127.0.0.1:6443)");
    expect(note.getAttribute("title")).toContain("127.0.0.1:6443");
    rerender(<ClusterBand t={terr({ cluster: cluster({ original_server: null }) })} kind={PODS} onRetry={() => {}} />);
    expect(screen.queryByTestId("band-rewrite")).toBeNull();
    expect(screen.getByText("weu.azmk8s.io")).toBeTruthy();
  });
  it("all healthy, development tag", () => {
    render(<ClusterBand t={terr({ cluster: cluster({ environment: "development" }), rows: [pod()], total: 52 })} kind={PODS} onRetry={() => {}} />);
    expect(screen.getByText("Development")).toBeTruthy();
    expect(screen.getByTestId("band-summary").textContent).toBe("52 pods, all healthy");
  });
  it("no tag for unknown environment", () => {
    render(<ClusterBand t={terr({ cluster: cluster({ environment: "unknown" }) })} kind={PODS} onRetry={() => {}} />);
    expect(screen.queryByText("Production")).toBeNull();
    expect(screen.queryByText("Development")).toBeNull();
  });
  it("no pods vs no pods match", () => {
    const { rerender } = render(<ClusterBand t={terr()} kind={PODS} onRetry={() => {}} />);
    expect(screen.getByText("No pods")).toBeTruthy();
    expect(screen.queryByText("No pods match")).toBeNull();
    rerender(<ClusterBand t={terr({ total: 5, failing: 1 })} kind={PODS} onRetry={() => {}} />);
    // R12: replaces the counts rather than sitting beside them
    expect(screen.getByTestId("band-summary").textContent).toBe("No pods match");
    expect(screen.queryByText(/5 pods/)).toBeNull();
  });
  it.each([["syncing"], ["unknown"]])("%s shows Connecting…", (state) => {
    render(<ClusterBand t={terr({ state })} kind={PODS} onRetry={() => {}} />);
    expect(screen.getByText("Connecting…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
  it("syncing after an error keeps the reason and the Retry button", () => {
    const onRetry = vi.fn();
    const message = "Retrying — The cluster rejected the console's credentials: Unauthorized";
    render(<ClusterBand t={terr({ state: "syncing", message })} kind={PODS} onRetry={onRetry} />);
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText("Connecting…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("c1", "syncing");
  });
});

describe("status and pod row", () => {
  it.each([["bad", "diamond"], ["warn", "ring"], ["ok", "dot"], ["done", "dot"]])("%s is a %s", (cls, shape) => {
    const { container } = render(<Status label="X" cls={cls as any} />);
    expect(container.querySelector(`[data-shape="${shape}"]`)).toBeTruthy();
  });
  it("pod row shows unknown age, node, CPU and memory as a dash", () => {
    render(<ResourceRowView row={pod()} kind={PODS} provider="aks" />);
    expect(screen.getByText("payments-api-1")).toBeTruthy();
    expect(screen.getByText("CrashLoopBackOff")).toBeTruthy();
    expect(screen.getByText("0/2")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(4);
  });
});

describe("container status bullets", () => {
  const state = (over: Partial<ContainerState> = {}): ContainerState =>
    ({ name: "web", init: false, state: "ready", reason: null, restarts: 0, ...over });
  const renderPod = (containers: unknown) => render(<ResourceRowView row={pod({ columns: {
    status: "CrashLoopBackOff", status_class: "bad", containers,
  } })} kind={PODS} provider="aks" />);

  it("one bullet per container in order", () => {
    renderPod([state(), state({ name: "sidecar", state: "waiting" }), state({ name: "worker", state: "running" })]);
    const group = screen.getByRole("img", { name: "Containers: 1 ready, 2 not ready" });
    expect(Array.from(group.children).map((el) => el.getAttribute("title"))).toEqual([
      "web: running and ready · 0 restarts", "sidecar: waiting · 0 restarts", "worker: running, not ready · 0 restarts",
    ]);
    expect(Array.from(group.children).map((el) => el.getAttribute("data-shape"))).toEqual(["dot", "dot", "dot"]);
    expect(group.nextElementSibling?.textContent).toBe("CrashLoopBackOff");
    expect(group.closest('[role="gridcell"]')?.querySelectorAll("[data-shape]")).toHaveLength(3);
  });

  it("failing is a rose diamond", () => {
    renderPod([state({ state: "failing", reason: "Error" })]);
    expect(screen.getByTitle("web: failing (Error) · 0 restarts").getAttribute("data-shape")).toBe("diamond");
  });

  it("finished is hollow", () => {
    renderPod([state({ state: "done", reason: "Completed" })]);
    expect(screen.getByTitle("web: finished (Completed)").getAttribute("data-shape")).toBe("ring");
  });

  it.each([
    ["ready", null, 1, "web: running and ready · 1 restart"],
    ["running", null, 2, "web: running, not ready · 2 restarts"],
    ["waiting", "ContainerCreating", 0, "web: waiting (ContainerCreating) · 0 restarts"],
    ["waiting", null, 0, "web: waiting · 0 restarts"],
    ["failing", "CrashLoopBackOff", 3, "web: failing (CrashLoopBackOff) · 3 restarts"],
    ["done", "Completed", 5, "web: finished (Completed)"],
  ] as const)("tooltip names container, state, reason and restarts: %s %s", (value, reason, restarts, title) => {
    renderPod([state({ state: value, reason, restarts })]);
    expect(screen.getByTitle(title)).toBeTruthy();
  });

  it("init containers are labelled init", () => {
    renderPod([state({ name: "setup", init: true })]);
    expect(screen.getByTitle("init setup: running and ready · 0 restarts")).toBeTruthy();
  });

  it("group label counts the states", () => {
    renderPod([state(), state({ state: "waiting" }), state({ state: "running" }), state({ state: "failing" }), state({ state: "done" })]);
    expect(screen.getByRole("img", { name: "Containers: 1 ready, 2 not ready, 1 failing, 1 finished" })).toBeTruthy();
  });

  it("more than six containers collapse into +n", () => {
    renderPod(Array.from({ length: 8 }, (_, i) => state({ name: `web-${i}` })));
    const group = screen.getByRole("img", { name: "Containers: 8 ready" });
    expect(group.querySelectorAll("[data-shape]")).toHaveLength(6);
    expect(screen.getByText("+2").title).toBe("web-6: running and ready · 0 restarts\nweb-7: running and ready · 0 restarts");
  });

  it.each([undefined, null, "ready", {}, [], [null], [{ name: "web", state: "ready" }]])("rows without a containers column show no bullets: %j", (containers) => {
    renderPod(containers);
    expect(screen.queryByRole("img", { name: /^Containers:/ })).toBeNull();
  });

  it("non-pod rows do not show container bullets", () => {
    render(<ResourceRowView row={pod({ kind: "Deployment", columns: { status: "Available", containers: [state()] } })} kind={DEPLOYMENTS} provider="aks" />);
    expect(screen.queryByRole("img", { name: /^Containers:/ })).toBeNull();
  });

  it("status label truncates before the fixed-size container marks in a 36px row", () => {
    const css = document.createElement("style");
    css.textContent = tokensCss + rowCss + statusCss + bulletsCss;
    document.head.append(css);
    try {
      renderPod(Array.from({ length: 7 }, (_, i) => state({ name: `web-${i}` })));
      const label = screen.getByText("CrashLoopBackOff");
      const group = screen.getByRole("img", { name: "Containers: 7 ready" });
      const cell = label.closest('[role="gridcell"]')!;
      expect(getComputedStyle(cell).display).toBe("flex");
      expect(getComputedStyle(cell).alignItems).toBe("center");
      expect(getComputedStyle(label.parentElement!).minWidth).toBe("0px");
      expect(getComputedStyle(label.parentElement!).flexShrink).toBe("1");
      expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
      expect(getComputedStyle(label).overflow).toBe("hidden");
      expect(getComputedStyle(label).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(group).flexShrink).toBe("0");
      expect(getComputedStyle(group).whiteSpace).toBe("nowrap");
      expect(getComputedStyle(group.firstElementChild!).width).toBe("7px");
      expect(getComputedStyle(group.firstElementChild!).height).toBe("7px");
      expect(getComputedStyle(group.closest('[role="row"]')!).height).toBe("36px");
    } finally { css.remove(); }
  });

  it("container shapes use the status palette and a hollow finished ring", () => {
    const css = document.createElement("style");
    css.textContent = tokensCss + rowCss + statusCss + bulletsCss;
    document.head.append(css);
    try {
      renderPod([state(), state({ state: "running" }), state({ state: "waiting" }), state({ state: "failing" }), state({ state: "done" })]);
      const marks = Array.from(screen.getByRole("img").children).map((el) => getComputedStyle(el));
      expect(marks[0].backgroundColor).toBe("rgb(79, 214, 160)");
      expect(marks[1].backgroundColor).toBe("rgb(242, 193, 78)");
      expect(marks[2].backgroundColor).toBe("rgb(242, 193, 78)");
      expect(marks[3].backgroundColor).toBe("rgb(255, 79, 160)");
      expect(marks[3].transform).toBe("rotate(45deg)");
      expect(marks[3].borderRadius).toBe("1px");
      expect(marks[4].backgroundColor).toBe("rgba(0, 0, 0, 0)");
      // CSSOM retains the specified subpixel border; computed used widths round it.
      const ring = screen.getByRole("img").lastElementChild!;
      const ringRule = Array.from(css.sheet!.cssRules).find((rule) =>
        rule instanceof CSSStyleRule && ring.matches(rule.selectorText) && rule.style.getPropertyValue("border")) as CSSStyleRule;
      expect(ringRule.style.getPropertyValue("border")).toBe("1.5px solid var(--ink-3)");
      expect(marks[4].borderStyle).toBe("solid");
      expect(marks[4].borderColor).toBe("rgb(119, 113, 143)");
    } finally { css.remove(); }
  });
});

function layout() {
  // jsdom has no layout; give everything a size so the virtualizer renders rows.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
}

const row = (over: Record<string, unknown> = {}, columns: Record<string, unknown> = {}) =>
  ({ uid: "u1", cluster_id: "c1", kind: "Deployment", namespace: "shop", name: "web", created_at: "2026-11-06T13:00:00Z", labels: {}, columns, ...over }) as any;
const cells = (r: HTMLElement) => Array.from(r.querySelectorAll('[role="gridcell"]')).map((c) => c.textContent);

describe("kinds in the table", () => {
  it("secret column does not take the name column's width", () => {
    expect(gridTemplate(HELM.columns, "release")).toBe("minmax(200px, 2fr) 1fr 70px 1fr 70px 1fr");
    expect(minTableWidth(HELM.columns, "release")).toBe(764);
    layout();
    render(<Table territories={[terr()]} kind={HELM} onRetry={() => {}} />);
    expect(screen.getByRole("grid").style.getPropertyValue("--cols")).toBe("minmax(200px, 2fr) 1fr 70px 1fr 70px 1fr");
    expect(screen.getByRole("grid").style.minWidth).toBe("764px");
  });

  it("pod status keeps room for its label and container bullets", () => {
    expect(gridTemplate(PODS.columns)).toContain("minmax(180px, 1fr)");
    expect(minTableWidth(PODS.columns)).toBe(1162);
  });

  it.each([PODS, NODES])("uses 100 px CPU and 112 px Memory tracks for $key", (kind) => {
    expect(gridTemplate(kind.columns)).toContain("100px 112px");
  });

  it("resizes and resets all Pod data columns without triggering sort or row actions", () => {
    layout();
    const onSort = vi.fn();
    const onOpenLogs = vi.fn();
    const kind = { ...PODS, verbs: [...PODS.verbs, "delete"] };
    render(<QueryClientProvider client={new QueryClient()}><ActionsProvider>
      <Table territories={[terr({ rows: [pod()], total: 1 })]} kind={kind}
        onRetry={() => {}} onSort={onSort} onOpenLogs={onOpenLogs} />
    </ActionsProvider></QueryClientProvider>);
    const grid = screen.getByRole("grid");
    const template = grid.style.getPropertyValue("--cols");
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", { name: "Select payments-api-1" });
    fireEvent.click(checkbox);
    const row = checkbox.closest("[role=row]")!;
    const headerRow = screen.getByRole("columnheader", { name: "Name" }).closest("[role=row]")!;
    expect(row.closest("[role=grid]")).toBe(grid);
    expect(headerRow.closest("[role=grid]")).toBe(grid);
    expect(row.children).toHaveLength(headerRow.children.length);
    const tracks = / (?![^()]*\))/;
    for (const [index, label] of ["Name", "Namespace", "Status", "Ready", "Restarts", "CPU", "Memory", "Node", "Age"].entries()) {
      const handle = within(grid).getByRole("separator", { name: `Resize ${label}` });
      const header = handle.closest("[role=columnheader]")!;
      vi.spyOn(header, "getBoundingClientRect").mockReturnValue({ width: 200 } as DOMRect);
      act(() => handle.focus());
      expect(handle.getAttribute("aria-valuenow")).toBe("200");
      expect(handle.getAttribute("aria-valuemin")).toBe(label === "Memory" ? "80" : "64");
      expect(handle.getAttribute("aria-valuemax")).toBe("800");
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      const resized = grid.style.getPropertyValue("--cols").split(tracks);
      expect(resized[0]).toBe("28px");
      expect(resized[index + 1]).toBe("208px");
      expect(checkbox.checked).toBe(true);
      fireEvent.keyDown(handle, { key: "ArrowDown" });
      fireEvent.keyDown(handle, { key: "l" });
      fireEvent.keyDown(handle, { key: "Enter" });
      expect(grid.style.getPropertyValue("--cols")).toBe(template);
      expect(document.activeElement).toBe(handle);
    }
    expect(onSort).not.toHaveBeenCalled();
    expect(onOpenLogs).not.toHaveBeenCalled();
    expect(grid.querySelector("[data-row-key][aria-selected=true]")).toBeNull();
  });

  it("keeps Details open when Escape cancels a drag and closes it from the idle resize handle", async () => {
    layout();
    const data = describeBody({
      events: [{ type: "Normal", reason: "Scheduled", message: "Assigned to worker", count: 1, last_seen: null }],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(data)));
    render(<QueryClientProvider client={new QueryClient()}>
      <Table territories={[terr({ rows: [pod()], total: 1 })]} kind={PODS} onRetry={() => {}} />
    </QueryClientProvider>);
    const resourceRow = screen.getByRole("grid").querySelector<HTMLElement>("[data-row-key]")!;
    fireEvent.click(resourceRow);
    const handle = await screen.findByRole("separator", { name: "Resize Event" });
    vi.spyOn(handle.closest("th")!, "getBoundingClientRect").mockReturnValue({ width: 120 } as DOMRect);
    const pointer = (type: string, clientX: number) =>
      fireEvent(handle, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), { pointerId: 1 }));
    const pageKeys = vi.fn((event: KeyboardEvent) => event.key);
    document.addEventListener("keydown", pageKeys);
    try {
      pointer("pointerdown", 100);
      expect(handle.getAttribute("data-resizing")).toBe("true");
      fireEvent.keyDown(handle, { key: "Escape" });
      expect(handle.hasAttribute("data-resizing")).toBe(false);
      expect(resourceRow.getAttribute("aria-expanded")).toBe("true");
      expect(pageKeys).not.toHaveBeenCalled();

      pointer("pointerdown", 100);
      pointer("pointerup", 140);
      expect(document.activeElement).toBe(handle);
      fireEvent.keyDown(handle, { key: "Enter" });
      fireEvent.keyDown(handle, { key: "ArrowDown" });
      fireEvent.keyDown(handle, { key: "ArrowLeft", altKey: true });
      fireEvent.keyDown(handle, { key: "k", ctrlKey: true });
      fireEvent.keyDown(handle, { key: "Escape" });
      expect(resourceRow.getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("separator", { name: "Resize Event" })).toBeNull();
      expect(resourceRow.getAttribute("aria-selected")).toBe("true");
      expect(pageKeys.mock.results.map(result => result.value)).toEqual(["ArrowLeft", "k", "Escape"]);
    } finally {
      document.removeEventListener("keydown", pageKeys);
    }
  });

  it("coalesces CRD pointer previews, cancels lost capture and saves only on the captured release", () => {
    layout();
    const props = { territories: [terr()], kind: CERTIFICATES, onRetry: () => {} };
    const { rerender } = render(<Table {...props} menuView="before" />);
    const grid = screen.getByRole("grid");
    const template = grid.style.getPropertyValue("--cols");
    const handle = within(grid).getByRole("separator", { name: "Resize Ready" });
    vi.spyOn(handle.closest("[role=columnheader]")!, "getBoundingClientRect")
      .mockReturnValue({ width: 70 } as DOMRect);
    const save = vi.spyOn(Storage.prototype, "setItem");
    vi.useFakeTimers();
    const pointer = (type: string, pointerId: number, clientX: number) => {
      fireEvent(handle, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), { pointerId }));
    };
    try {
      pointer("pointerdown", 2, 100);
      pointer("pointermove", 2, 140);
      pointer("pointermove", 2, 150);
      pointer("pointerup", 3, 300);
      expect(grid.style.getPropertyValue("--cols")).toBe(template);
      act(() => vi.advanceTimersToNextFrame());
      expect(grid.style.getPropertyValue("--cols")).toBe("minmax(200px, 2fr) 1fr 120px 70px");
      expect(save).not.toHaveBeenCalled();
      pointer("lostpointercapture", 2, 150);
      expect(grid.style.getPropertyValue("--cols")).toBe(template);
      expect(save).not.toHaveBeenCalled();

      pointer("pointerdown", 2, 100);
      pointer("pointermove", 2, 150);
      act(() => vi.advanceTimersToNextFrame());
      fireEvent.keyDown(document.body, { key: "Escape" });
      pointer("pointerup", 2, 150);
      expect(grid.style.getPropertyValue("--cols")).toBe(template);
      expect(save).not.toHaveBeenCalled();

      pointer("pointerdown", 2, 100);
      pointer("pointermove", 2, 150);
      act(() => vi.advanceTimersToNextFrame());
      rerender(<Table {...props} menuView="after" />);
      pointer("pointerup", 2, 150);
      expect(grid.style.getPropertyValue("--cols")).toBe(template);
      expect(save).not.toHaveBeenCalled();

      pointer("pointerdown", 2, 100);
      pointer("pointermove", 2, 135);
      pointer("pointerup", 2, 145);
      act(() => vi.advanceTimersToNextFrame());
      expect(grid.style.getPropertyValue("--cols")).toBe("minmax(200px, 2fr) 1fr 115px 70px");
      expect(save).toHaveBeenCalledTimes(1);
      vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(150);
      fireEvent.doubleClick(handle);
      expect(grid.style.getPropertyValue("--cols")).toBe("minmax(200px, 2fr) 1fr 150px 70px");
      expect(save).toHaveBeenCalledTimes(2);
      fireEvent.keyDown(handle, { key: "Enter" });
      expect(grid.style.getPropertyValue("--cols")).toBe(template);
      expect(save).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Header parts measure 80; each row's cells measure what the table says for that row's key. */
  const stubWidths = (byRow: Record<string, number>) =>
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
      const key = this.closest("[data-row-key]")?.getAttribute("data-row-key") ?? "";
      return byRow[key] ?? 80;
    });

  it("double-click fits a pod column to its content", () => {
    layout();
    render(<Table territories={[terr({ rows: [pod(), pod({ uid: "u2", name: "payments-api-2" })], total: 2 })]} kind={PODS} onRetry={() => {}} />);
    const grid = screen.getByRole("grid");
    const template = grid.style.getPropertyValue("--cols");
    const tracks = / (?![^()]*\))/;
    const handle = within(grid).getByRole("separator", { name: "Resize Namespace" });
    const save = vi.spyOn(Storage.prototype, "setItem");
    stubWidths({ "c1/u1": 150, "c1/u2": 210 });
    fireEvent.doubleClick(handle);
    expect(grid.style.getPropertyValue("--cols").split(tracks)[1]).toBe("210px");
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(grid.style.getPropertyValue("--cols")).toBe(template);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("dragging shows a guide and a width tooltip, then removes them", () => {
    layout();
    render(<Table territories={[terr({ rows: [pod()], total: 1 })]} kind={PODS} onRetry={() => {}} />);
    const handle = within(screen.getByRole("grid")).getByRole("separator", { name: "Resize Namespace" });
    vi.spyOn(handle.closest("[role=columnheader]")!, "getBoundingClientRect")
      .mockReturnValue({ width: 100, top: 10, bottom: 40, right: 300 } as DOMRect);
    const pointer = (type: string, clientX: number) =>
      fireEvent(handle, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), { pointerId: 1 }));
    const overlay = () => [document.body.querySelector("[data-resize-guide]"), document.body.querySelector("[data-resize-tip]")];
    vi.useFakeTimers();
    try {
      pointer("pointerdown", 100);
      pointer("pointermove", 108);
      act(() => vi.advanceTimersToNextFrame());
      const [guide, tip] = overlay();
      expect(guide?.getAttribute("aria-hidden")).toBe("true");
      expect(tip?.textContent).toBe("Namespace · 108 px");
      expect(tip?.getAttribute("aria-hidden")).toBe("true");
      expect((guide as HTMLElement).style.transform).toBe("translateX(307px)");
      pointer("pointerup", 108);
      expect(overlay()).toEqual([null, null]);

      pointer("pointerdown", 100);
      pointer("pointermove", 120);
      act(() => vi.advanceTimersToNextFrame());
      expect(overlay()[0]).not.toBeNull();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(overlay()).toEqual([null, null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the filter icon stays clickable beside the divider", () => {
    layout();
    const onCommit = vi.spyOn(Storage.prototype, "setItem");
    render(<Table territories={[terr({ rows: [pod()], total: 1 })]} kind={PODS} onRetry={() => {}} />);
    const filter = screen.getByRole("button", { name: "Filter by Status" });
    fireEvent.click(filter);
    expect(filter.getAttribute("aria-expanded")).toBe("true");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("narrows a responsive column wider than the cap from its real width without a jump", () => {
    layout();
    render(<Table territories={[terr()]} kind={SERVICES} onRetry={() => {}} />);
    const grid = screen.getByRole("grid");
    const template = grid.style.getPropertyValue("--cols");
    const handle = within(grid).getByRole("separator", { name: "Resize Name" });
    vi.spyOn(handle.closest("[role=columnheader]")!, "getBoundingClientRect")
      .mockReturnValue({ width: 920 } as DOMRect);
    const save = vi.spyOn(Storage.prototype, "setItem");
    const pointer = (type: string, clientX: number) =>
      fireEvent(handle, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), { pointerId: 1 }));

    vi.useFakeTimers();
    try {
      act(() => handle.focus());
      expect(handle.getAttribute("aria-valuenow")).toBe("920");
      expect(handle.getAttribute("aria-valuemax")).toBe("920");

      pointer("pointerdown", 100);
      pointer("pointerup", 100);
      expect(grid.style.getPropertyValue("--cols")).toBe(template);
      expect(save).not.toHaveBeenCalled();

      pointer("pointerdown", 100);
      pointer("pointermove", 99);
      act(() => vi.advanceTimersToNextFrame());
      expect(grid.style.getPropertyValue("--cols")).toMatch(/^919px /);
      pointer("pointermove", 160);
      act(() => vi.advanceTimersToNextFrame());
      expect(grid.style.getPropertyValue("--cols")).toBe(template);
      pointer("pointermove", 60);
      act(() => vi.advanceTimersToNextFrame());
      expect(grid.style.getPropertyValue("--cols")).toMatch(/^880px /);
      expect(save).not.toHaveBeenCalled();
      pointer("pointerup", 55);
      expect(grid.style.getPropertyValue("--cols")).toMatch(/^875px /);
      expect(save).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(handle, { key: "Enter" });
      expect(grid.style.getPropertyValue("--cols")).toBe(template);

      fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(grid.style.getPropertyValue("--cols")).toBe(template);
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
      expect(grid.style.getPropertyValue("--cols")).toMatch(/^912px /);
      fireEvent.keyDown(handle, { key: "Enter" });
      expect(grid.style.getPropertyValue("--cols")).toBe(template);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Home and End on a resize handle set the column to its minimum and maximum width", () => {
    layout();
    render(<Table territories={[terr()]} kind={SERVICES} onRetry={() => {}} />);
    const grid = screen.getByRole("grid");
    const template = grid.style.getPropertyValue("--cols");
    const handle = within(grid).getByRole("separator", { name: "Resize Name" });
    vi.spyOn(handle.closest("[role=columnheader]")!, "getBoundingClientRect")
      .mockReturnValue({ width: 300 } as DOMRect);
    const pageKeys = vi.fn();
    document.addEventListener("keydown", pageKeys);
    try {
      act(() => handle.focus());
      expect(handle.getAttribute("aria-keyshortcuts")).toBe("ArrowLeft ArrowRight Home End Enter");
      expect(fireEvent.keyDown(handle, { key: "Home" })).toBe(false);
      expect(grid.style.getPropertyValue("--cols")).toMatch(/^64px /);
      expect(handle.getAttribute("aria-valuenow")).toBe("64");
      expect(fireEvent.keyDown(handle, { key: "End" })).toBe(false);
      expect(grid.style.getPropertyValue("--cols")).toMatch(/^800px /);
      expect(handle.getAttribute("aria-valuenow")).toBe("800");
      fireEvent.keyDown(handle, { key: "Enter" });
      expect(grid.style.getPropertyValue("--cols")).toBe(template);
      expect(pageKeys).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", pageKeys);
    }
  });

  it("columns follow the kind's column specs", () => {
    layout();
    vi.useFakeTimers({ now: new Date("2026-11-06T16:00:00Z"), toFake: ["Date"] });
    try {
      const dep = row({}, { status: "Available", status_class: "ok", ready: "2/2", up_to_date: 2, available: 0, images: ["nginx:1.27", "busybox"] });
      render(<Table territories={[terr({ rows: [dep], total: 1 })]} kind={DEPLOYMENTS} onRetry={() => {}} />);
      expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(DEPLOYMENTS.columns.map((c) => c.label));
      expect(screen.getByRole("grid").getAttribute("aria-label")).toBe("Deployments by cluster");
      const r = screen.getByText("web").closest<HTMLElement>('[role="row"]')!;
      expect(cells(r)).toEqual(["web", "shop", "Available", "2/2", "2", "0", "nginx:1.27, busybox", "3h"]);
      // Every column lines up with the header through one template from the specs' widths.
      const table = screen.getByRole("grid");
      expect(table.style.getPropertyValue("--cols")).toBe("minmax(200px, 2fr) 1fr 1fr 70px 70px 70px 2fr 70px");
      cleanup();

      const node = row({ kind: "Node", namespace: null, name: "worker" }, { status: "Ready", status_class: "ok", roles: null, version: "v1.31.0", pressure: [], taints: 2, taints_title: "dedicated=infra:NoSchedule\ngpu:NoExecute" });
      render(<Table territories={[terr({ rows: [node], total: 1 })]} kind={NODES} podCounts={new Map([["c1", new Map([["worker", 7]])]])} onRetry={() => {}} />);
      const n = screen.getByText("worker").closest<HTMLElement>('[role="row"]')!;
      expect(cells(n)).toEqual(["worker", "Ready", "—", "v1.31.0", "—", "—", "7", "—", "2", "3h"]);
      expect(screen.getByText("2").closest('[role="gridcell"]')!.getAttribute("title")).toBe("dedicated=infra:NoSchedule\ngpu:NoExecute");
      cleanup();

      const ev = row({ kind: "Event", name: "web.17f" }, { status: "Warning", status_class: "warn", reason: "BackOff", message: "Back-off restarting", count: 5, last_seen: "2026-11-06T15:58:00Z",
        object: { kind_key: "pods", namespace: "shop", name: "web-1", label: "Pod/web-1" } });
      render(<Table territories={[terr({ rows: [ev], total: 1 })]} kind={EVENTS} onRetry={() => {}} />);
      const e = screen.getByText("BackOff").closest<HTMLElement>('[role="row"]')!;
      expect(cells(e)).toEqual(["shop", "Warning", "BackOff", "Pod/web-1", "Back-off restarting", "5", "2m ago"]);
      cleanup();

      // A Helm release row is its revision's Secret: the release comes first, the Secret's name last.
      const helm = row({ kind: "HelmRelease", name: "sh.helm.release.v1.web.v3" }, { release: "web", revision: 3, status: "deployed", status_class: "ok", updated: "2026-11-06T15:00:00Z" });
      render(<Table territories={[terr({ rows: [helm], total: 1 })]} kind={HELM} onRetry={() => {}} />);
      expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Release", "Namespace", "Revision", "Status", "Updated", "Secret"]);
      const h = screen.getByText("deployed").closest<HTMLElement>('[role="row"]')!;
      expect(cells(h)).toEqual(["web", "shop", "3", "deployed", "1h ago", "sh.helm.release.v1.web.v3"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("10000 rows of a generic kind render under 200 DOM rows", () => {
    layout();
    const rows = Array.from({ length: 10000 }, (_, i) => row({ uid: String(i), name: `cert-${i}` }, { pc_ready: "True", status: "True", status_class: "ok" }));
    render(<div style={{ height: 600 }}><Table territories={[terr({ rows, total: 10000 })]} kind={CERTIFICATES} onRetry={() => {}} /></div>);
    const rendered = screen.getAllByRole("row").length;
    expect(screen.getByText("cert-0")).toBeTruthy();
    expect(rendered).toBeGreaterThan(1);
    expect(rendered).toBeLessThan(200);
  });
});

describe("band copy per kind", () => {
  it("absent band says the cluster doesn't serve the kind", () => {
    const onRetry = vi.fn();
    const message = "This cluster doesn't serve certificates.cert-manager.io.";
    render(<ClusterBand t={terr({ state: "absent", message })} kind={CERTIFICATES} onRetry={onRetry} />);
    const line = screen.getByText(message);
    expect(line.getAttribute("data-testid")).toBe("band-absent");
    expect(screen.queryByText("Connecting…")).toBeNull();
    expect(screen.queryByTestId("band-summary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("c1", "absent");
  });
  it("uses the kind's plural label", () => {
    const sum = () => screen.getByTestId("band-summary").textContent;
    const { rerender } = render(<ClusterBand t={terr()} kind={DEPLOYMENTS} onRetry={() => {}} />);
    expect(sum()).toBe("No deployments");
    rerender(<ClusterBand t={terr({ total: 3 })} kind={HELM} onRetry={() => {}} />);
    expect(sum()).toBe("No Helm releases match");
    rerender(<ClusterBand t={terr({ rows: [row()], total: 3, failing: 1 })} kind={DEPLOYMENTS} onRetry={() => {}} />);
    expect(sum()).toBe("3 deployments, 1 failing");
    rerender(<ClusterBand t={terr({ rows: [row()], total: 1 })} kind={HELM} onRetry={() => {}} />);
    expect(sum()).toBe("1 Helm release, all healthy");
    // No status column: nothing to call healthy.
    rerender(<ClusterBand t={terr({ rows: [row()], total: 4 })} kind={SERVICES} onRetry={() => {}} />);
    expect(sum()).toBe("4 services");
    rerender(<ClusterBand t={terr({ rows: [row()], total: 9 })} kind={EVENTS} onRetry={() => {}} />);
    expect(sum()).toBe("9 events");
  });
});

describe("band for a failed API group", () => {
  it("shows the discovery failure with Retry, not that the kind is missing", () => {
    const onRetry = vi.fn();
    const failed = "Can't list certificates on this cluster right now: The cert-manager.io API didn't answer (503); its kinds are hidden until it does.";
    render(<ClusterBand t={terr({ state: "absent", message: "This cluster doesn't serve certificates.cert-manager.io.", discoveryFailed: failed })} kind={CERTIFICATES} onRetry={onRetry} />);
    expect(screen.getByTestId("band-unlisted").textContent).toBe(failed);
    expect(screen.queryByText("This cluster doesn't serve certificates.cert-manager.io.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("c1", "absent");
  });
});

describe("cpu and memory cells", () => {
  const MIB = 1024 ** 2;
  const usage = (over: Partial<Usage> = {}): Usage => ({ cpu_m: 110, memory_b: 301 * MIB, at: "2026-11-07T14:00:00Z", window_s: 15, stale: false, ...over });
  const limits = { cpu_limit_m: 500, cpu_request_m: 100, memory_limit_b: 256 * MIB, memory_request_b: 128 * MIB };
  const cols = { cpu: PODS.columns.find((c) => c.key === "cpu")!, memory: PODS.columns.find((c) => c.key === "memory")! };
  const renderCell = (key: "cpu" | "memory", live: { usage: Usage | null; why: string | null } | null, columns: Record<string, unknown> = limits) =>
    render(<Cell col={cols[key]} row={pod({ columns })} now={new Date("2026-11-07T14:10:00Z")} live={live} nowMs={Date.parse("2026-11-07T14:10:00Z")} />);

  it("cpu and memory cells show usage against limit", () => {
    const { container } = renderCell("cpu", { usage: usage(), why: null });
    expect(screen.getByText("110m")).toBeTruthy();
    expect(container.querySelector("i")?.getAttribute("style")).toContain("--v: 22%");
    cleanup();
    renderCell("memory", { usage: usage(), why: null });
    const value = screen.getByText("301 / 256 Mi");
    expect(value.getAttribute("title")).toBe("301 / 256 Mi\n118% of its limit (256 Mi)\nMeasured over 15 s");
    expect(value.parentElement!.className).toMatch(/compact/);
  });

  it("a pod without a limit measures against its request, and without either has no bar", () => {
    const { container } = renderCell("cpu", { usage: usage(), why: null }, { cpu_limit_m: null, cpu_request_m: 220 });
    expect(container.querySelector("i")?.getAttribute("style")).toContain("--v: 50%");
    expect(screen.queryByLabelText("near its limit")).toBeNull();
    cleanup();
    const bare = renderCell("memory", { usage: usage(), why: null }, { memory_limit_b: null, memory_request_b: 0 });
    expect(screen.getByText("301 Mi")).toBeTruthy();
    expect(bare.container.querySelector("i")).toBeNull();
  });

  it("over 90 percent of limit is hot", () => {
    renderCell("memory", { usage: usage(), why: null });
    expect(screen.getByLabelText("near its limit")).toBeTruthy();
    cleanup();
    renderCell("memory", { usage: usage({ memory_b: 200 * MIB }), why: null });
    expect(screen.queryByLabelText("near its limit")).toBeNull();
  });

  it("a node is measured against what it can allocate", () => {
    render(
      <Cell
        col={NODES.columns.find((c) => c.key === "cpu")!}
        row={pod({ kind: "Node", columns: { allocatable_cpu_m: 1000 } })}
        now={new Date()}
        live={{ usage: usage({ cpu_m: 950 }), why: null }}
      />,
    );
    expect(screen.getByLabelText("near its limit")).toBeTruthy();
  });

  it("a cell without live numbers is a dash that carries the reason", () => {
    renderCell("cpu", { usage: null, why: "Metrics are out of date, so they're hidden: x" });
    expect(screen.getByText("—").getAttribute("title")).toBe("Metrics are out of date, so they're hidden: x");
  });

  it("stale item dimmed with measured-ago title", () => {
    renderCell("cpu", { usage: usage({ stale: true, at: "2026-11-07T14:07:00Z" }), why: null });
    const meter = screen.getByText("110m").parentElement!;
    expect(meter.getAttribute("title")).toBe("22% of its limit (500m)\nMeasured 3m ago; metrics-server has nothing newer.");
    expect(meter.className).toMatch(/stale/);
    cleanup();
    renderCell("cpu", { usage: usage(), why: null });
    expect(screen.getByText("110m").parentElement!.className).not.toMatch(/stale/);
  });

  it("unavailable cluster shows band message not empty cells", () => {
    const message = "Metrics not available on this cluster: metrics-server isn't installed.";
    // jsdom has no layout: give the scroll container a size or the virtualizer renders nothing.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
    const metrics: MetricsLookup = {
      usage: () => ({ usage: null, why: message }),
      why: () => message,
      nodeSize: () => null,
      now: Date.now(),
    };
    render(<Table territories={[terr({ rows: [pod()], total: 1 })]} kind={PODS} onRetry={() => {}} metrics={metrics} />);
    expect(screen.getByTestId("band-metrics").textContent).toBe(message);
    // The cells' dashes are explained, not silently empty.
    expect(screen.getAllByText("—").some((n) => n.getAttribute("title") === message)).toBe(true);
  });

  it("the band says nothing when metrics are fine", () => {
    render(<ClusterBand t={terr()} kind={PODS} onRetry={() => {}} metricsNote={null} />);
    expect(screen.queryByTestId("band-metrics")).toBeNull();
  });
});


describe("usage basis in rows", () => {
  const MIB = 1024 ** 2;
  const cpu = PODS.columns.find(c => c.type === "cpu")!;
  const memory = PODS.columns.find(c => c.type === "memory")!;
  const usage: Usage = { cpu_m: 900, memory_b: 512 * MIB, at: "2026-11-07T14:00:00Z", window_s: 15, stale: false };
  const size = { cpu_m: 1000, memory_b: 1024 * MIB };

  it("every pod row with metrics shows a bar using its live node size", () => {
    const metrics: MetricsLookup = {
      usage: () => ({ usage: { ...usage, cpu_m: 0 }, why: null }), why: () => null,
      nodeSize: (clusterId, node) => clusterId === "c1" && node === "worker" ? size : null,
      now: Date.now(),
    };
    const { container } = render(<ResourceRowView row={pod({ columns: { node: "worker" } })} kind={PODS} provider="aks" metrics={metrics} />);
    const bars = container.querySelectorAll("i");
    expect(bars).toHaveLength(2);
    expect(bars[0].getAttribute("style")).toContain("--v: 0%");
    expect(bars[1].getAttribute("style")).toContain("--v: 50%");
  });

  it.each([
    ["Pod", { cpu_limit_m: 1000, cpu_request_m: 500 }, "90% of its limit (1000m)", true],
    ["Pod", { cpu_limit_m: 0, cpu_request_m: 1000 }, "90% of its request (1000m); no limit set", false],
    ["Pod", { cpu_limit_m: 0, cpu_request_m: 0 }, "90% of node worker (1000m allocatable); no request or limit set", true],
    ["Node", { allocatable_cpu_m: 1000, cpu_limit_m: 500 }, "90% of what the node can allocate (1000m)", true],
  ])("tooltip names the basis and hot applies only against limit or node: %s %j", (kind, columns, title, hot) => {
    const { container } = render(<Cell col={cpu} row={pod({ kind, columns: { ...columns, node: "worker" } })} now={new Date()} live={{ usage, why: null }} nodeSize={size} />);
    const bar = container.querySelector("i")!;
    expect(bar.getAttribute("style")).toContain("--v: 90%");
    expect(bar.parentElement!.title).toBe(`${title}\nMeasured over 15 s`);
    expect(screen.queryByLabelText("near its limit") !== null).toBe(hot);
  });

  it("node memory measures against allocatable and formats the amount", () => {
    const { container } = render(<Cell col={memory} row={pod({ kind: "Node", columns: { allocatable_memory_b: 1024 * MIB } })} now={new Date()} live={{ usage, why: null }} />);
    expect(container.querySelector("i")?.getAttribute("style")).toContain("--v: 50%");
    expect(container.querySelector("i")?.parentElement!.title).toBe("50% of what the node can allocate (1 Gi)\nMeasured over 15 s");
  });

  it("unknown node size shows text with the reason and no bar", () => {
    const { container } = render(<Cell col={cpu} row={pod({ columns: {} })} now={new Date()} live={{ usage, why: null }} />);
    expect(container.querySelector("i")).toBeNull();
    expect(screen.getByText("900m").parentElement!.title).toBe("No limit, request or node size to compare with.\nMeasured over 15 s");
  });

  it.each([null, { usage: null, why: "Metrics-server is unavailable." }])("no metrics shows a dash, never an empty bar", live => {
    const { container } = render(<Cell col={cpu} row={pod()} now={new Date()} live={live} nodeSize={size} />);
    expect(container.querySelector("i")).toBeNull();
    expect(screen.getByText("\u2014").getAttribute("title")).toBe(live?.why ?? null);
  });
});

it("header sorts asc, desc, then default", () => {
  const onSort = vi.fn(); const props = { territories:[terr()], kind:PODS, onRetry:()=>{}, onSort };
  const {rerender} = render(<Table {...props} />);
  fireEvent.click(screen.getByTitle("Sort by Name")); expect(onSort).toHaveBeenLastCalledWith({key:"name",dir:"asc"});
  rerender(<Table {...props} sort={{key:"name",dir:"asc"}} />);
  fireEvent.click(screen.getByTitle("Sort by Name")); expect(onSort).toHaveBeenLastCalledWith({key:"name",dir:"desc"});
  rerender(<Table {...props} sort={{key:"name",dir:"desc"}} />);
  fireEvent.click(screen.getByTitle("Sort by Name")); expect(onSort).toHaveBeenLastCalledWith(null);
});

it("pods filter by node from a pick-list", () => {
  const onFilter = vi.fn(); const source = [terr({ rows:[pod({columns:{node:"worker-1"}})] })];
  render(<Table territories={source} pickSource={source} kind={PODS} onRetry={()=>{}} onColumnFilter={onFilter} />);
  fireEvent.click(screen.getByRole("button",{name:"Filter by Node"}));
  fireEvent.click(screen.getByLabelText(/worker-1/)); fireEvent.click(screen.getByRole("button",{name:"Apply"}));
  expect(onFilter).toHaveBeenCalledWith("node",{key:"node",op:"oneOf",values:["worker-1"]});
});
it("restarts min filter", () => {
  const onFilter = vi.fn(); render(<Table territories={[terr()]} kind={PODS} onRetry={()=>{}} onColumnFilter={onFilter} />);
  fireEvent.click(screen.getByRole("button",{name:"Filter by Restarts"}));
  fireEvent.change(screen.getByLabelText("Min"),{target:{value:"2"}}); fireEvent.click(screen.getByRole("button",{name:"Apply"}));
  expect(onFilter).toHaveBeenCalledWith("restarts",{key:"restarts",op:"between",min:2,max:null});
});
it("events filter by last seen within 1 h", () => {
  const onFilter = vi.fn(); render(<Table territories={[terr()]} kind={EVENTS} onRetry={()=>{}} onColumnFilter={onFilter} />);
  fireEvent.click(screen.getByRole("button",{name:"Filter by Last seen"}));
  fireEvent.click(screen.getByRole("button",{name:"Apply"}));
  expect(onFilter).toHaveBeenCalledWith("last_seen",{key:"last_seen",op:"within",seconds:3600});
});

it("limits a large pick list and lets search reach any value", () => {
  const source = [terr({rows:Array.from({length:1000},(_,i)=>pod({uid:String(i),columns:{node:`node-${i}`}}))})];
  render(<Table territories={source} pickSource={source} kind={PODS} onRetry={()=>{}} />);
  fireEvent.click(screen.getByRole("button",{name:"Filter by Node"}));
  expect(screen.getAllByRole("checkbox").length).toBeLessThanOrEqual(100);
  fireEvent.change(screen.getByPlaceholderText("Find a value"),{target:{value:"node-999"}});
  expect(screen.getByLabelText(/node-999/)).toBeTruthy();
});
