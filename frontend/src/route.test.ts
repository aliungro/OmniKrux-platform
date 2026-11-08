// frontend/src/route.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { parseRoute, useRoute } from "./route";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("route", () => {
  it("reads the kind from the hash; anything else is pods", () => {
    expect(parseRoute("#kind=deployments.apps")).toEqual({ view: "resources", kind: "deployments.apps" });
    expect(parseRoute("#audit")).toEqual({ view: "audit" });
    expect(parseRoute("#kind=Bad Key")).toEqual({ view: "resources", kind: "pods" });
    expect(parseRoute("")).toEqual({ view: "resources", kind: "pods" });
  });
  it("a choice adds a history entry; a replace doesn't", () => {
    const { result } = renderHook(() => useRoute());
    const start = window.history.length;
    act(() => result.current[1]({ view: "resources", kind: "nodes" }));
    expect(window.history.length).toBe(start + 1);
    expect(window.location.hash).toBe("#kind=nodes");
    act(() => result.current[1]({ view: "resources", kind: "events" }, { replace: true }));
    expect(window.history.length).toBe(start + 1);
    expect(window.location.hash).toBe("#kind=events");
    expect(result.current[0]).toEqual({ view: "resources", kind: "events" });
  });
});
