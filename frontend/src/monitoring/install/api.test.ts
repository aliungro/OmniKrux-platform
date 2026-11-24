import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failure } from "../../api/http";
import type { Plan } from "../../api/types";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import {
  generateFiles, installKeys, installStatus, installTools, planInstall, planUninstall, probeTools, syncContacts, useInstallStatus,
  useInstallTools, type InstallPlanOut, type InstallSettingsOut, type InstallStatusOut,
} from "./api";

afterEach(() => vi.unstubAllGlobals());

const resources = { cpu_request: "100m", memory_request: "256Mi", memory_limit: "512Mi" };
const settings: InstallSettingsOut = {
  namespace: "monitoring", retention_days: 7, persist: true, prometheus_storage: "10Gi", loki_storage: "10Gi", alertmanager_storage: "1Gi",
  prometheus: resources, alertmanager: resources, loki: resources, alloy: resources,
};
const plan = (over: Partial<Plan> = {}): Plan => ({
  plan_id: "ip1", action: "install", target: { cluster_id: "c1", kind_key: "namespaces", namespace: null, name: "monitoring" },
  kind: "Namespace", cluster: { id: "c1", name: "kind-dev", provider: "kind", environment: "development" },
  title: "Install monitoring tools in monitoring", summary: ["Creates the namespace monitoring."], warnings: [], blocked: [], diff: null,
  confirm_text: null, apply_label: "Install", expires_at: "2026-11-24T10:05:00Z", ...over,
});
const planned: InstallPlanOut = { plan: plan(), settings, problems: [], facts: { default_storage_class: "standard", kube_version: "v1.33.1" } };
const status: Omit<InstallStatusOut, "tools"> = {
  cluster_id: "c1", cluster_name: "kind-dev", install: null, releases: [], others: [], checked_at: "2026-11-24T10:00:00Z", problem: null,
};

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("install API", () => {
  it("planInstall returns the plan and settings", async () => {
    const problem = { field: "retention_days", message: "Keep data for 1 to 90 days." };
    const api = installFakeMonitoringApi({ install: { plans: [planned, { ...planned, plan: plan({ plan_id: "ip2" }), problems: [problem] }] } });
    const body = { cluster_id: "c1", components: ["metrics" as const], settings: { retention_days: 0 }, project_id: "p1" };
    const first = await planInstall(body);
    expect(first.plan.plan_id).toBe("ip1");
    expect(first.settings).toEqual(settings);
    expect(first.facts).toEqual({ default_storage_class: "standard", kube_version: "v1.33.1" });
    const second = await planInstall(body);
    expect(second.plan.plan_id).toBe("ip2");
    expect(second.problems).toEqual([problem]);
    expect(api.requests).toEqual([
      { method: "POST", url: "/api/monitoring/install/plan", body },
      { method: "POST", url: "/api/monitoring/install/plan", body },
    ]);
  });

  it("a refused plan rejects with the server's words", async () => {
    installFakeMonitoringApi({ install: { plans: [{ error: { message: "That cluster isn't connected to OmniKrux any more." }, status: 404 }] } });
    const err = await planInstall({ cluster_id: "gone", components: ["logs"] }).catch((e: unknown) => e);
    expect(failure(err)).toBe("That cluster isn't connected to OmniKrux any more.");
  });

  it("fake install API records requests", async () => {
    const uninstall = plan({ plan_id: "u1", action: "uninstall", apply_label: "Uninstall", title: "Uninstall monitoring tools from monitoring" });
    const api = installFakeMonitoringApi({
      install: {
        status: { c1: status },
        uninstallPlans: [uninstall],
        contacts: { c1: { kind: "done", contacts: { state: "in_sync", message: null, applied_at: null, contact_points: 1, rules: 2 } } },
        probe: { "http://192.0.2.10:9090": { ok: true, version: "3.5.0", message: null } },
      },
    });
    // Unavailable by default, with the backend's words.
    const tools = await installTools();
    expect(tools.available).toBe(false);
    expect(tools.message).toMatch(/^Installing needs Helm/);
    expect(await installStatus("c1")).toEqual({ ...status, tools });
    expect(failure(await installStatus("c9").catch((e: unknown) => e))).toBe("That cluster isn't connected to OmniKrux any more.");
    expect(await planUninstall("c1", { delete_data: true })).toEqual(uninstall);
    expect(await syncContacts("c1")).toMatchObject({ kind: "done", contacts: { state: "in_sync" } });
    expect(failure(await syncContacts("c2").catch((e: unknown) => e))).toBe("OmniKrux hasn't installed anything in this cluster.");
    const generated = await generateFiles({ kind: "docker", address: "192.0.2.10", retention_days: 7 });
    expect(generated.kind).toBe("docker");
    expect(generated.files[0].name).toBe("docker-compose.yml");
    const probed = await probeTools({ tools: [{ type: "prometheus", url: "http://192.0.2.10:9090" }, { type: "loki", url: "http://192.0.2.10:3100" }] });
    expect(probed.results).toEqual([
      { type: "prometheus", url: "http://192.0.2.10:9090", ok: true, version: "3.5.0", message: null },
      { type: "loki", url: "http://192.0.2.10:3100", ok: false, version: null, message: "Nothing answered at that address." },
    ]);
    expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /api/monitoring/install/tools",
      "GET /api/monitoring/install/clusters/c1",
      "GET /api/monitoring/install/clusters/c9",
      "POST /api/monitoring/install/clusters/c1/uninstall/plan",
      "POST /api/monitoring/install/clusters/c1/contacts/sync",
      "POST /api/monitoring/install/clusters/c2/contacts/sync",
      "POST /api/monitoring/install/generate",
      "POST /api/monitoring/install/probe",
    ]);
    expect(api.requests[3].body).toEqual({ delete_data: true });
  });

  it("a probe can be aborted", async () => {
    installFakeMonitoringApi();
    const ctl = new AbortController();
    const fetch = vi.mocked(globalThis.fetch);
    await probeTools({ tools: [{ type: "alertmanager", url: "http://192.0.2.10:9093" }] }, ctl.signal);
    expect(fetch.mock.calls[0][1]?.signal).toBe(ctl.signal);
  });

  it("the hooks read under monitoring/install, and none while no cluster is picked", async () => {
    const api = installFakeMonitoringApi({ install: { status: { c1: status } } });
    const client = newClient();
    const tools = renderHook(() => useInstallTools(), { wrapper: wrapper(client) });
    await waitFor(() => expect(tools.result.current.data?.available).toBe(false));
    const none = renderHook(() => useInstallStatus(null), { wrapper: wrapper(client) });
    expect(none.result.current.fetchStatus).toBe("idle");
    const one = renderHook(() => useInstallStatus("c1", { refetchInterval: 60_000 }), { wrapper: wrapper(client) });
    await waitFor(() => expect(one.result.current.data?.cluster_name).toBe("kind-dev"));
    expect(installKeys.status("c1")).toEqual(["monitoring", "install", "status", "c1"]);
    expect(client.getQueryData(["monitoring", "install", "tools"])).toBeTruthy();
    expect(api.requests.filter((r) => r.url.includes("/clusters/")).map((r) => r.url)).toEqual(["/api/monitoring/install/clusters/c1"]);
  });
});
