import { describe, expect, it } from "vitest";
import { parseHash, hashFor } from "./route";

describe("hash routing", () => {
  it("parses new hashes", () => {
    expect(parseHash("#/kubernetes/tab-1")).toEqual({ app: "kubernetes", tab: "tab-1" });
    expect(parseHash("#/kubernetes")).toEqual({ app: "kubernetes" });
    expect(parseHash("#/audit")).toEqual({ app: "audit" });
    expect(parseHash("#/settings")).toEqual({ app: "settings" });
    expect(hashFor("kubernetes", "tab-1")).toBe("#/kubernetes/tab-1");
  });
  it("parses and writes Monitoring hashes", () => {
    expect(parseHash("#/monitoring")).toEqual({ app: "monitoring" });
    expect(parseHash("#/monitoring/tab-2")).toEqual({ app: "monitoring", tab: "tab-2" });
    expect(hashFor("monitoring", "tab-2")).toBe("#/monitoring/tab-2");
    expect(hashFor("monitoring")).toBe("#/monitoring");
    expect(hashFor("audit", "tab-2")).toBe("#/audit");
  });
  it("accepts old links and rejects unknown hashes", () => {
    expect(parseHash("#kind=deployments.apps")).toEqual({ legacyKind: "deployments.apps" });
    expect(parseHash("#audit")).toEqual({ app: "audit" });
    expect(parseHash("#kind=Bad Key")).toBeNull();
    expect(parseHash("#/unknown")).toBeNull();
  });
});
