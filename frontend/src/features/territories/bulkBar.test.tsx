// frontend/src/features/territories/bulkBar.test.tsx — the floating bulk-selection bar (b9fc5ab):
// it floats over the table instead of pushing rows down, keeps scroll room for itself, announces
// the count once, and names its controls.
import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResourceRow } from "../../api/types";
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
