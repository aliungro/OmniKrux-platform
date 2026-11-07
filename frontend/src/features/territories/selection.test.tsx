// frontend/src/features/territories/selection.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResourceRow } from "../../api/types";
import type { Territory } from "./model";
import { TerritoryTable } from "./TerritoryTable";

const describeBody = {
  pod: {
    name: "pod-0", namespace: "n", status: "Running", status_class: "ok", node: "node-a", pod_ip: null, host_ip: null,
    qos: null, service_account: null, owner: null, started_at: null, resource_version: "1",
  },
  containers: [], init_containers: [], ephemeral_containers: [], conditions: [], labels: {}, annotations: {},
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
    uid: String(i), cluster_id: "c1", kind: "Pod", namespace: "n", name: `pod-${i}`, created_at: null,
    columns: { status: "Running", status_class: "ok", resource_version: "1" },
  }));

const territory = (rs: ResourceRow[]): Territory => ({
  cluster: { id: "c1", name: "big", context_name: "x", server: "https://x", original_server: null, provider: "gke",
    region: null, environment: "development", state: "ready", message: null },
  state: "ready", message: null, rows: rs, total: rs.length, failing: 0, pending: 0,
});

function renderTable(n: number, props: Partial<Parameters<typeof TerritoryTable>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div style={{ height: 600 }}>
        <TerritoryTable territories={[territory(rows(n))]} onRetry={() => {}} {...props} />
      </div>
    </QueryClientProvider>,
  );
}

const podRow = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;
const inspector = () => screen.queryByRole("region", { name: /^Details for/ });

describe("selection", () => {
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

  it("l and s on the selected row open logs and shell", () => {
    const onOpenLogs = vi.fn();
    const onOpenShell = vi.fn();
    renderTable(3, { onOpenLogs, onOpenShell });
    fireEvent.keyDown(podRow("pod-2"), { key: "l" });
    fireEvent.keyDown(podRow("pod-2"), { key: "s" });
    expect(onOpenLogs).toHaveBeenCalledWith(expect.objectContaining({ uid: "2" }));
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
});
