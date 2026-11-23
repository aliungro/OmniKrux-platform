import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateMonitoring } from "../api/hooks";
import type { ProjectOut } from "../api/types";
import { NETWORK_MESSAGE, UNREADABLE_ANSWER } from "../api/query";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { emptyAlertsState, type FakeRefusal } from "../test/fakeAlertsApi";
import {
  AlertRequestError, alertOverview, createContactPoint, createRule, deleteRule, dryRunAlert, expireSilence, getRule, listContactPoints,
  listRules, ruleDeleteReview, ruleRefs, saveRule, syncTarget, testUnsavedContactPoint, updateContactPoint, useAlertOverview, useCreateRule,
  alertsKeys, refreshAlerts, useDryRun, useRules, type DryRunIn, type RuleIn, type RuleOut, type TargetOut,
} from "./api";

afterEach(() => vi.unstubAllGlobals());

const ruleIn = (name: string): RuleIn => ({
  name, scope: { kind: "project", id: "p1" }, source: { type: "prometheus", id: null }, expr: "up",
  condition: { of: "each", op: "above", threshold: 1, for: "5m", every: "1m" }, severity: "warning", message: "",
  contact_point_ids: [], engine: "omnikrux", channel: null,
});

const dryIn: DryRunIn = {
  scope: { kind: "project", id: "p1" }, source: { type: "prometheus", id: null }, expr: "up", of: "each", op: "above",
  threshold: 1, for: "5m", every: "1m",
};

async function refused(p: Promise<unknown>): Promise<AlertRequestError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AlertRequestError);
  return err as AlertRequestError;
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
}
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

const project: ProjectOut = { id: "p1", name: "Shop", kind: "custom", cluster_id: null, cluster_name: null, cluster_provider: null, links: [], group_ids: [], created_at: "", updated_at: "" };

describe("alerts client", () => {
  it("creates, reads, saves and deletes a rule", async () => {
    const api = installFakeMonitoringApi({ projects: [{ ...project }] });
    const made = await createRule(ruleIn("Slow"));
    expect(made.rule).toMatchObject({ name: "Slow", version: 1, scope: { kind: "project", id: "p1", name: "Shop" } });
    expect((await listRules()).map((r) => r.id)).toEqual([made.rule!.id]);
    expect(await listRules({ kind: "group", id: "g9" })).toEqual([]);
    expect((await getRule(made.rule!.id)).name).toBe("Slow");
    const saved = await saveRule(made.rule!.id, { ...ruleIn("Slower"), base_version: 1 });
    expect(saved.rule).toMatchObject({ name: "Slower", version: 2 });
    const review = await ruleDeleteReview(made.rule!.id);
    expect(await deleteRule(made.rule!.id, review.token)).toEqual({ rule: null, changes: [] });
    expect(api.state.rules).toEqual([]);
    expect(api.requests.map((r) => `${r.method} ${r.url}`)).toContain("DELETE /api/monitoring/alerts/rules/r1?token=review-token");
  });

  it("reads a rule conflict with the current version", async () => {
    installFakeMonitoringApi({ projects: [{ ...project }] });
    const made = await createRule(ruleIn("Slow"));
    const err = await refused(saveRule(made.rule!.id, { ...ruleIn("Slow"), base_version: 7 }));
    expect(err).toMatchObject({ status: 409, code: "rule_changed", currentVersion: 1, field: null });
    expect(err.message).toBe("This rule was changed somewhere else since you opened it (version 1). Open it again.");
    const bad = await refused(createRule({ ...ruleIn("  "), name: "  " }));
    expect(bad).toMatchObject({ status: 422, code: "invalid_rule", field: "name" });
  });

  it("reads both error shapes into one failure", async () => {
    const answer = (body: unknown, status: number) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", answer({ detail: { code: "rule_changed", message: "Changed.", current_version: 4 } }, 409));
    expect(await refused(getRule("r1"))).toMatchObject({ code: "rule_changed", message: "Changed.", currentVersion: 4 });
    // The pipeline's sync route: plain words.
    vi.stubGlobal("fetch", answer({ detail: "Another change to that object is in progress." }, 409));
    expect(await refused(syncTarget("t1"))).toMatchObject({ status: 409, code: "bad_request", message: "Another change to that object is in progress." });
    // A validation list, and a secret that must be entered again.
    vi.stubGlobal("fetch", answer({ detail: [{ type: "secret_needed", loc: ["body", "secrets", "url"], msg: "Enter the URL again." }] }, 422));
    expect(await refused(createContactPoint({ name: "x", type: "slack" }))).toMatchObject({ code: "bad_request", message: "Enter the URL again.", field: "secrets.url" });
    vi.stubGlobal("fetch", answer("nonsense", 500));
    expect((await refused(getRule("r1"))).message).toBe(UNREADABLE_ANSWER);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")));
    expect(await refused(alertOverview())).toMatchObject({ status: 0, code: "network", message: NETWORK_MESSAGE });
  });

  it("the dry run answers a refusal with its words, and a project that failed in its own error", async () => {
    const down: FakeRefusal = { status: 502, error: { code: "unreachable", message: "No project's source answered. Try again." } };
    const api = installFakeMonitoringApi({ dryRun: down });
    const err = await refused(dryRunAlert(dryIn));
    expect(err).toMatchObject({ status: 502, code: "unreachable", message: "No project's source answered. Try again." });
    api.state.dryRun = {
      start: 0, end: 21600, step: 60, fired: 0, firing_now: false, periods: [], candidates: [], took_ms: 3,
      projects: [{ project_id: "p1", project_name: "Shop", fired: 0, firing_now: false, periods: [], series: 0, error: { code: "timeout", message: "Took too long." } }],
    };
    const out = await dryRunAlert(dryIn);
    expect(out.projects[0].error).toEqual({ code: "timeout", message: "Took too long." });
    expect(api.requests.at(-1)?.body).toMatchObject({ expr: "up", for: "5m" });
  });

  it("a delete review without alert lists reads as empty", () => {
    expect(ruleRefs(undefined)).toEqual([]);
    expect(ruleRefs([{ id: "r1", name: "Slow" }])).toEqual([{ id: "r1", name: "Slow" }]);
  });

  it("a target that is loading carries its words and an instance may have no value", async () => {
    const target = {
      id: "t1", project_id: "p1", project_name: "Shop", engine: "tool", tool: "loki_ruler", where: "in Loki", engine_note: null,
      state: "waiting", state_since: "2026-01-01T00:00:00Z", last_eval_at: null, message: "Waiting for the ruler to load it.",
      eval_expr: "x", rule_text: "x", tool_state: null, tool_message: null, leaving: false,
      instances: [{ labels: {}, state: "pending", active_since: "2026-01-01T00:00:00Z", fired_at: null, value: null, silenced: false, message: null }],
    } satisfies TargetOut;
    const rule = { id: "r1", name: "Slow", targets: [target], state: "waiting" } as unknown as RuleOut;
    installFakeMonitoringApi({ rules: [rule] });
    const got = await getRule("r1");
    expect(got.targets[0]).toMatchObject({ state: "waiting", message: "Waiting for the ruler to load it." });
    expect(got.targets[0].instances[0].value).toBeNull();
  });

  it("a silence of an Alertmanager is ended with its source", async () => {
    const api = installFakeMonitoringApi();
    await refused(expireSilence("alertmanager", "nope", "s1"));
    expect(api.requests.at(-1)).toMatchObject({ method: "DELETE", url: "/api/monitoring/alerts/silences/alertmanager/nope?source_id=s1" });
  });
});

describe("alerts hooks", () => {
  it("the overview defaults to nothing firing and refetches", async () => {
    installFakeMonitoringApi();
    const { result } = renderHook(() => useAlertOverview(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(emptyAlertsState().overview);
    expect(result.current.data?.engine).toMatchObject({ enabled: true, running: true, behind: 0 });
  });

  it("keys alerts reads under monitoring/alerts and a mutation re-reads them", async () => {
    installFakeMonitoringApi({ projects: [{ ...project }] });
    const client = newClient();
    const { result } = renderHook(() => ({ rules: useRules(), create: useCreateRule() }), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.rules.isSuccess).toBe(true));
    expect(client.getQueryCache().getAll().map((q) => q.queryKey.slice(0, 3))).toContainEqual(["monitoring", "alerts", "rules"]);
    await act(async () => { await result.current.create.mutateAsync(ruleIn("Slow")); });
    await waitFor(() => expect(result.current.rules.data).toHaveLength(1));
  });

  it("the dry run waits for a body and is not retried", async () => {
    const down: FakeRefusal = { status: 504, error: { code: "timeout", message: "The run took too long." } };
    const api = installFakeMonitoringApi({ dryRun: down });
    const client = new QueryClient();
    const { result, rerender } = renderHook(({ body }: { body: DryRunIn | null }) => useDryRun(body), {
      wrapper: wrapper(client), initialProps: { body: null as DryRunIn | null },
    });
    expect(result.current.fetchStatus).toBe("idle");
    rerender({ body: dryIn });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 504, message: "The run took too long." });
    expect(api.requests.filter((r) => r.url.endsWith("/dry-run"))).toHaveLength(1);
  });
});

describe("contact points", () => {
  it("never leave a secret in a query or mutation cache", async () => {
    const api = installFakeMonitoringApi();
    const client = newClient();
    const secret = "https://hooks.example.test/T000/B000/not-in-a-cache";
    const made = await createContactPoint({ name: "Ops", type: "slack", secrets: { webhook_url: secret } });
    expect(made.secrets_set).toEqual(["webhook_url"]);
    await updateContactPoint(made.id, { secrets: { webhook_url: secret } });
    expect(await testUnsavedContactPoint({ name: "Ops", type: "slack", secrets: { webhook_url: secret } })).toMatchObject({ ok: true });
    await invalidateMonitoring(client);
    const { result } = renderHook(() => useRules(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(await listContactPoints()).toHaveLength(1);
    const caches = JSON.stringify([client.getQueryCache().getAll().map((q) => [q.queryKey, q.state.data]), client.getMutationCache().getAll()]);
    expect(caches).not.toContain(secret);
    // The fake records what it was sent; the answers hold only the names.
    expect(JSON.stringify(api.state.contactPoints)).not.toContain(secret);
  });
});

describe("refreshing after an alerts change", () => {
  it("reads Monitoring and the audit log again, but leaves an open dry run alone", async () => {
    const client = newClient();
    const body: DryRunIn = {
      scope: { kind: "project", id: "p1" }, source: { type: "prometheus", id: null }, expr: "up", of: "each", op: "above",
      threshold: 1, for: "5m", every: "1m",
    };
    client.setQueryData(alertsKeys.dryRun(body), { fired: 0 });
    client.setQueryData(alertsKeys.rules(), []);
    client.setQueryData(["monitoring", "tree"], {});
    client.setQueryData(["audit", "list"], []);
    await refreshAlerts(client);
    expect(client.getQueryState(alertsKeys.dryRun(body))?.isInvalidated).toBe(false);
    expect(client.getQueryState(alertsKeys.rules())?.isInvalidated).toBe(true);
    expect(client.getQueryState(["monitoring", "tree"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["audit", "list"])?.isInvalidated).toBe(true);
  });
});
