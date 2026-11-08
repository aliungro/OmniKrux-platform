// frontend/src/features/actions/useActions.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { Job, PlanRequest } from "../../api/types";
import { HttpError } from "../../api/http";
import { useActions, useJob } from "./useActions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

const scale: PlanRequest = {
  action: "scale",
  target: { cluster_id: "c1", kind_key: "deployments.apps", namespace: "demo", name: "web" },
  params: { replicas: 5 },
};

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  action: "drain",
  state: "running",
  message: "",
  total: 3,
  done: 0,
  blocked: [],
  started_at: "2026-11-08T10:00:00Z",
  finished_at: null,
  ...over,
});

describe("useActions", () => {
  it("plan posts the action, its target and params", async () => {
    const fetch = vi.fn(() => json({ plan_id: "p1" }));
    vi.stubGlobal("fetch", fetch);
    const { wrapper } = setup();
    const { result } = renderHook(() => useActions(), { wrapper });
    await result.current.plan(scale);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/actions/plan");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(scale);
  });

  it("apply sends {} without a confirmation, then reloads the audit log and the details", async () => {
    const fetch = vi.fn(() => json({ outcome: "succeeded", message: "Scaled.", job_id: null, audit_id: 7 }));
    vi.stubGlobal("fetch", fetch);
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useActions(), { wrapper });
    const out = await result.current.apply("p 1");
    expect(out.message).toBe("Scaled.");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/actions/p%201/apply");
    expect(init.body).toBe("{}");
    const keys = invalidate.mock.calls.map(([f]) => (f as { queryKey: unknown[] }).queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining(["audit", "resource-describe", "resource-yaml", "describe", "pod-yaml"]));
  });

  it("apply sends only the typed text", async () => {
    const fetch = vi.fn(() => json({ outcome: "succeeded", message: "Deleted.", job_id: null, audit_id: 8 }));
    vi.stubGlobal("fetch", fetch);
    const { wrapper } = setup();
    const { result } = renderHook(() => useActions(), { wrapper });
    await result.current.apply("p1", "web");
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBe('{"confirm_text":"web"}');
  });

  it("a refused apply keeps its status, so a conflict can be told apart", async () => {
    vi.stubGlobal("fetch", vi.fn(() => json({ detail: "Deployment web changed since you reviewed this change. Review it again." }, 409)));
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useActions(), { wrapper });
    const err = await result.current.apply("p1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("useJob", () => {
  it("polls every second until the job isn't running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answers = [job({ done: 1 }), job({ done: 2 }), job({ done: 3, state: "succeeded", message: "Drained kind-worker." })];
    const fetch = vi.fn(() => json(answers.shift() ?? job({ state: "succeeded" })));
    vi.stubGlobal("fetch", fetch);
    const { wrapper } = setup();
    const { result } = renderHook(() => useJob("j1"), { wrapper });
    await waitFor(() => expect(result.current.data?.done).toBe(1));
    expect(fetch.mock.calls[0]).toEqual(["/api/actions/jobs/j1"]);
    await act(async () => vi.advanceTimersByTime(1000));
    await waitFor(() => expect(result.current.data?.done).toBe(2));
    await act(async () => vi.advanceTimersByTime(1000));
    await waitFor(() => expect(result.current.data?.state).toBe("succeeded"));
    const calls = fetch.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(5000));
    expect(fetch.mock.calls.length).toBe(calls);
  });
});
