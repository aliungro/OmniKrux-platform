import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { Plan } from "../../../api/types";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { renderMonitoringApp } from "../../test/renderMonitoringApp";
import { InstallReviewHost } from "../../install/InstallReviewHost";
import { useInstallReviews, type InstallOutcome, type InstallReviews } from "../../install/useInstallReviews";
import { alertsKeys, type AlertChangeOut, type SyncOut, type TargetOut } from "../api";
import { OK_STATUS_MS, ToolReviewHost } from "./ToolReviewHost";
import { useToolReviews, type ToolReviewResult, type ToolReviews } from "./useToolReviews";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const plan = (over: Partial<Plan> = {}): Plan => ({
  plan_id: "plan-1",
  action: "create",
  target: { cluster_id: "c1", kind_key: "prometheusrules.monitoring.coreos.com", namespace: "monitoring", name: "omnikrux-slow-1a2b" },
  kind: "PrometheusRule",
  cluster: { id: "c1", name: "kind-dev", provider: "kind", environment: "development" },
  title: "Create PrometheusRule omnikrux-slow-1a2b",
  summary: ["Create PrometheusRule monitoring/omnikrux-slow-1a2b with 1 rule."],
  warnings: [],
  blocked: [],
  diff: null,
  confirm_text: null,
  apply_label: "Create",
  expires_at: "2026-11-23T10:05:00Z",
  ...over,
});

const change = (over: Partial<AlertChangeOut> = {}): AlertChangeOut => ({
  target_id: "t1", rule_id: "r1", rule_name: "Slow checkout", project_id: "p1", project_name: "Shop", kind: "review", message: null, ...over,
});

const target = (over: Partial<TargetOut> = {}): TargetOut => ({
  id: "t1", project_id: "p1", project_name: "Shop", engine: "tool", tool: "prometheus_rule", where: "kind-dev", engine_note: null,
  state: "waiting", state_since: "2026-01-01T00:00:00Z", last_eval_at: null, message: null, eval_expr: "", rule_text: "",
  tool_state: "in_sync", tool_message: null, leaving: false, instances: [], ...over,
});

const review = (p: Plan): SyncOut => ({ kind: "review", plan: p });

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/** The pipeline's routes: each apply answers the next of `applies`; discards are counted. */
function pipeline(applies: { status: number; body: unknown }[]) {
  const seen: string[] = [];
  const fallback = (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/apply")) {
      const next = applies.length > 1 ? applies.shift()! : applies[0];
      return json(next.body, next.status);
    }
    if (method === "DELETE" && url.startsWith("/api/actions/")) return Promise.resolve(new Response(null, { status: 204 }));
    return json({ detail: "Not found" }, 404);
  };
  return { seen, fallback };
}

const APPLIED = { status: 200, body: { outcome: "succeeded", message: "Created PrometheusRule omnikrux-slow-1a2b.", job_id: null, audit_id: 1 } };

/** A page that starts reviews: its button is where the keyboard should come back to. */
function Probe({ changes, onQueue }: { changes: AlertChangeOut[]; onQueue?: (q: ToolReviews) => void }) {
  const reviews = useToolReviews();
  const from = useRef<HTMLButtonElement>(null);
  const [result, setResult] = useState<ToolReviewResult | null>(null);
  onQueue?.(reviews);
  return (
    <div>
      <button ref={from} type="button" onClick={() => reviews.enqueue(changes, { focus: from.current })}>Save</button>
      <button type="button" onClick={() => void reviews.reviewTarget("t1", "Slow checkout", "Shop").then(setResult)}>Review</button>
      <p data-testid="pending">{reviews.pending}</p>
      <p data-testid="result">{result ?? ""}</p>
    </div>
  );
}

function renderHost(changes: AlertChangeOut[], onQueue?: (q: ToolReviews) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = render(
    <QueryClientProvider client={client}>
      <main tabIndex={-1}>
        <ToolReviewHost>
          <Probe changes={changes} onQueue={onQueue} />
        </ToolReviewHost>
      </main>
    </QueryClientProvider>,
  );
  return { ...out, client };
}

const status = () => screen.getByTestId("tool-review-status").querySelector('[role="status"]') as HTMLElement;
const syncs = (api: FakeMonitoringApi) => api.requests.filter((r) => r.method === "POST" && r.url.endsWith("/sync")).map((r) => r.url);

describe("tool review queue", () => {
  it("two review changes open one after the other", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline([APPLIED]);
    installFakeMonitoringApi({
      syncAnswers: {
        t1: review(plan()),
        t2: review(plan({ plan_id: "plan-2", title: "Create PrometheusRule omnikrux-errors-3c4d" })),
      },
    }, fallback);
    renderHost([change(), change({ target_id: "t2", rule_name: "Errors", project_name: "Payments" }), change({ target_id: "t3", kind: "written" })]);
    await user.click(screen.getByRole("button", { name: "Save" }));

    const first = await screen.findByRole("dialog");
    expect(within(first).getByRole("heading").textContent).toBe("Create PrometheusRule omnikrux-slow-1a2b");
    expect(screen.getByTestId("pending").textContent).toBe("2");
    // Only one review at a time.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    // A create opens on its action button.
    expect(document.activeElement).toBe(within(first).getByRole("button", { name: "Create" }));

    await user.click(within(first).getByRole("button", { name: "Cancel" }));
    expect(status().textContent).toBe(`"Slow checkout" isn't applied in Shop's cluster yet. Review it from its panel or the Alerts page.`);
    const second = await screen.findByRole("dialog");
    expect(within(second).getByRole("heading").textContent).toBe("Create PrometheusRule omnikrux-errors-3c4d");
    expect(document.activeElement).toBe(within(second).getByRole("button", { name: "Create" }));
    expect(document.activeElement).not.toBe(document.body);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("pending").textContent).toBe("0");
    // A "written" change needs no review.
    expect(status().querySelectorAll("li")).toHaveLength(2);
  });

  it("apply in the queue announces it", async () => {
    const user = userEvent.setup();
    const { seen, fallback } = pipeline([APPLIED]);
    installFakeMonitoringApi({ syncAnswers: { t1: review(plan()) } }, fallback);
    const { client } = renderHost([change()]);
    client.setQueryData(alertsKeys.overview, { counts: {} });
    client.setQueryData(alertsKeys.dryRun(null), { fired: 0 });
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(status().textContent).toBe(`Applied "Slow checkout" in Shop's cluster.`);
    expect(seen).toContain("POST /api/actions/plan-1/apply");
    // An applied review is used up: nothing to discard.
    expect(seen).not.toContain("DELETE /api/actions/plan-1");
    // The alerts lists are read again; an open dry run isn't.
    expect(client.getQueryState(alertsKeys.overview)?.isInvalidated).toBe(true);
    expect(client.getQueryState(alertsKeys.dryRun(null))?.isInvalidated).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
  });

  it("a removal says Removed, and a status of successes goes by itself and with the page", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { fallback } = pipeline([APPLIED]);
      installFakeMonitoringApi({ syncAnswers: { t1: review(plan({ action: "delete", apply_label: "Delete" })) } }, fallback);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const host = (place: string) => (
        <QueryClientProvider client={client}>
          <main tabIndex={-1}><ToolReviewHost place={place}><Probe changes={[change()]} /></ToolReviewHost></main>
        </QueryClientProvider>
      );
      const { rerender } = render(host("a"));
      await user.click(screen.getByRole("button", { name: "Save" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(status().textContent).toBe(`Removed "Slow checkout" from Shop's cluster.`));
      act(() => { vi.advanceTimersByTime(OK_STATUS_MS + 10); });
      expect(status().textContent).toBe("");
      expect(document.activeElement).not.toBe(document.body);

      // Again, then the workspace moves to another page: the successes go with it.
      installFakeMonitoringApi({ syncAnswers: { t1: review(plan()) } }, pipeline([APPLIED]).fallback);
      await user.click(screen.getByRole("button", { name: "Save" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(status().textContent).toBe(`Applied "Slow checkout" in Shop's cluster.`));
      rerender(host("b"));
      expect(status().textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cancelled review leaves the rule not applied with Review", async () => {
    const user = userEvent.setup();
    const { seen, fallback } = pipeline([APPLIED]);
    installFakeMonitoringApi({ syncAnswers: { t1: review(plan()) } }, fallback);
    const { client } = renderHost([change()]);
    client.setQueryData(alertsKeys.rules(), []);
    await user.click(screen.getByRole("button", { name: "Save" }));
    const dialog = await screen.findByRole("dialog");
    // Somewhere else on the page now; the queue still returns to where the save asked.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(status().textContent).toBe(`"Slow checkout" isn't applied in Shop's cluster yet. Review it from its panel or the Alerts page.`);
    expect(seen).toContain("DELETE /api/actions/plan-1");
    expect(seen.some((r) => r.endsWith("/apply"))).toBe(false);
    expect(client.getQueryState(alertsKeys.rules())?.isInvalidated).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
  });

  it("between reviews and after the queue focus never rests on body", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline([APPLIED]);
    installFakeMonitoringApi({ syncAnswers: { t1: review(plan()), t2: review(plan({ plan_id: "plan-2" })) } }, fallback);
    // The second sync waits until the test lets it answer.
    const fake = globalThis.fetch;
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/t2/sync")) await held;
      return fake(url, init);
    });
    let queue: ToolReviews | null = null;
    renderHost([], (q) => { queue = q; });
    const back = screen.getByRole("button", { name: "Review" });
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    act(() => queue!.enqueue([change(), change({ target_id: "t2" })], { focus: back }));
    await screen.findByRole("dialog");
    // The element focused when the run started goes away while the review is open.
    opener.remove();
    await user.keyboard("{Escape}");
    // Between reviews the keyboard waits on the place the run returns to, never on <body>.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(back));
    release();
    const second = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(within(second).getByRole("button", { name: "Create" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(back));
  });

  it("a sync error is announced and the queue goes on", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline([APPLIED]);
    const api = installFakeMonitoringApi({
      syncAnswers: {
        t1: { status: 409, error: { message: "Another change to this cluster is under way. Try again in a moment." } },
        t2: review(plan({ plan_id: "plan-2" })),
      },
    }, fallback);
    renderHost([
      change(), change({ target_id: "t2", rule_name: "Errors" }),
      change({ target_id: "t9", rule_name: "Logs", kind: "failed", message: "The ruler refused the rule.", tool: "loki_ruler" }),
      change({ target_id: "t8", rule_name: "Latency", kind: "failed", message: null, tool: "prometheus_rule" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Save" }));

    const dialog = await screen.findByRole("dialog");
    const lines = [...status().querySelectorAll("li")].map((li) => li.textContent);
    expect(lines).toEqual([
      `"Logs" couldn't be written to Loki: The ruler refused the rule.`,
      `"Latency" couldn't be applied in Shop's cluster: OmniKrux couldn't bring this rule up to date in the tool. Try again.`,
      `"Slow checkout" couldn't be applied in Shop's cluster: Another change to this cluster is under way. Try again in a moment.`,
    ]);
    expect(syncs(api)).toEqual(["/api/monitoring/alerts/targets/t1/sync", "/api/monitoring/alerts/targets/t2/sync"]);
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(status().textContent).toContain(`Applied "Errors" in Shop's cluster.`));
  });

  it("Review again swaps the plan", async () => {
    const user = userEvent.setup();
    const { seen, fallback } = pipeline([
      { status: 409, body: { detail: "This rule changed since you reviewed it. Review it again." } },
      APPLIED,
    ]);
    const api = installFakeMonitoringApi({ syncAnswers: { t1: review(plan()) } }, fallback);
    renderHost([change()]);
    await user.click(screen.getByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("This rule changed since you reviewed it. Review it again.");

    api.state.syncAnswers.t1 = review(plan({ plan_id: "plan-2", title: "Update PrometheusRule omnikrux-slow-1a2b", apply_label: "Update", action: "edit" }));
    await user.click(within(dialog).getByRole("button", { name: "Review again" }));
    expect(await within(screen.getByRole("dialog")).findByRole("heading", { name: "Update PrometheusRule omnikrux-slow-1a2b" })).toBeTruthy();
    expect(syncs(api)).toHaveLength(2);
    expect(seen).toContain("DELETE /api/actions/plan-1");

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(screen.getByTestId("result").textContent).toBe("applied"));
    expect(seen).toContain("POST /api/actions/plan-2/apply");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Review" }));
  });

  it("a done answer is skipped; a target the tool refused reads failed", async () => {
    const user = userEvent.setup();
    installFakeMonitoringApi({ syncAnswers: { t1: { kind: "done", target: target({ tool: "loki_ruler", tool_state: "failed", tool_message: "The ruler is read-only." }) } } });
    renderHost([]);
    await user.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(screen.getByTestId("result").textContent).toBe("failed"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(status().textContent).toBe(`"Slow checkout" couldn't be written to Loki: The ruler is read-only.`);
  });

  it("outside the Monitoring app the queue does nothing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let queue: ToolReviews | null = null;
    function Outside() {
      queue = useToolReviews();
      return null;
    }
    render(<Outside />);
    queue!.enqueue([change()]);
    await expect(queue!.reviewTarget("t1", "Slow checkout", "Shop")).resolves.toBe("cancelled");
    expect(queue!.pending).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the Monitoring app holds the queue and its status", () => {
    installFakeMonitoringApi();
    renderMonitoringApp();
    expect(screen.getByTestId("tool-review-status").querySelector('[role="status"]')).not.toBeNull();
  });
});

describe("contact points in the tool review queue", () => {
  /** The review of the contact points in the Alertmanager OmniKrux installed in kind-dev. */
  const contactsPlan = plan({
    plan_id: "plan-c", action: "edit", kind: "AlertmanagerConfig",
    target: { cluster_id: "c1", kind_key: "alertmanagerconfigs.monitoring.coreos.com", namespace: "monitoring", name: "omnikrux-contact-points" },
    title: "Update contact points in monitoring", summary: ["Routes 1 rule to 2 contact points."], apply_label: "Update",
  });
  const contacts = (over: Partial<AlertChangeOut> = {}): AlertChangeOut => change({
    target_id: "", rule_id: "", rule_name: "", project_id: "", project_name: "kind-dev", kind: "contacts", cluster_id: "c1", ...over,
  });
  const installStatus = () => screen.getByTestId("install-review-status").querySelector('[role="status"]') as HTMLElement;
  const heading = () => within(screen.getByRole("dialog")).getByRole("heading").textContent;

  /** Both hosts, nested as `MonitoringApp` nests them, around a page that asks the queue and the install reviews. */
  function renderBoth(changes: AlertChangeOut[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let install!: InstallReviews;
    let queue!: ToolReviews;
    function Page() {
      install = useInstallReviews();
      return <Probe changes={changes} onQueue={(q) => { queue = q; }} />;
    }
    render(
      <QueryClientProvider client={client}>
        <main tabIndex={-1}>
          <InstallReviewHost>
            <ToolReviewHost>
              <Page />
            </ToolReviewHost>
          </InstallReviewHost>
        </main>
      </QueryClientProvider>,
    );
    return { install: () => install, queue: () => queue };
  }

  it("a contacts change opens its review after the rule's review", async () => {
    const user = userEvent.setup();
    const { fallback, seen } = pipeline([APPLIED, { status: 200, body: { outcome: "succeeded", message: "Updated.", job_id: null, audit_id: 2 } }]);
    const api = installFakeMonitoringApi({
      syncAnswers: { t1: review(plan()) },
      install: { contacts: { c1: { kind: "review", plan: contactsPlan } } },
    }, fallback);
    renderBoth([change(), contacts()]);
    await user.click(screen.getByRole("button", { name: "Save" }));

    // The rule's review first, alone; the contact points aren't asked for while it is open.
    await screen.findByRole("dialog");
    expect(heading()).toBe("Create PrometheusRule omnikrux-slow-1a2b");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("pending").textContent).toBe("2");
    expect(api.requests.some((r) => r.url.endsWith("/install/clusters/c1/contacts/sync"))).toBe(false);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create" }));

    // Then the contact points of the Alertmanager OmniKrux installed, alone too.
    await waitFor(() => expect(heading()).toBe("Update contact points in monitoring"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByTestId("pending").textContent).toBe("1");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("0"));

    // Each host says its own: the rule's line, and the install reviews' contact points line.
    expect(status().textContent).toContain(`Applied "Slow checkout" in Shop's cluster.`);
    expect(installStatus().textContent).toContain("Contact points are up to date in kind-dev's Alertmanager.");
    expect(seen.filter((u) => u.endsWith("/apply"))).toHaveLength(2);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" })));
  });

  it("the contact points wait behind every rule of their batch, once per cluster", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline([APPLIED]);
    const api = installFakeMonitoringApi({
      syncAnswers: { t1: review(plan()), t2: review(plan({ plan_id: "plan-2", title: "Create PrometheusRule omnikrux-errors-3c4d" })) },
      install: { contacts: { c1: { kind: "review", plan: contactsPlan } } },
    }, fallback);
    renderBoth([contacts(), change(), contacts(), change({ target_id: "t2", rule_name: "Errors" })]);
    await user.click(screen.getByRole("button", { name: "Save" }));

    const titles: string[] = [];
    for (let i = 0; i < 3; i++) {
      await screen.findByRole("dialog");
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      const title = heading() ?? "";
      titles.push(title);
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("heading", { name: title })).toBeNull());
    }
    expect(titles).toEqual([
      "Create PrometheusRule omnikrux-slow-1a2b", "Create PrometheusRule omnikrux-errors-3c4d", "Update contact points in monitoring",
    ]);
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("0"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.requests.filter((r) => r.url.endsWith("/install/clusters/c1/contacts/sync"))).toHaveLength(1);
    expect(installStatus().textContent).toBe("Contact points in kind-dev's Alertmanager aren't updated yet. Review them from Monitoring tools.");
  });

  it("more batches while a cluster's contact points are under review queue one more review, not one each", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline([APPLIED]);
    const api = installFakeMonitoringApi({ install: { contacts: { c1: { kind: "review", plan: contactsPlan } } } }, fallback);
    const both = renderBoth([contacts()]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(heading()).toBe("Update contact points in monitoring"));
    act(() => {
      both.queue().enqueue([contacts()]);
      both.queue().enqueue([contacts()]);
    });
    expect(screen.getByTestId("pending").textContent).toBe("2");
    // The review under way, then the one queued behind it, and no third.
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("1"));
    await waitFor(() => expect(heading()).toBe("Update contact points in monitoring"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByTestId("pending").textContent).toBe("0"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.requests.filter((r) => r.url.endsWith("/install/clusters/c1/contacts/sync"))).toHaveLength(2);
  });

  it("a review either host is asked for waits while the other's review is open", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline([APPLIED]);
    installFakeMonitoringApi({
      syncAnswers: { t1: review(plan()) },
      install: { contacts: { c1: { kind: "review", plan: contactsPlan } } },
    }, fallback);
    const both = renderBoth([change()]);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("dialog");
    expect(heading()).toBe("Create PrometheusRule omnikrux-slow-1a2b");

    // Asked for straight from the install host while the rule's review is open: it waits its turn.
    let asked: Promise<InstallOutcome> | null = null;
    act(() => { asked = both.install().contacts("c1"); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(heading()).toBe("Update contact points in monitoring"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    // A rule's review asked for while the contact points' review is open waits for it to close.
    let again: Promise<ToolReviewResult> | null = null;
    act(() => { again = both.queue().reviewTarget("t1", "Slow checkout", "Shop"); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(heading()).toBe("Update contact points in monitoring");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await expect(asked!).resolves.toBe("cancelled");
    await waitFor(() => expect(heading()).toBe("Create PrometheusRule omnikrux-slow-1a2b"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await expect(again!).resolves.toBe("cancelled");
  });
});
