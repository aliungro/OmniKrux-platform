// frontend/src/features/territories/components.test.tsx
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ProviderBadge } from "./ProviderBadge";
import { ClusterBand } from "./ClusterBand";
import { ResourceRowView } from "./ResourceRowView";
import { Status } from "./Status";
import { CERTIFICATES, DEPLOYMENTS, EVENTS, HELM, NODES, PODS, SERVICES } from "../../test/kinds";
import { Table } from "../../test/table";

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

describe("cluster band copy", () => {
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
