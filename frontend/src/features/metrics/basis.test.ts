import { describe, expect, it } from "vitest";
import type { ResourceRow } from "../../api/types";
import { usageBasis } from "./basis";

const row = (kind: string, columns: Record<string, unknown>): ResourceRow => ({
  uid: "u", cluster_id: "c", kind, namespace: null, name: "web", created_at: null, labels: {}, columns,
});

describe("usageBasis", () => {
  it.each([
    ["cpu", { cpu_limit_m: 500, cpu_request_m: 250 }, { of: 500, basis: "limit" }],
    ["cpu", { cpu_limit_m: 0, cpu_request_m: 250 }, { of: 250, basis: "request" }],
    ["cpu", { cpu_limit_m: -1, cpu_request_m: 0 }, { of: 2000, basis: "node" }],
    ["memory", { memory_limit_b: 512, memory_request_b: 256 }, { of: 512, basis: "limit" }],
    ["memory", { memory_limit_b: 0, memory_request_b: 256 }, { of: 256, basis: "request" }],
    ["memory", { memory_limit_b: null, memory_request_b: null }, { of: 4096, basis: "node" }],
  ] as const)("bar measures against limit, else request, else node: %s %j", (resource, columns, expected) => {
    expect(usageBasis(row("Pod", columns), resource, { cpu_m: 2000, memory_b: 4096 })).toEqual(expected);
  });

  it.each([null, { cpu_m: 0, memory_b: -1 }, { cpu_m: null, memory_b: null }])("unknown or nonpositive node size has no basis", size => {
    expect(usageBasis(row("Pod", {}), "cpu", size)).toBeNull();
    expect(usageBasis(row("Pod", {}), "memory", size)).toBeNull();
  });

  it("node rows use only their own allocatable capacity", () => {
    expect(usageBasis(row("Node", { allocatable_cpu_m: 4000, cpu_limit_m: 100 }), "cpu", { cpu_m: 2000, memory_b: 4096 })).toEqual({ of: 4000, basis: "allocatable" });
    expect(usageBasis(row("Node", { allocatable_memory_b: 8192 }), "memory", null)).toEqual({ of: 8192, basis: "allocatable" });
    expect(usageBasis(row("Node", { allocatable_cpu_m: 0 }), "cpu", { cpu_m: 2000, memory_b: 4096 })).toBeNull();
  });
});
