// frontend/src/features/territories/components.test.tsx
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ProviderBadge } from "./ProviderBadge";
import { ClusterBand } from "./ClusterBand";
import { PodRow } from "./PodRow";
import { Status } from "./Status";
import { TerritoryTable } from "./TerritoryTable";

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
    render(<ClusterBand t={t} onRetry={onRetry} />);
    expect(screen.getByText("Can't reach this cluster: timeout")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(onRetry).toHaveBeenCalledWith("c1");
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
    render(<div style={{ height: 600 }}><TerritoryTable territories={[t]} onRetry={() => {}} /></div>);
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
    render(<ClusterBand t={terr({ rows: [pod()], total: 48, failing: 1 })} onRetry={() => {}} />);
    expect(screen.getByText("aks-prod-weu")).toBeTruthy();
    expect(screen.getByText("weu.azmk8s.io")).toBeTruthy();
    expect(screen.getByText("Production")).toBeTruthy();
    expect(screen.getByTestId("band-summary").textContent).toBe("48 pods, 1 failing");
  });
  it("says when the cluster address was rewritten", () => {
    const { rerender } = render(<ClusterBand t={terr({ cluster: cluster({ server: "https://host.docker.internal:6443", original_server: "https://127.0.0.1:6443" }) })} onRetry={() => {}} />);
    expect(screen.getByText("via host.docker.internal:6443")).toBeTruthy();
    const note = screen.getByTestId("band-rewrite");
    expect(note.textContent).toBe("(kubeconfig: 127.0.0.1:6443)");
    expect(note.getAttribute("title")).toContain("127.0.0.1:6443");
    rerender(<ClusterBand t={terr({ cluster: cluster({ original_server: null }) })} onRetry={() => {}} />);
    expect(screen.queryByTestId("band-rewrite")).toBeNull();
    expect(screen.getByText("weu.azmk8s.io")).toBeTruthy();
  });
  it("all healthy, development tag", () => {
    render(<ClusterBand t={terr({ cluster: cluster({ environment: "development" }), rows: [pod()], total: 52 })} onRetry={() => {}} />);
    expect(screen.getByText("Development")).toBeTruthy();
    expect(screen.getByTestId("band-summary").textContent).toBe("52 pods, all healthy");
  });
  it("no tag for unknown environment", () => {
    render(<ClusterBand t={terr({ cluster: cluster({ environment: "unknown" }) })} onRetry={() => {}} />);
    expect(screen.queryByText("Production")).toBeNull();
    expect(screen.queryByText("Development")).toBeNull();
  });
  it("no pods vs no pods match", () => {
    const { rerender } = render(<ClusterBand t={terr()} onRetry={() => {}} />);
    expect(screen.getByText("No pods")).toBeTruthy();
    expect(screen.queryByText("No pods match")).toBeNull();
    rerender(<ClusterBand t={terr({ total: 5, failing: 1 })} onRetry={() => {}} />);
    // R12: replaces the counts rather than sitting beside them
    expect(screen.getByTestId("band-summary").textContent).toBe("No pods match");
    expect(screen.queryByText(/5 pods/)).toBeNull();
  });
  it.each([["syncing"], ["unknown"]])("%s shows Connecting…", (state) => {
    render(<ClusterBand t={terr({ state })} onRetry={() => {}} />);
    expect(screen.getByText("Connecting…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
  it("syncing after an error keeps the reason and the Retry button", () => {
    const onRetry = vi.fn();
    const message = "Retrying — The cluster rejected the console's credentials: Unauthorized";
    render(<ClusterBand t={terr({ state: "syncing", message })} onRetry={onRetry} />);
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText("Connecting…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("c1");
  });
});

describe("status and pod row", () => {
  it.each([["bad", "diamond"], ["warn", "ring"], ["ok", "dot"], ["done", "dot"]])("%s is a %s", (cls, shape) => {
    const { container } = render(<Status label="X" cls={cls as any} />);
    expect(container.querySelector(`[data-shape="${shape}"]`)).toBeTruthy();
  });
  it("pod row shows unknown age and node as a dash", () => {
    render(<PodRow row={pod()} provider="aks" />);
    expect(screen.getByText("payments-api-1")).toBeTruthy();
    expect(screen.getByText("CrashLoopBackOff")).toBeTruthy();
    expect(screen.getByText("0/2")).toBeTruthy();
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});
