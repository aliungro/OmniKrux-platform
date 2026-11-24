import { describe, expect, it } from "vitest";
import type { InstallStatusOut } from "./api";
import { canInstall, componentState, readAt } from "./toolsModel";
import { lokiRelease, record, release, status, TOOLS } from "./toolsFixtures";

const full = (over: Partial<Omit<InstallStatusOut, "tools">> = {}): InstallStatusOut => ({ ...status(over), tools: TOOLS });

describe("componentState", () => {
  it("is missing when nothing is installed or the component isn't in the install", () => {
    expect(componentState(full(), "metrics")).toBe("missing");
    const s = full({ install: record(), releases: [release()] });
    expect(componentState(s, "metrics")).toBe("installed");
    expect(componentState(s, "logs")).toBe("missing");
  });

  it("is missing when Helm has no record of a release", () => {
    const s = full({ install: record({ components: ["metrics", "logs"] }), releases: [release(), lokiRelease({ status: "missing", version: null })] });
    expect(componentState(s, "metrics")).toBe("installed");
    expect(componentState(s, "logs")).toBe("missing");
  });

  it("is failing when a release isn't deployed or a workload isn't ready", () => {
    expect(componentState(full({ install: record(), releases: [release({ status: "failed" })] }), "metrics")).toBe("failing");
    const waiting = release({ workloads: [{ kind: "StatefulSet", name: "prometheus", label: "Prometheus", ready: 0, desired: 1, why: "Pending" }] });
    expect(componentState(full({ install: record(), releases: [waiting] }), "metrics")).toBe("failing");
  });

  it("is busy while a job runs", () => {
    const s = full({ install: record({ state: "installing", job_id: "j1" }), releases: [release()] });
    expect(componentState(s, "metrics")).toBe("busy");
    expect(componentState(s, "logs")).toBe("busy");
  });
});

describe("canInstall", () => {
  it("needs the tools, a good read and no running job", () => {
    expect(canInstall(full())).toBe(true);
    expect(canInstall({ ...full(), tools: { ...TOOLS, available: false } })).toBe(false);
    expect(canInstall(full({ problem: "Couldn't read." }))).toBe(false);
    expect(canInstall(full({ install: record({ state: "uninstalling" }) }))).toBe(false);
    expect(canInstall(full({ install: record({ state: "failed" }) }))).toBe(true);
  });
});

describe("readAt", () => {
  it("is HH:MM:SS of the local time", () => {
    expect(readAt("2026-11-24T10:04:12")).toBe("10:04:12");
    expect(readAt("2026-11-24T09:05:07")).toBe("09:05:07");
    expect(readAt("nope")).toBeNull();
  });
});
