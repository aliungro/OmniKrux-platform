// frontend/src/features/territories/bulkBar.test.tsx — the floating bulk-selection bar (b9fc5ab):
// it floats over the table instead of pushing rows down, keeps scroll room for itself, announces
// the count once, and names its controls.
import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Plan, PlanRequest, ResourceRow } from "../../api/types";
import type { Territory } from "./model";
import { PODS } from "../../test/kinds";
import { Table } from "../../test/table";
import { ActionsProvider } from "../actions/ActionDialog";

const VERBS = ["get", "list", "watch", "update", "patch", "delete"];

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const rows = (n: number): ResourceRow[] => Array.from({ length: n }, (_, i) => ({
  uid: String(i), cluster_id: "c1", kind: "Pod", namespace: "n", name: `pod-${i}`, created_at: null, labels: {},
  columns: { status: "Running", status_class: "ok", resource_version: "1" },
}));

const territory = (rs: ResourceRow[]): Territory => ({
  cluster: { id: "c1", name: "big", context_name: "x", server: "https://x", ...FILE_CLUSTER_METADATA, original_server: null, provider: "gke",
    region: null, environment: "development", state: "ready", message: null },
  state: "ready", message: null, rows: rs, total: rs.length, failing: 0, pending: 0,
});

function renderTable(n: number, verbs = VERBS) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ActionsProvider>
        <div style={{ height: 600 }}>
          <Table territories={[territory(rows(n))]} kind={{ ...PODS, verbs }} onRetry={() => {}} />
        </div>
      </ActionsProvider>
    </QueryClientProvider>,
  );
}

const grid = () => screen.getByRole("grid");
const scroller = () => grid().parentElement as HTMLElement;
const bar = () => screen.queryByRole("group", { name: "Selected resources" });
const status = () => screen.getAllByRole("status").find(el => el.getAttribute("aria-atomic") === "true")!;

it("the bar floats after the table, so checking a row never moves the rows", () => {
  renderTable(3);
  const frame = scroller().parentElement as HTMLElement;
  const before = Array.from(grid().querySelectorAll("[data-row-key]")).map(row => row.getAttribute("data-row-key"));
  expect(bar()).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-1" }));
  expect(bar()).toBeTruthy();
  // The table stays the frame's first child; the bar comes after it, over the rows.
  expect(frame.firstElementChild).toBe(scroller());
  expect(scroller().compareDocumentPosition(bar()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const after = Array.from(grid().querySelectorAll("[data-row-key]")).map(row => row.getAttribute("data-row-key"));
  expect(after).toEqual(before);
});

it("keeps scroll room for the bar whenever rows can be selected", () => {
  renderTable(3);
  expect(scroller().style.scrollPaddingBottom).toBe("80px");
  cleanup();
  renderTable(3, ["get", "list", "watch"]);
  expect(screen.queryByRole("checkbox", { name: "Select pod-1" })).toBeNull();
  expect(scroller().style.scrollPaddingBottom).toBe("16px");
});

it("announces the count once and names the limit, while the visible count stays silent", () => {
  renderTable(50);
  expect(status().textContent).toBe("");
  fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-0" }));
  expect(status().textContent).toBe("1 selected");
  const count = bar()!.querySelector('[aria-hidden="true"]') as HTMLElement;
  expect(count.textContent).toBe("1 selected");
  expect(count.title).toBe("");
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible resources" }));
  expect(status().textContent).toBe("50 selected (limit of 50)");
  expect((bar()!.querySelector('[aria-hidden="true"]') as HTMLElement).title).toBe("Limit of 50 per batch");
});

it("names its controls, and Clear empties the selection and returns focus to the table", () => {
  renderTable(3);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-0" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-2" }));
  const del = screen.getByRole("button", { name: "Delete selected" });
  expect(del.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  const clear = screen.getByRole("button", { name: "Clear selection" });
  expect(clear.textContent).toBe("Clear");
  fireEvent.click(clear);
  expect(bar()).toBeNull();
  expect(status().textContent).toBe("");
  expect(document.activeElement).toBe(scroller());
  expect((screen.getByRole("checkbox", { name: "Select pod-0" }) as HTMLInputElement).checked).toBe(false);
});

it("header and row checkboxes are native checkboxes with a decorative mark", () => {
  renderTable(3);
  for (const name of ["Select all visible resources", "Select pod-0"]) {
    const box = screen.getByRole("checkbox", { name }) as HTMLInputElement;
    expect(box.type).toBe("checkbox");
    expect(box.nextElementSibling?.getAttribute("aria-hidden")).toBe("true");
  }
  fireEvent.click(screen.getByRole("checkbox", { name: "Select all visible resources" }));
  expect(status().textContent).toBe("3 selected");
});

function stubBulkDelete(blockedByPod: Record<string, string[]> = {}, applyReady = Promise.resolve()) {
  const applies: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/actions/plan") {
      const req = JSON.parse(String(init?.body)) as PlanRequest;
      return json({
        plan_id: `plan-${req.target.name}`, action: "delete", target: req.target, kind: "Pod",
        cluster: { id: "c1", name: "big", provider: "gke", environment: "development" },
        title: `Delete Pod ${req.target.name}`, summary: [], warnings: [], blocked: blockedByPod[req.target.name] ?? [],
        diff: null, confirm_text: null, apply_label: "Delete", expires_at: "",
      } satisfies Plan);
    }
    if (url.endsWith("/apply")) {
      applies.push(url);
      await applyReady;
      return json({ outcome: "succeeded", message: "Deleted.", job_id: null, audit_id: 1 });
    }
    return new Response("{}", { status: 200 });
  }));
  return applies;
}

function openTwoPodDeleteReview() {
  renderTable(3);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-0" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-1" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
  return screen.getByRole("dialog", { name: "Delete 2 resources" });
}

it("bulk delete confirms with ctrl+enter and keeps focus on cancel", async () => {
  let releaseApplies!: () => void;
  const applyReady = new Promise<void>(resolve => { releaseApplies = resolve; });
  const applies = stubBulkDelete({}, applyReady);
  const dialog = within(openTwoPodDeleteReview());
  const confirm = dialog.getByRole<HTMLButtonElement>("button", { name: "Delete 2 resources" });
  await waitFor(() => expect(confirm.disabled).toBe(false));
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  expect(document.activeElement).toBe(cancel);
  expect(fireEvent.keyDown(confirm, { key: "Enter", repeat: true })).toBe(false);
  expect(fireEvent.keyDown(confirm, { key: "Enter", ctrlKey: true, repeat: true })).toBe(false);
  expect(applies).toEqual([]);

  const expectedApplies = ["/api/actions/plan-pod-0/apply", "/api/actions/plan-pod-1/apply"];
  act(() => {
    expect(fireEvent.keyDown(cancel, { key: "Enter", ctrlKey: true })).toBe(false);
    expect([...applies].sort()).toEqual(expectedApplies);
    // The click can still reach the handler before React disables the button.
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
  });
  expect([...applies].sort()).toEqual(expectedApplies);

  releaseApplies();
  expect(await dialog.findByText("2 of 2 deleted.")).toBeTruthy();
  // Done: Ctrl+Enter has nothing more to confirm.
  fireEvent.keyDown(dialog.getByRole("button", { name: "Close" }), { key: "Enter", ctrlKey: true });
  expect([...applies].sort()).toEqual(expectedApplies);
});

it("a blocked bulk review sends no applies for any selected resource", async () => {
  const reason = "This pod is protected from deletion.";
  const applies = stubBulkDelete({ "pod-1": [reason] });
  const review = openTwoPodDeleteReview();
  const dialog = within(review);
  expect(await dialog.findByText(reason)).toBeTruthy();
  expect(dialog.getByText(/Pod pod-0/)).toBeTruthy();
  const confirm = dialog.getByRole<HTMLButtonElement>("button", { name: "Delete 2 resources" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  expect(confirm.disabled).toBe(true);

  await act(async () => {
    expect(fireEvent.keyDown(cancel, { key: "Enter", ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(cancel, { key: "Enter", metaKey: true })).toBe(false);
    fireEvent.click(confirm);
  });
  expect(applies).toEqual([]);
  expect(screen.getByRole("dialog", { name: "Delete 2 resources" })).toBe(review);
});

it("ctrl+enter on a bulk delete whose review is still loading sends nothing", async () => {
  const applies: string[] = [];
  const plans: Array<() => void> = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/actions/plan") {
      const req = JSON.parse(String(init?.body)) as PlanRequest;
      // The review answers only when the test says so.
      return new Promise<Response>((resolve) => plans.push(() => resolve(json({
        plan_id: `plan-${req.target.name}`, action: "delete", target: req.target, kind: "Pod",
        cluster: { id: "c1", name: "big", provider: "gke", environment: "development" },
        title: `Delete Pod ${req.target.name}`, summary: [], warnings: [], blocked: [], diff: null, confirm_text: null,
        apply_label: "Delete", expires_at: "",
      } satisfies Plan))));
    }
    if (url.endsWith("/apply")) {
      applies.push(url);
      return Promise.resolve(json({ outcome: "succeeded", message: "Deleted.", job_id: null, audit_id: 1 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }));
  renderTable(3);
  fireEvent.click(screen.getByRole("checkbox", { name: "Select pod-0" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
  const dialog = within(screen.getByRole("dialog", { name: "Delete 1 resource" }));
  await waitFor(() => expect(plans).toHaveLength(1));
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  expect(fireEvent.keyDown(cancel, { key: "Enter", ctrlKey: true })).toBe(false);
  expect(fireEvent.keyDown(cancel, { key: "Enter", metaKey: true })).toBe(false);
  // The review arrives: the earlier presses were not kept for it.
  await act(async () => plans[0]());
  await waitFor(() => expect(dialog.getByRole<HTMLButtonElement>("button", { name: "Delete 1 resource" }).disabled).toBe(false));
  expect(applies).toEqual([]);
  expect(screen.getByRole("dialog", { name: "Delete 1 resource" })).toBeTruthy();
});
