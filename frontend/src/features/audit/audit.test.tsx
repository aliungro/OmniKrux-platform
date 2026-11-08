// frontend/src/features/audit/audit.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuditRecord, Cluster } from "../../api/types";
import { AuditView } from "./AuditView";

beforeEach(() => {
  // jsdom has no layout; give everything a size so the virtualizer renders rows.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

const cluster = (id: string, name: string, provider: Cluster["provider"]): Cluster => ({
  id, name, context_name: name, server: "https://x", original_server: null, provider, region: null,
  environment: "development", state: "ready", message: null,
});
const CLUSTERS = [cluster("c1", "prod-gke", "gke"), cluster("c2", "dev-aks", "aks")];

const record = (id: number, over: Partial<AuditRecord> = {}): AuditRecord => ({
  id, started_at: "2026-11-07T10:00:00Z", finished_at: "2026-11-07T10:00:01Z", actor: "local", action: "scale",
  cluster_id: "c1", cluster_name: "prod-gke", provider: "gke", namespace: "payments", kind: "deployments.apps",
  name: `web-${id}`, outcome: "succeeded", message: "Scaled to 3 replicas.", diff: null, details: null, ...over,
});

function serve(pages: (url: URL) => { records: AuditRecord[]; next_before: number | null }) {
  const urls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/clusters") return json(CLUSTERS);
    const u = new URL(url, "http://x");
    urls.push(u);
    return json(pages(u));
  }));
  return urls;
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AuditView onBack={() => {}} /></QueryClientProvider>);
}

describe("audit view", () => {
  it("audit view lists newest first with cluster badge", async () => {
    serve(() => ({ records: [record(3, { action: "restart" }), record(2, { cluster_id: "c2", cluster_name: "dev-aks", provider: "aks", action: "rollback" }), record(1)], next_before: null }));
    show();
    const rows = await screen.findAllByRole("row", { name: /web-/ });
    expect(rows.map((r) => /web-(\d)/.exec(r.textContent!)![1])).toEqual(["3", "2", "1"]);
    expect(within(rows[0]).getByText("Restarted")).toBeTruthy();
    expect(within(rows[1]).getByText("Rolled back")).toBeTruthy();
    expect(within(rows[0]).getByText("GKE")).toBeTruthy();
    expect(within(rows[1]).getByText("AKS")).toBeTruthy();
    expect(within(rows[0]).getByText("prod-gke / payments")).toBeTruthy();
    expect(within(rows[0]).getByText("web-3")).toBeTruthy();
  });

  it("outcomes: ended reads as ok, failed as a diamond, started as a ring", async () => {
    serve(() => ({
      records: [
        record(4, { outcome: "ended", action: "shell", message: null }),
        record(3, { outcome: "failed", message: "Nothing was changed." }),
        record(2, { outcome: "started", finished_at: null, message: null }),
        record(1, { outcome: "unknown", message: "The console stopped before this finished." }),
      ],
      next_before: null,
    }));
    show();
    const rows = await screen.findAllByRole("row", { name: /web-/ });
    const shape = (r: HTMLElement) => r.querySelector("[data-shape]")!.getAttribute("data-shape");
    expect(rows.map(shape)).toEqual(["dot", "diamond", "ring", "ring"]);
    expect(within(rows[3]).getByText("The console stopped before this finished.")).toBeTruthy();
  });

  it("node shell rows show the node", async () => {
    serve(() => ({ records: [record(1, { action: "node_shell", kind: "pods", name: "node-shell-x", details: { node: "kind-worker" } })], next_before: null }));
    show();
    const row = await screen.findByRole("row", { name: /Started a node shell/ });
    expect(within(row).getByText("Node kind-worker")).toBeTruthy();
  });

  it("audit row expands to diff", async () => {
    serve(() => ({
      records: [record(1, { diff: "--- a\n+++ b\n-replicas: 2\n+replicas: 3\n context", details: { replicas: 3 } })],
      next_before: null,
    }));
    show();
    const row = await screen.findByRole("row", { name: /web-1/ });
    fireEvent.click(row);
    const added = await screen.findByText("+replicas: 3");
    const removed = screen.getByText("-replicas: 2");
    expect(added.getAttribute("data-line")).toBe("add");
    expect(removed.getAttribute("data-line")).toBe("remove");
    expect(screen.getByText(/"replicas": 3/)).toBeTruthy();
    expect(row.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(row);
    expect(screen.queryByText("+replicas: 3")).toBeNull();
  });

  it("load older pages with before cursor", async () => {
    const urls = serve((u) =>
      u.searchParams.get("before") === "5"
        ? { records: [record(4), record(3)], next_before: null }
        : { records: [record(6), record(5)], next_before: 5 },
    );
    show();
    await screen.findByRole("row", { name: /web-6/ });
    expect(urls[0].searchParams.get("before")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByRole("row", { name: /web-3/ });
    expect(urls[1].searchParams.get("before")).toBe("5");
    // Nothing older: the button goes.
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("audit filters by cluster and action", async () => {
    const urls = serve(() => ({ records: [record(1)], next_before: null }));
    show();
    await screen.findByRole("row", { name: /web-1/ });
    fireEvent.change(screen.getByLabelText("Cluster"), { target: { value: "c2" } });
    await waitFor(() => expect(urls.at(-1)!.searchParams.get("cluster")).toBe("c2"));
    fireEvent.change(screen.getByLabelText("Action"), { target: { value: "scale" } });
    await waitFor(() => expect(urls.at(-1)!.searchParams.get("action")).toBe("scale"));
    expect(urls.at(-1)!.searchParams.get("cluster")).toBe("c2");
  });

  it("filters by text", async () => {
    const urls = serve(() => ({ records: [record(1)], next_before: null }));
    show();
    await screen.findByRole("row", { name: /web-1/ });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "web" } });
    await waitFor(() => expect(urls.at(-1)!.searchParams.get("q")).toBe("web"));
  });

  it("empty state", async () => {
    serve(() => ({ records: [], next_before: null }));
    show();
    expect(await screen.findByText("Nothing has been changed from Omnikrux yet.")).toBeTruthy();
  });

  it("a failed read says why and offers a retry", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      url === "/api/clusters" ? json(CLUSTERS) : json({ detail: "The audit log can't be read right now. Try again." }, 503)));
    show();
    expect((await screen.findByRole("alert")).textContent).toContain("The audit log can't be read right now. Try again.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
