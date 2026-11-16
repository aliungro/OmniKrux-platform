import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storageKey = "omnikrux.tableColumnWidths";
const loadWidths = async () => (await import("./columnWidths")).useColumnWidths;

beforeEach(() => {
  localStorage.removeItem(storageKey);
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("previews locally and persists shared commits across reloads", async () => {
  const useColumnWidths = await loadWidths();
  const { result } = renderHook(() => ({
    left: useColumnWidths("resource:pods"),
    right: useColumnWidths("resource:pods"),
    nodes: useColumnWidths("resource:nodes"),
  }));
  act(() => result.current.left.previewWidth("cpu", 180));
  expect(result.current.left.widths.get("cpu")).toBe(180);
  expect(result.current.right.widths.has("cpu")).toBe(false);
  expect(localStorage.getItem(storageKey)).toBeNull();
  act(() => result.current.left.commitWidth("cpu", 180));
  expect(result.current.right.widths.get("cpu")).toBe(180);
  expect(result.current.nodes.widths.has("cpu")).toBe(false);

  vi.resetModules();
  const reload = await loadWidths();
  const { result: restored } = renderHook(() => reload("resource:pods"));
  expect(restored.current.widths.get("cpu")).toBe(180);
  act(() => restored.current.commitWidth("cpu", null));
  expect(restored.current.widths.has("cpu")).toBe(false);
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ version: 1, tables: {} });
});

it("ignores invalid stored widths and retains generated keys safely", async () => {
  localStorage.setItem(storageKey, '{"version":1,"tables":{"resource:widgets.example.com":{"__proto__":130,"constructor":144,"pc_owner name":88,"wide":920,"fraction":70.5,"string":"90","outOfRange":8193,"negative":-3,"":120}}}');
  const useColumnWidths = await loadWidths();
  const { result } = renderHook(() => useColumnWidths("resource:widgets.example.com"));
  expect([...result.current.widths]).toEqual([["__proto__", 130], ["constructor", 144], ["pc_owner name", 88], ["wide", 920]]);
  act(() => result.current.commitWidth("pc_size", Number.NaN));
  expect(result.current.widths.has("pc_size")).toBe(false);
});

it("reverts to defaults for malformed data and keeps commits when storage throws", async () => {
  localStorage.setItem(storageKey, "{broken");
  const useColumnWidths = await loadWidths();
  const { result } = renderHook(() => useColumnWidths("audit"));
  expect(result.current.widths.size).toBe(0);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  act(() => result.current.commitWidth("who", 48));
  expect(result.current.widths.get("who")).toBe(48);

  vi.resetModules();
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
  const reload = await loadWidths();
  const { result: restored } = renderHook(() => reload("audit"));
  expect(restored.current.widths.size).toBe(0);
});

it("keeps the most recently resized tables and drops the oldest past the limit", async () => {
  const useColumnWidths = await loadWidths();
  const { result } = renderHook(() => useColumnWidths("resource:pods"));
  const other = renderHook(({ key }) => useColumnWidths(key), { initialProps: { key: "inspector:describe:t0" } });
  act(() => result.current.commitWidth("name", 300));
  for (let i = 0; i < 100; i++) {
    other.rerender({ key: `inspector:describe:t${i}` });
    act(() => other.result.current.commitWidth("0:Name", 120));
    if (i === 50) act(() => result.current.commitWidth("name", 310));
  }
  const tables = Object.keys(JSON.parse(localStorage.getItem(storageKey)!).tables);
  expect(tables).toHaveLength(100);
  expect(tables).toContain("resource:pods");
  expect(tables).not.toContain("inspector:describe:t0");
  expect(tables.at(-1)).toBe("inspector:describe:t99");
  expect(result.current.widths.get("name")).toBe(310);
});

it("follows widths saved by another browser tab", async () => {
  const useColumnWidths = await loadWidths();
  const { result } = renderHook(() => useColumnWidths("audit"));
  const saved = JSON.stringify({ version: 1, tables: { audit: { who: 72 } } });
  localStorage.setItem(storageKey, saved);
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "x" })); });
  expect(result.current.widths.has("who")).toBe(false);
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: saved })); });
  expect(result.current.widths.get("who")).toBe(72);
  localStorage.removeItem(storageKey);
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: null })); });
  expect(result.current.widths.size).toBe(0);
});

it("leaves a store written by another version alone and keeps this session's widths in memory", async () => {
  const future = JSON.stringify({ version: 2, tables: { audit: { who: { px: 72 } } } });
  localStorage.setItem(storageKey, future);
  const useColumnWidths = await loadWidths();
  const { result } = renderHook(() => useColumnWidths("audit"));
  expect(result.current.widths.size).toBe(0);
  act(() => result.current.commitWidth("who", 90));
  expect(result.current.widths.get("who")).toBe(90);
  expect(localStorage.getItem(storageKey)).toBe(future);
});
