import { FILE_CLUSTER_METADATA } from "../../test/clusters";
// frontend/src/features/audit/audit.test.tsx
import { useState } from "react";
import { NO_AUDIT_FILTER } from "./useAudit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuditRecord, Cluster } from "../../api/types";
import { AuditView } from "./AuditView";
import { fakeColumnLayout } from "../../test/layout";

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
  id, name, context_name: name, server: "https://x", ...FILE_CLUSTER_METADATA, original_server: null, provider, region: null,
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

function AuditFixture({ View }: { View: typeof AuditView }) {
  const [filters, setFilters] = useState(NO_AUDIT_FILTER);
  return <View filters={filters} onFilters={setFilters} />;
}

function show(View = AuditView) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><AuditFixture View={View} /></QueryClientProvider>);
}


/**
 * The audit grid as Chrome draws a column `column` px wide: its label needs 80, and each row's cell
 * what `byRow` says for the first key found in that row's text.
 */
function auditWidths(byRow: Record<string, number>, column = 80) {
  fakeColumnLayout({
    box: (el) => el.matches('[role="columnheader"], [role="gridcell"]') ? column : el.matches("[data-column-label]") ? 80 : undefined,
    content: (el) => {
      if (el.matches("[data-column-label]")) return 80;
      const text = el.closest('[role="row"]')?.textContent ?? "";
      return Object.entries(byRow).find(([key]) => text.includes(key))?.[1];
    },
  });
}

describe("audit view", () => {
  it("resizes and resets all seven columns without moving row focus or toggling details", async () => {
    serve(() => ({ records: [record(2, { outcome: "failed", details: { replicas: 3 } }), record(1)], next_before: null }));
    show();
    const row = await screen.findByRole("row", { name: /web-2/ });
    fireEvent.click(row);
    const grid = screen.getByRole("grid");
    const template = () => grid.style.getPropertyValue("--audit-cols");
    const defaults = template();
    const tracks = / (?![^()]*\))/;
    const labels = ["When", "Who", "Action", "Where", "What", "Outcome", "Message"];
    for (const [index, label] of labels.entries()) {
      const header = within(grid).getByRole("columnheader", { name: label });
      const handle = within(header).getByRole("separator", { name: `Resize ${label}` });
      const measure = vi.spyOn(header, "getBoundingClientRect").mockReturnValue({ width: 200 } as DOMRect);
      act(() => handle.focus());
      expect(handle.getAttribute("aria-valuemin")).toBe(label === "Who" ? "48" : "64");
      fireEvent.keyDown(handle, { key: "ArrowRight" });
      const expectedTracks = defaults.split(tracks);
      expectedTracks[index] = "208px";
      expect(template()).toBe(expectedTracks.join(" "));
      if (label === "Outcome") {
        measure.mockReturnValue({ width: 70 } as DOMRect);
        fireEvent.keyDown(handle, { key: "ArrowLeft" });
        expect(template().split(tracks)[index]).toBe("64px");
        expect(within(row).getByRole("gridcell", { name: "Failed" }).title).toBe("Failed");
      }
      fireEvent.keyDown(handle, { key: "ArrowDown" });
      fireEvent.keyDown(handle, { key: " " });
      fireEvent.keyDown(handle, { key: "Enter" });
      expect(template()).toBe(defaults);
      expect(document.activeElement).toBe(handle);
      expect(row.tabIndex).toBe(0);
      expect(row.getAttribute("aria-expanded")).toBe("true");
    }
    expect(screen.getByLabelText("Details").textContent).toContain('"replicas": 3');
  });

  it("double-click fits an audit column to its content", async () => {
    serve(() => ({ records: [record(2), record(1)], next_before: null }));
    show();
    await screen.findByRole("row", { name: /web-1/ });
    const grid = screen.getByRole("grid");
    const defaults = grid.style.getPropertyValue("--audit-cols");
    // The header measures 80; the two rows' cells 150 and 210, so the widest cell must win.
    auditWidths({ "web-2": 210, "web-1": 150 });
    const handle = within(grid).getByRole("separator", { name: "Resize Action" });
    fireEvent.doubleClick(handle);
    expect(grid.style.getPropertyValue("--audit-cols").split(/ (?![^()]*\))/)[2]).toBe("210px");
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(grid.style.getPropertyValue("--audit-cols")).toBe(defaults);
  });

  it("fit shrinks a wide audit column to its header and cells", async () => {
    serve(() => ({ records: [record(2), record(1)], next_before: null }));
    show();
    await screen.findByRole("row", { name: /web-1/ });
    const grid = screen.getByRole("grid");
    // A 400px column whose cells need 120 and 90: the header's free space is not content.
    auditWidths({ "web-2": 120, "web-1": 90 }, 400);
    const handle = within(grid).getByRole("separator", { name: "Resize Action" });
    fireEvent.doubleClick(handle);
    expect(grid.style.getPropertyValue("--audit-cols").split(/ (?![^()]*\))/)[2]).toBe("120px");
    fireEvent.keyDown(handle, { key: "Enter" });
  });

  it("persists the Message width from a drag while keeping filters, details, and the page cursor", async () => {
    const key = "omnikrux.tableColumnWidths";
    localStorage.removeItem(key);
    vi.resetModules();
    const { AuditView: InitialView } = await import("./AuditView");
    const urls = serve((url) => url.searchParams.has("before")
      ? { records: [record(1)], next_before: null }
      : { records: [record(2, { diff: "+replicas: 3" })], next_before: 2 });
    const initial = show(InitialView);
    await screen.findByRole("row", { name: /web-2/ });
    fireEvent.change(screen.getByRole("combobox", { name: "Action" }), { target: { value: "scale" } });
    await waitFor(() => expect(urls.at(-1)!.searchParams.get("action")).toBe("scale"));
    const row = await screen.findByRole("row", { name: /web-2/ });
    fireEvent.click(row);
    const handle = screen.getByRole("separator", { name: "Resize Message" });
    vi.spyOn(handle.closest("[role=columnheader]")!, "getBoundingClientRect")
      .mockReturnValue({ width: 240 } as DOMRect);
    const pointer = (type: string, clientX: number) => {
      fireEvent(handle, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), { pointerId: 1 }));
    };
    const grid = screen.getByRole("grid");
    const requestCount = urls.length;
    pointer("pointerdown", 0);
    pointer("pointermove", 60);
    await waitFor(() => expect(grid.style.getPropertyValue("--audit-cols")).toMatch(/ 300px$/));
    expect(localStorage.getItem(key)).toBeNull();
    expect(screen.getByText("+replicas: 3")).toBeTruthy();
    pointer("pointerup", 80);
    expect(grid.style.getPropertyValue("--audit-cols")).toMatch(/ 320px$/);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ version: 1, tables: { audit: { message: 320 } } });
    expect(urls).toHaveLength(requestCount);
    expect(screen.getByText("+replicas: 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByRole("row", { name: /web-1/ })).toBeTruthy();
    expect(urls.at(-1)!.searchParams.get("before")).toBe("2");
    expect(urls.at(-1)!.searchParams.get("action")).toBe("scale");
    initial.unmount();

    vi.resetModules();
    const { AuditView: ReloadedView } = await import("./AuditView");
    show(ReloadedView);
    const reloaded = await screen.findByRole("grid");
    expect(reloaded.style.getPropertyValue("--audit-cols")).toMatch(/ 320px$/);
    fireEvent.keyDown(within(reloaded).getByRole("separator", { name: "Resize Message" }), { key: "Enter" });
    expect(reloaded.style.getPropertyValue("--audit-cols")).toMatch(/ minmax\(240px, 2fr\)$/);
    localStorage.removeItem(key);
  });

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

  it("leaves alt, ctrl and cmd arrows on a row to the page (alt+down goes into the logs)", async () => {
    serve(() => ({ records: [record(2), record(1)], next_before: null }));
    show();
    const [first, second] = await screen.findAllByRole("row", { name: /web-/ });
    act(() => first.focus());
    for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      expect(fireEvent.keyDown(first, { key: "ArrowDown", ...init })).toBe(true);
    }
    expect(document.activeElement).toBe(first);
    expect(fireEvent.keyDown(first, { key: "ArrowDown" })).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(second));
  });

  it("only the two header lines are diff headers", async () => {
    // A removed line whose own text starts with "--" is still a removed line.
    serve(() => ({
      records: [record(1, { diff: "--- before\n+++ after\n@@ -1,2 +1,2 @@\n--- yaml\n+++ added\n context" })],
      next_before: null,
    }));
    show();
    fireEvent.click(await screen.findByRole("row", { name: /web-1/ }));
    expect((await screen.findByText("--- before")).getAttribute("data-line")).toBe("meta");
    expect(screen.getByText("+++ after").getAttribute("data-line")).toBe("meta");
    expect(screen.getByText("--- yaml").getAttribute("data-line")).toBe("remove");
    expect(screen.getByText("+++ added").getAttribute("data-line")).toBe("add");
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
    fireEvent.change(screen.getByRole("combobox", { name: "Action" }), { target: { value: "scale" } });
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

it("audit shows cluster and account verbs", async () => {
  serve(() => ({ records: [
    record(4, { action: "cloud_account_remove", cluster_id: "", cluster_name: "Engineering", provider: "eks", namespace: null, kind: "cloud-account", name: "Engineering", message: null }),
    record(3, { action: "cloud_account_add", cluster_id: "", cluster_name: "Engineering", provider: "eks", namespace: null, kind: "cloud-account", name: "Engineering", message: null }),
    record(2, { action: "cluster_remove", namespace: null, kind: "clusters", name: "prod-gke", message: null }),
    record(1, { action: "cluster_add", cluster_id: "", namespace: null, kind: "clusters", name: "prod-gke", message: null }),
  ], next_before: null }));
  show();

  for (const verb of ["Added a cluster", "Removed a cluster", "Connected a cloud account", "Removed a cloud account"]) {
    expect(await screen.findByRole("row", { name: new RegExp(verb) })).toBeTruthy();
  }
  const connected = await screen.findByRole("row", { name: /Connected a cloud account/ });
  expect(within(connected).getByText("Cloud account")).toBeTruthy();
});
