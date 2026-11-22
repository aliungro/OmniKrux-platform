import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failure } from "../../api/http";
import { NETWORK_MESSAGE, QueryFailure } from "../api/query";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { refreshAfterDashboardChange } from "../dashboards/api";
import { catalogOf, metric, projectOf, source } from "./fixtures";
import { getCatalog, useProjectCatalog, useRefreshCatalog } from "./api";
import { useOwnerCatalog } from "./merge";

afterEach(() => vi.unstubAllGlobals());

const wrapper = (client: QueryClient) => ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("getCatalog", () => {
  it("an unknown project reads That project no longer exists.", async () => {
    installFakeMonitoringApi();
    const err = await getCatalog("nope").catch((e) => e);
    expect(err).toBeInstanceOf(QueryFailure);
    expect(failure(err, "try again")).toBe("That project no longer exists.");
  });

  it("a network failure reads in words", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("x")));
    await expect(getCatalog("a")).rejects.toMatchObject({ message: NETWORK_MESSAGE, code: "network" });
  });

  it("the fake serves catalogs and records refresh", async () => {
    const catalog = catalogOf("a", source("s1", { metrics: [metric("up")] }));
    const api = installFakeMonitoringApi({ projects: [projectOf("a")], catalogs: { a: catalog } });
    expect(await getCatalog("a")).toEqual(catalog);
    await getCatalog("a", true);
    expect(api.requests.map((r) => r.url)).toEqual([
      "/api/monitoring/projects/a/catalog?refresh=false",
      "/api/monitoring/projects/a/catalog?refresh=true",
    ]);
  });
});

describe("catalog hooks", () => {
  const seed = () =>
    installFakeMonitoringApi({
      projects: [projectOf("a", "Shop"), projectOf("b", "Blog")],
      catalogs: {
        a: catalogOf("a", source("s1", { metrics: [metric("up", { labels: ["job"], series: 2 })] })),
        b: catalogOf("b", source("s2", { metrics: [metric("up", { labels: ["zone"], series: 3 })] })),
      },
    });

  it("reads a project's catalog once and keeps it", async () => {
    const api = seed();
    const client = newClient();
    const { result } = renderHook(() => useProjectCatalog("a"), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data?.project_id).toBe("a"));
    const second = renderHook(() => useProjectCatalog("a"), { wrapper: wrapper(client) });
    expect(second.result.current.data?.project_id).toBe("a");
    expect(api.requests).toHaveLength(1);
  });

  it("a group fetches each member separately and keeps project ids", async () => {
    const api = seed();
    const owner = {
      kind: "group" as const,
      group: { id: "g", name: "All", project_ids: ["a", "b"], created_at: "", updated_at: "" },
      members: [projectOf("a", "Shop"), projectOf("b", "Blog")],
    };
    const { result } = renderHook(() => useOwnerCatalog(owner), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.requests.map((r) => r.url).sort()).toEqual([
      "/api/monitoring/projects/a/catalog?refresh=false",
      "/api/monitoring/projects/b/catalog?refresh=false",
    ]);
    expect(result.current.catalog?.metrics[0]).toMatchObject({ name: "up", projectIds: ["a", "b"], sourceId: null, series: 5 });
    await act(() => result.current.refresh());
    expect(api.requests.filter((r) => r.url.endsWith("refresh=true"))).toHaveLength(2);
  });

  it("a project whose catalog failed reads in words", async () => {
    installFakeMonitoringApi({ projects: [projectOf("a")] });
    const owner = { kind: "project" as const, project: projectOf("a") };
    const { result } = renderHook(() => useOwnerCatalog(owner), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("That project no longer exists.");
    expect(result.current.catalog).toBeNull();
  });

  it("useRefreshCatalog keeps the answer", async () => {
    const api = seed();
    const client = newClient();
    const { result } = renderHook(() => useRefreshCatalog(), { wrapper: wrapper(client) });
    await act(() => result.current("a"));
    expect(client.getQueryData(["monitoring", "catalog", "a"])).toBeTruthy();
    expect(api.requests[0].url).toContain("refresh=true");
  });

  it("a dashboard save does not re-read catalogs", async () => {
    const api = seed();
    const client = newClient();
    const { result } = renderHook(() => useProjectCatalog("a"), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    await refreshAfterDashboardChange(client);
    expect(client.getQueryState(["monitoring", "catalog", "a"])?.isInvalidated).toBe(false);
    expect(api.requests).toHaveLength(1);
  });
});
