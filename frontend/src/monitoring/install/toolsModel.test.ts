import { describe, expect, it } from "vitest";
import type { InstallStatusOut } from "./api";
import { canInstall, componentState, endedUninstall, readAt } from "./toolsModel";
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

describe("endedUninstall", () => {
  // The backend's endings (install/messages.py and store.py), filled in.
  const uninstallEndings = [
    "Uninstall cancelled while uninstall omnikrux-loki. What was already removed stays removed. Uninstall again to finish.",
    "Helm said no. What Helm removed stays removed. Check monitoring, then uninstall again.",
    "Loki was still there after 5 minutes: a finalizer. What was already removed stays removed. Check monitoring, then uninstall again.",
    "The source Loki couldn't be removed. What was already removed stays removed. Uninstall again to finish.",
    "OmniKrux stopped during the uninstall. What Helm applied stays as Helm left it. Open Monitoring tools to see what's there, then run it again.",
    // The job runner's own endings (actions/jobs.py).
    "The uninstall stopped: something unexpected went wrong (KeyError).",
    "The console stopped during the uninstall.",
  ];
  const installEndings = [
    "Install cancelled while install omnikrux-loki. What was already applied stays as Helm left it. Install again to finish, or uninstall the tools.",
    "Helm said no. What Helm applied stays as Helm left it (failed). Check the Pods in monitoring, then install again, or uninstall the tools.",
    "OmniKrux stopped during the install. What Helm applied stays as Helm left it. Open Monitoring tools to see what's there, then run it again.",
    "Helm's record of omnikrux-metrics says an earlier change never finished (pending-install), so Helm won't change it again. Uninstall the tools, then install them again.",
    "The install stopped: something unexpected went wrong (KeyError).",
    "The console stopped during the install.",
  ];

  it("is true only for an uninstall's own failed or cancelled ending", () => {
    for (const message of uninstallEndings) {
      expect(endedUninstall(record({ state: "failed", message }))).toBe(true);
      expect(endedUninstall(record({ state: "cancelled", message }))).toBe(true);
    }
    for (const message of installEndings) expect(endedUninstall(record({ state: "failed", message }))).toBe(false);
    expect(endedUninstall(record({ state: "installed", message: uninstallEndings[0] }))).toBe(false);
    expect(endedUninstall(record({ state: "failed", message: null }))).toBe(false);
  });
});
