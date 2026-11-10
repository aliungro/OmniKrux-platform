import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { DEFAULT_PINNED, PINNED_KEY, loadPinned, savePinned, resetPinnedKinds, usePinnedKinds } from "./pinnedKinds";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("default pinned kinds are today's row plus secrets", () => {
  expect(loadPinned(null)).toEqual(["pods", "deployments.apps", "statefulsets.apps", "daemonsets.apps", "jobs.batch", "services", "ingresses.networking.k8s.io", "secrets", "nodes", "events", "helm-releases"]);
});
it.each(["broken", '{"version":2,"kinds":["pods"]}', '{"version":1,"kinds":["bad/key"]}', '{"version":1,"kinds":"pods"}'])("corrupt pinned storage falls back to default: %s", raw => {
  localStorage.setItem(PINNED_KEY, raw);
  expect(loadPinned(localStorage)).toEqual(DEFAULT_PINNED);
});
it("empty pinned storage is valid; duplicates drop and the row is capped at 40", () => {
  localStorage.setItem(PINNED_KEY, JSON.stringify({version:1,kinds:[]}));
  expect(loadPinned(localStorage)).toEqual([]);
  localStorage.setItem(PINNED_KEY, JSON.stringify({version:1,kinds:["pods", "pods", ...Array.from({length:45}, (_, i) => `kind-${i}`)]}));
  const loaded = loadPinned(localStorage);
  expect(loaded).toHaveLength(40);
  expect(loaded.slice(0,3)).toEqual(["pods", "kind-0", "kind-1"]);
});
it("throwing storage falls back and save failures use plain words", () => {
  vi.spyOn(Storage.prototype,"getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
  expect(loadPinned(localStorage)).toEqual(DEFAULT_PINNED);
  vi.spyOn(Storage.prototype,"setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  expect(savePinned(localStorage,["pods"])).toBe("storage is full");
});
it("pinned kinds survive reload and consumers agree live", () => {
  const a = renderHook(usePinnedKinds), b = renderHook(usePinnedKinds);
  act(() => { a.result.current.unpin("pods"); a.result.current.pin("certificates.cert-manager.io"); });
  expect(b.result.current.pinned[0]).toBe("deployments.apps");
  expect(b.result.current.pinned.at(-1)).toBe("certificates.cert-manager.io");
  expect(JSON.parse(localStorage.getItem(PINNED_KEY)!)).toEqual({version:1,kinds:b.result.current.pinned});
  a.unmount(); b.unmount(); resetPinnedKinds();
  const reloaded = renderHook(usePinnedKinds);
  expect(reloaded.result.current.pinned[0]).toBe("deployments.apps");
  expect(reloaded.result.current.pinned.at(-1)).toBe("certificates.cert-manager.io");
});
it("the shared store bounds moves, ignores invalid pins, and restores defaults", () => {
  const {result} = renderHook(usePinnedKinds);
  act(() => { result.current.move("pods",-1); result.current.pin("bad/key"); result.current.pin("pods"); });
  expect(result.current.pinned).toEqual(DEFAULT_PINNED);
  act(() => result.current.move("pods",1));
  expect(result.current.pinned.slice(0,2)).toEqual(["deployments.apps","pods"]);
  act(() => result.current.reset());
  expect(result.current.pinned).toEqual(DEFAULT_PINNED);
});
it("a blocked localStorage getter keeps pins in memory and reports the attempted save", () => {
  vi.spyOn(window,"localStorage","get").mockImplementation(() => {throw new DOMException("blocked","SecurityError");});
  const {result} = renderHook(usePinnedKinds);
  act(() => result.current.unpin("pods"));
  expect(result.current.pinned).not.toContain("pods");
  expect(result.current.saveProblem).toBe("this browser blocks site storage");
});
