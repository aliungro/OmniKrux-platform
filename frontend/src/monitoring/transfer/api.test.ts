import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import {
  applyUpdate, commitImport, exportItem, newGrafanaDashboards, previewImport, TransferRequestError, useGrafanaConnections,
  useGrafanaDashboards, useOrigin, type GrafanaOut,
} from "./api";

afterEach(() => vi.unstubAllGlobals());

const wrapper = (client: QueryClient) => ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
const caught = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("transfer client", () => {
  it("transfer errors keep code, key and problems", async () => {
    installFakeMonitoringApi({
      transfer: {
        commits: {
          status: 409,
          detail: { code: "name_taken", message: 'A dashboard named "CPU" already exists.', key: "d-3", problems: [{ path: "title", message: "Taken." }, { nope: 1 }] },
        },
      },
    });
    const err = await caught(commitImport({ input: { kind: "text", text: "{}", via: "paste" }, dashboards: [{ key: "d-3", title: "CPU", digest: "x" }] }));
    expect(err).toBeInstanceOf(TransferRequestError);
    expect(err).toMatchObject({ status: 409, code: "name_taken", key: "d-3", problems: [{ path: "title", message: "Taken." }], currentVersion: null });
    expect((err as Error).message).toBe('A dashboard named "CPU" already exists.');
  });

  it("reads a version conflict, a plain detail and a validation list", async () => {
    installFakeMonitoringApi({
      transfer: {
        updates: { d1: { status: 409, detail: { code: "version_conflict", message: "Saved elsewhere.", key: null, problems: [], current_version: 4 } } },
      },
    });
    expect(await caught(applyUpdate("d1", { base_version: 3, digest: "x" }))).toMatchObject({ code: "version_conflict", currentVersion: 4 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Words." }), { status: 422 })));
    expect(await caught(exportItem("project", "p"))).toMatchObject({ code: "invalid_input", message: "Words." });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: [{ loc: ["body"], msg: "Field required" }] }), { status: 422 })));
    expect(await caught(exportItem("project", "p"))).toMatchObject({ message: "The request was refused: Field required." });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    expect(await caught(exportItem("project", "p"))).toMatchObject({ status: 502, message: expect.stringContaining("couldn't be read") });
  });

  it("a rejected fetch is a network error with the copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const err = await caught(exportItem("dashboard", "d1"));
    expect(err).toBeInstanceOf(TransferRequestError);
    expect(err).toMatchObject({ status: 0, code: "network", message: "OmniKrux didn't answer. Check that it's running, then try again." });
  });

  it("an abort passes through unchanged", async () => {
    const abort = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw abort; }));
    expect(await caught(previewImport({ input: { kind: "text", text: "{}", via: "paste" } }))).toBe(abort);
  });

  it("an unsaved token never enters the query cache", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = installFakeMonitoringApi({ transfer: { grafanaDashboards: { new: { items: [{ uid: "u1", title: "Overview", folder: null, tags: [] }], truncated: false } } } });
    const saved: GrafanaOut = {
      id: "gf9", name: "Main", reach: "url", url: "http://grafana.example.invalid", cluster_id: null, cluster_name: null, namespace: null, service: null,
      port: null, scheme: "http", path_prefix: "", auth: { type: "bearer", username: null, has_password: false, has_token: true },
      dashboards_imported: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    };
    api.state.transfer.grafana = [saved];
    api.state.transfer.grafanaDashboards.gf9 = { items: [], truncated: false };
    const connection = { reach: "url" as const, url: "http://grafana.example.invalid", auth: { type: "bearer" as const, token: "glsa_SECRET-13" } };
    const hooks = renderHook(() => ({ list: useGrafanaConnections(), dashboards: useGrafanaDashboards("gf9"), origin: useOrigin("d1") }), { wrapper: wrapper(client) });
    const found = await newGrafanaDashboards(connection);
    expect(found.items).toHaveLength(1);
    await previewImport({ input: { kind: "grafana", connection, uids: ["u1"] } }).catch(() => undefined);
    await commitImport({ input: { kind: "grafana", connection, uids: ["u1"] }, dashboards: [{ key: "u1", title: "Overview", digest: "x" }] }).catch(() => undefined);
    await waitFor(() => expect(hooks.result.current.list.data).toEqual([saved]));
    await waitFor(() => expect(hooks.result.current.origin.isSuccess).toBe(true));
    const cached = JSON.stringify(client.getQueryCache().getAll().map((q) => [q.queryKey, q.state.data]));
    const mutations = JSON.stringify(client.getMutationCache().getAll().map((m) => [m.options.mutationKey, m.state.variables, m.state.data]));
    expect(cached).not.toContain("glsa_SECRET-13");
    expect(mutations).not.toContain("glsa_SECRET-13");
    // The calls did carry it to the server, in the body only.
    expect(api.requests.some((r) => (JSON.stringify(r.body) ?? "").includes("glsa_SECRET-13"))).toBe(true);
    expect(api.requests.every((r) => !r.url.includes("glsa_SECRET-13"))).toBe(true);
    expect(client.getQueryCache().getAll().map((q) => q.queryKey)).toEqual(
      expect.arrayContaining([["monitoring", "grafana"], ["monitoring", "grafana", "gf9", "dashboards"], ["monitoring", "dashboard", "d1", "origin"]]),
    );
  });
});
