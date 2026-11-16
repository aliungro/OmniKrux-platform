// A column drag previews through the grid's template only: no row renders again per frame.
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PODS } from "../../test/kinds";
import { Table } from "../../test/table";

const rowRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./ResourceRowView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ResourceRowView")>();
  return {
    ...actual,
    ResourceRowView: (props: Parameters<typeof actual.ResourceRowView>[0]) => {
      rowRenders.count++;
      return actual.ResourceRowView(props);
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

function layout() {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) } as DOMRect);
}

it("drags a column of a 10,000-row table without rendering any row again until release", () => {
  layout();
  const rows = Array.from({ length: 10000 }, (_, i) => ({
    uid: String(i), cluster_id: "c1", kind: "Pod", namespace: "n", name: `pod-${i}`, created_at: null, labels: {},
    columns: { status: "Running", status_class: "ok" },
  }));
  const t = { cluster: { id: "c1", name: "big", provider: "gke", environment: "development" }, state: "ready", message: null,
    rows, total: 10000, failing: 0, pending: 0 } as never;
  render(<div style={{ height: 600 }}><Table territories={[t]} kind={PODS} onRetry={() => {}} /></div>);
  const grid = screen.getByRole("grid");
  const template = grid.style.getPropertyValue("--cols");
  const minWidth = grid.style.minWidth;
  const handle = within(grid).getByRole("separator", { name: "Resize Namespace" });
  vi.spyOn(handle.closest("[role=columnheader]")!, "getBoundingClientRect").mockReturnValue({ width: 200 } as DOMRect);
  const pointer = (type: string, clientX: number) =>
    fireEvent(handle, Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), { pointerId: 1 }));
  vi.useFakeTimers();

  pointer("pointerdown", 100);
  const before = rowRenders.count;
  expect(before).toBeGreaterThan(0);
  for (const x of [120, 140, 160, 180]) {
    pointer("pointermove", x);
    act(() => vi.advanceTimersToNextFrame());
  }
  expect(grid.style.getPropertyValue("--cols")).toContain(" 280px ");
  expect(grid.style.minWidth).not.toBe(minWidth);
  expect(rowRenders.count).toBe(before);

  pointer("pointermove", 100);
  act(() => vi.advanceTimersToNextFrame());
  expect(grid.style.getPropertyValue("--cols")).toBe(template);
  expect(grid.style.minWidth).toBe(minWidth);
  pointer("pointermove", 150);
  act(() => vi.advanceTimersToNextFrame());
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(grid.style.getPropertyValue("--cols")).toBe(template);
  expect(rowRenders.count).toBe(before);

  pointer("pointerdown", 100);
  pointer("pointermove", 130);
  act(() => vi.advanceTimersToNextFrame());
  pointer("pointerup", 130);
  expect(grid.style.getPropertyValue("--cols")).toContain(" 230px ");
  expect(JSON.parse(localStorage.getItem("omnikrux.tableColumnWidths")!).tables["resource:pods"]).toEqual({ namespace: 230 });
});
