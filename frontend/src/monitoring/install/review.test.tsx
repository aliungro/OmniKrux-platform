import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { Job, Plan } from "../../api/types";
import { useMonitoringTree } from "../api/hooks";
import type { SourceOut } from "../api/types";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import type { InstallPlanOut, InstallSettingsOut } from "./api";
import { InstallProgress } from "./InstallProgress";
import { InstallReviewHost } from "./InstallReviewHost";
import { useInstallReviews, type InstallOutcome, type InstallReviews } from "./useInstallReviews";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SETTINGS: InstallSettingsOut = {
  namespace: "monitoring",
  retention_days: 15,
  persist: true,
  prometheus_storage: "20Gi",
  loki_storage: "10Gi",
  alertmanager_storage: "1Gi",
  prometheus: { cpu_request: "200m", memory_request: "1Gi", memory_limit: "2Gi" },
  alertmanager: { cpu_request: "20m", memory_request: "64Mi", memory_limit: "128Mi" },
  loki: { cpu_request: "100m", memory_request: "256Mi", memory_limit: "1Gi" },
  alloy: { cpu_request: "50m", memory_request: "128Mi", memory_limit: "256Mi" },
};

const plan = (over: Partial<Plan> = {}): Plan => ({
  plan_id: "plan-1",
  action: "install",
  target: { cluster_id: "c1", kind_key: "omnikrux.monitoring/install", namespace: null, name: "monitoring" },
  kind: "Monitoring tools",
  cluster: { id: "c1", name: "kind-install", provider: "kind", environment: "development" },
  title: "Install monitoring tools in monitoring",
  summary: [
    "Installs metrics and logs into kind-install, namespace monitoring. The cluster pulls the container images itself.",
    "Creates the namespace monitoring.",
  ],
  warnings: [],
  blocked: [],
  diff: null,
  confirm_text: null,
  apply_label: "Install",
  expires_at: "2026-11-24T10:05:00Z",
  ...over,
});

const planned = (over: Partial<Plan> = {}, more: Partial<InstallPlanOut> = {}): InstallPlanOut => ({
  plan: plan(over),
  settings: SETTINGS,
  problems: [],
  facts: { default_storage_class: "standard", kube_version: "1.31.0" },
  ...more,
});

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  action: "install",
  state: "running",
  message: "Installing omnikrux-kps with Helm…",
  total: 6,
  done: 2,
  blocked: [],
  started_at: "2026-11-24T10:00:00Z",
  finished_at: null,
  ...over,
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

type Answer = { status: number; body: unknown };
const STARTED: Answer = { status: 200, body: { outcome: "started", message: "Install started.", job_id: "j1", audit_id: 1 } };

/** The pipeline's routes: applies and job reads answer the next of their queue (the last repeats). */
function pipeline({ applies = [STARTED], jobs = [] as Answer[], cancels = [] as Answer[] } = {}) {
  const seen: string[] = [];
  const next = (q: Answer[]) => (q.length > 1 ? q.shift()! : q[0]);
  const fallback = (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push(`${method} ${url}`);
    if (url === "/api/clusters") return json([]);
    if (method === "POST" && url.endsWith("/cancel")) {
      const a = next(cancels);
      return json(a.body, a.status);
    }
    if (method === "POST" && url.endsWith("/apply")) {
      const a = next(applies);
      return json(a.body, a.status);
    }
    if (method === "GET" && url.startsWith("/api/actions/jobs/")) {
      const a = next(jobs);
      return json(a.body, a.status);
    }
    if (method === "DELETE" && url.startsWith("/api/actions/")) return Promise.resolve(new Response(null, { status: 204 }));
    return json({ detail: "Not found" }, 404);
  };
  return { seen, fallback };
}

/** A page that asks for reviews: its buttons are where the keyboard should come back to. */
function Probe({ onReviews }: { onReviews?: (r: InstallReviews) => void }) {
  const reviews = useInstallReviews();
  const install = useRef<HTMLButtonElement>(null);
  const [results, setResults] = useState<InstallOutcome[]>([]);
  const [gone, setGone] = useState(false);
  onReviews?.(reviews);
  const keep = (o: InstallOutcome) => setResults((r) => [...r, o]);
  return (
    <div>
      {!gone && (
        <button ref={install} type="button"
          onClick={() => void reviews.install({ clusterId: "c1", components: ["metrics", "logs"], focusAfter: install.current }).then(keep)}>
          Install tools
        </button>
      )}
      <button type="button" onClick={() => setGone(true)}>Hide install</button>
      <button type="button" onClick={(e) => void reviews.uninstall("c1", e.currentTarget).then(keep)}>Uninstall tools</button>
      <button type="button" onClick={(e) => void reviews.contacts("c1", e.currentTarget).then(keep)}>Contact points</button>
      <p data-testid="results">{results.join(",")}</p>
    </div>
  );
}

function renderHost(onReviews?: (r: InstallReviews) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const out = render(
    <QueryClientProvider client={client}>
      <main tabIndex={-1}>
        <InstallReviewHost>
          <Probe onReviews={onReviews} />
        </InstallReviewHost>
      </main>
    </QueryClientProvider>,
  );
  return { ...out, client, invalidate };
}

const status = () => screen.getByTestId("install-review-status").querySelector('[role="status"]') as HTMLElement;
const planBodies = (api: FakeMonitoringApi) =>
  api.requests.filter((r) => r.method === "POST" && r.url === "/api/monitoring/install/plan").map((r) => r.body as Record<string, unknown>);
const results = () => screen.getByTestId("results").textContent;

describe("install review", () => {
  it("the install review opens on Install with the plan's lines", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline();
    const api = installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Install monitoring tools in monitoring");
    expect(within(dialog).getByText("Creates the namespace monitoring.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Install" }));
    // The settings read as one line, closed.
    const toggle = within(dialog).getByRole("button", { name: "Settings" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(dialog).getByText("Namespace monitoring · keeps data 15 days · on volumes")).toBeTruthy();
    expect(within(dialog).queryByRole("textbox", { name: "Namespace" })).toBeNull();
    expect(planBodies(api)).toEqual([{ cluster_id: "c1", components: ["metrics", "logs"] }]);

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect((within(dialog).getByRole("textbox", { name: "Namespace" }) as HTMLInputElement).value).toBe("monitoring");
    expect((within(dialog).getByRole("spinbutton", { name: "Keep data for" }) as HTMLInputElement).value).toBe("15");
    const table = within(dialog).getByRole("table", { name: "Resources" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["CPU request", "Memory request", "Memory limit"]);
    expect(within(table).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["Prometheus", "Alertmanager", "Loki", "Grafana Alloy"]);
    expect((within(table).getByRole("textbox", { name: "Grafana Alloy Memory limit" }) as HTMLInputElement).value).toBe("256Mi");
  });

  it("settings open on a problem and focus its field", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline();
    installFakeMonitoringApi({
      install: {
        plans: [planned({ blocked: ["Fix the settings first."] }, {
          settings: { ...SETTINGS, retention_days: 400 },
          problems: [{ field: "retention_days", message: "Keep data for 1 to 90 days." }],
        })],
      },
    }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Settings" }).getAttribute("aria-expanded")).toBe("true");
    const days = within(dialog).getByRole("spinbutton", { name: "Keep data for" });
    await waitFor(() => expect(document.activeElement).toBe(days));
    expect(days.getAttribute("aria-invalid")).toBe("true");
    const hint = document.getElementById(days.getAttribute("aria-describedby")!);
    expect(hint?.textContent).toBe("Keep data for 1 to 90 days.");
  });

  it("update review plans again and swaps the plan", async () => {
    const user = userEvent.setup();
    const { seen, fallback } = pipeline();
    const api = installFakeMonitoringApi({
      install: {
        plans: [
          planned(),
          planned({ plan_id: "plan-2", summary: ["Installs metrics and logs into kind-install, namespace monitoring.", "Keeps data for 30 days."] },
            { settings: { ...SETTINGS, retention_days: 30 } }),
        ],
      },
    }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Settings" }));
    const days = within(dialog).getByRole("spinbutton", { name: "Keep data for" });
    await user.clear(days);
    await user.type(days, "30");
    // Not reviewed yet: said, and the one line still reads the plan's settings.
    expect(within(dialog).getByText("Not in this review yet. Update review to use them.")).toBeTruthy();
    expect(within(dialog).getByText("Namespace monitoring · keeps data 15 days · on volumes")).toBeTruthy();

    await user.keyboard("{Enter}");
    await within(dialog).findByText("Keeps data for 30 days.");
    expect(within(dialog).getByText("Namespace monitoring · keeps data 30 days · on volumes")).toBeTruthy();
    expect(within(dialog).queryByText("Not in this review yet. Update review to use them.")).toBeNull();
    const bodies = planBodies(api);
    expect(bodies).toHaveLength(2);
    expect((bodies[1].settings as Record<string, unknown>).retention_days).toBe(30);
    expect((bodies[1].settings as Record<string, unknown>).namespace).toBe("monitoring");
    expect(seen).toContain("DELETE /api/actions/plan-1");
    // The keyboard stays in the field it was in.
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("spinbutton", { name: "Keep data for" })));
  });

  it("review again after an expired plan keeps the edited settings", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline({ applies: [{ status: 404, body: { detail: "That review expired. Review it again." } }, STARTED] });
    const api = installFakeMonitoringApi({
      install: { plans: [planned(), planned({ plan_id: "plan-2" }, { settings: { ...SETTINGS, namespace: "tools" } }), planned({ plan_id: "plan-3" }, { settings: { ...SETTINGS, namespace: "tools" } })] },
    }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Settings" }));
    const ns = within(dialog).getByRole("textbox", { name: "Namespace" });
    await user.clear(ns);
    await user.type(ns, "tools");
    await user.click(within(dialog).getByRole("button", { name: "Update review" }));
    await within(dialog).findByText("Namespace tools · keeps data 15 days · on volumes");

    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("That review expired. Review it again.");
    await user.click(within(dialog).getByRole("button", { name: "Review again" }));
    await waitFor(() => expect(planBodies(api)).toHaveLength(3));
    expect((planBodies(api)[2].settings as Record<string, unknown>).namespace).toBe("tools");
  });

  it("review again sends the edits not sent yet and never drops them", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline({ applies: [{ status: 409, body: { detail: "That changed since you looked. Review it again." } }] });
    // The second plan comes back with the settings it had: the edits stay in the fields anyway.
    const api = installFakeMonitoringApi({ install: { plans: [planned(), planned({ plan_id: "plan-2" })] } }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Settings" }));
    const ns = within(dialog).getByRole("textbox", { name: "Namespace" });
    await user.clear(ns);
    await user.type(ns, "tools");
    expect(within(dialog).getByText("Not in this review yet. Update review to use them.")).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await within(dialog).findByRole("alert");
    await user.click(within(dialog).getByRole("button", { name: "Review again" }));
    await waitFor(() => expect(planBodies(api)).toHaveLength(2));
    expect((planBodies(api)[1].settings as Record<string, unknown>).namespace).toBe("tools");
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
    expect((within(dialog).getByRole("textbox", { name: "Namespace" }) as HTMLInputElement).value).toBe("tools");
    expect(within(dialog).getByText("Not in this review yet. Update review to use them.")).toBeTruthy();
  });

  it("an install on production opens on the typed field", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline();
    installFakeMonitoringApi({
      install: {
        plans: [planned({
          confirm_text: "monitoring", warnings: ["This is a production cluster."],
          cluster: { id: "c1", name: "prod-east", provider: "aks", environment: "production" },
        })],
      },
    }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(within(dialog).getByRole("textbox", { name: "Type monitoring to confirm" }));
  });

  it("a days value that isn't a number is said under its field and not sent", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline();
    const api = installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Settings" }));
    const days = within(dialog).getByRole("spinbutton", { name: "Keep data for" });
    await user.clear(days);
    await user.click(within(dialog).getByRole("button", { name: "Update review" }));
    await waitFor(() => expect(document.activeElement).toBe(days));
    expect(document.getElementById(days.getAttribute("aria-describedby")!)?.textContent).toBe("Keep data for 1 to 90 days.");
    expect(planBodies(api)).toHaveLength(1);
  });

  it("an edited field drops its problem, and the days problem joins the plan's others", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline();
    installFakeMonitoringApi({
      install: {
        plans: [planned({ blocked: ["Fix the settings first."] }, {
          settings: { ...SETTINGS, namespace: "kube-system" },
          problems: [
            { field: "namespace", message: "Use a namespace of its own, not default or a kube- namespace." },
            { field: "loki.memory_limit", message: "Use memory like 256Mi or 1Gi." },
          ],
        })],
      },
    }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    const namespace = within(dialog).getByRole("textbox", { name: "Namespace" });
    const lokiLimit = within(dialog).getByRole("textbox", { name: "Loki Memory limit" });
    await waitFor(() => expect(document.activeElement).toBe(namespace));
    expect(namespace.getAttribute("aria-invalid")).toBe("true");
    expect(lokiLimit.getAttribute("aria-invalid")).toBe("true");

    // Days that aren't a number: said under the days, and the plan's other problems stay.
    const days = within(dialog).getByRole("spinbutton", { name: "Keep data for" });
    await user.clear(days);
    await user.click(within(dialog).getByRole("button", { name: "Update review" }));
    await waitFor(() => expect(document.activeElement).toBe(namespace));
    expect(days.getAttribute("aria-invalid")).toBe("true");
    expect(within(dialog).getByText("Keep data for 1 to 90 days.")).toBeTruthy();
    expect(within(dialog).getByText("Use a namespace of its own, not default or a kube- namespace.")).toBeTruthy();
    expect(lokiLimit.getAttribute("aria-invalid")).toBe("true");

    // Editing a field takes its problem away at once; the others stay until the next review.
    await user.clear(namespace);
    await user.type(namespace, "monitoring");
    expect(namespace.getAttribute("aria-invalid")).toBeNull();
    expect(within(dialog).queryByText("Use a namespace of its own, not default or a kube- namespace.")).toBeNull();
    expect(lokiLimit.getAttribute("aria-invalid")).toBe("true");
    expect(days.getAttribute("aria-invalid")).toBe("true");
    await user.type(days, "7");
    expect(days.getAttribute("aria-invalid")).toBeNull();
  });

  it("the storage checkbox explains why it is off", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline();
    installFakeMonitoringApi({
      install: { plans: [planned({}, { settings: { ...SETTINGS, persist: false }, facts: { default_storage_class: null, kube_version: "1.31.0" } })] },
    }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Namespace monitoring · keeps data 15 days · in memory only")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Settings" }));
    const box = within(dialog).getByRole("checkbox", { name: "Keep data on volumes" }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(box.title).toBe("This cluster has no default storage class.");
    expect(within(dialog).queryByRole("textbox", { name: "Loki" })).toBeNull();
  });
});

describe("install progress", () => {
  it("progress shows what holds it up and cancel asks first", async () => {
    const user = userEvent.setup();
    const blocked = job({ message: "Waiting for Prometheus to be ready (0 of 1)…", blocked: [{ namespace: "monitoring", name: "prometheus-omnikrux-0", message: "Pending: no node has enough memory." }] });
    const ended = job({ state: "cancelled", message: "Install cancelled while waiting for Prometheus to be ready. What was already applied stays as Helm left it. Install again to finish, or uninstall the tools.", finished_at: "2026-11-24T10:01:00Z" });
    const { seen, fallback } = pipeline({ jobs: [{ status: 200, body: blocked }], cancels: [{ status: 200, body: ended }] });
    installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));

    expect(await within(dialog).findByText("Waiting for Prometheus to be ready (0 of 1)…")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    const bar = within(dialog).getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("6");
    const waiting = within(dialog).getByRole("list", { name: "Waiting for" });
    expect(waiting.textContent).toContain("prometheus-omnikrux-0");
    expect(waiting.textContent).toContain("Pending: no node has enough memory.");
    expect(within(dialog).getByText("The install carries on if you close this. Follow it on Monitoring tools.")).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Cancel install" }));
    expect(within(dialog).getByText("Stop the install? What Helm already applied stays.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep going" }));
    expect(seen.some((x) => x.endsWith("/cancel"))).toBe(false);
    // Esc in the question keeps going; the dialog stays.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel install" }));

    await user.click(within(dialog).getByRole("button", { name: "Cancel install" }));
    await user.click(within(dialog).getByRole("button", { name: "Stop install" }));
    expect(await within(dialog).findByText(ended.message)).toBeTruthy();
    expect(seen).toContain("POST /api/actions/jobs/j1/cancel");
    expect(within(dialog).queryByRole("button", { name: "Cancel install" })).toBeNull();
    expect(document.activeElement).not.toBe(document.body);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(results()).toBe("cancelled");
    expect(status().textContent).toBe(ended.message);
  });

  it("a failed read takes Cancel away without dropping the keyboard", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline({
      jobs: [{ status: 200, body: job() }, { status: 500, body: { detail: "The server had a problem. Try again." } }, { status: 200, body: job() }],
    });
    installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await user.click(await within(dialog).findByRole("button", { name: "Cancel install" }));
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep going" }));

    await within(dialog).findByRole("alert", {}, { timeout: 3000 });
    expect(within(dialog).queryByRole("button", { name: "Keep going" })).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    // Read again: Cancel is back, the question isn't.
    expect(await within(dialog).findByRole("button", { name: "Cancel install" }, { timeout: 3000 })).toBeTruthy();
    expect(within(dialog).queryByText("Stop the install? What Helm already applied stays.")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("closing while it stops says it is stopping, and reading stops", async () => {
    const user = userEvent.setup();
    const { seen, fallback: base } = pipeline({ jobs: [{ status: 200, body: job() }] });
    const fallback = (url: string, init?: RequestInit) =>
      url.endsWith("/cancel") ? new Promise<Response>(() => {}) : base(url, init);
    installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await user.click(await within(dialog).findByRole("button", { name: "Cancel install" }));
    await user.click(within(dialog).getByRole("button", { name: "Stop install" }));
    await within(dialog).findByText("Stopping the install…");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(results()).toBe("started"));
    expect(status().textContent).toBe("Stopping the install in kind-install. Follow it on Monitoring tools.");
    const readsNow = seen.filter((x) => x.startsWith("GET /api/actions/jobs/")).length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(seen.filter((x) => x.startsWith("GET /api/actions/jobs/")).length).toBe(readsNow);
  });

  it("stopping says it waits for Helm", async () => {
    const user = userEvent.setup();
    let release: (r: Response) => void = () => {};
    const { fallback: base } = pipeline({ jobs: [{ status: 200, body: job() }] });
    const fallback = (url: string, init?: RequestInit) =>
      url.endsWith("/cancel") ? new Promise<Response>((r) => { release = r; }) : base(url, init);
    installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await user.click(await within(dialog).findByRole("button", { name: "Cancel install" }));
    await user.click(within(dialog).getByRole("button", { name: "Stop install" }));
    expect(await within(dialog).findByText("Stopping the install…")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    await act(async () => {
      release(new Response(JSON.stringify(job({ state: "cancelled", message: "Install cancelled." })), { status: 200, headers: { "content-type": "application/json" } }));
    });
    expect(await within(dialog).findByText("Install cancelled.")).toBeTruthy();
    expect(within(dialog).queryByText("Stopping the install…")).toBeNull();
  });

  it("closing keeps the install running and says where to follow it", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline({ jobs: [{ status: 200, body: job() }] });
    installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
    const { invalidate } = renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await within(dialog).findByText("Installing omnikrux-kps with Helm…");
    invalidate.mockClear();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(results()).toBe("started"));
    expect(status().textContent).toBe("Installing the monitoring tools in kind-install. Follow it on Monitoring tools.");
    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    expect(keys).toContain('["monitoring"]');
    expect(keys).toContain('["audit"]');
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Install tools" }));
  });

  it("a job unknown for a moment reads as starting, then shows its progress", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline({ jobs: [{ status: 404, body: { detail: "That job isn't known." } }, { status: 200, body: job({ message: "Creating the namespace monitoring…", done: 0 }) }] });
    installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    expect(await within(dialog).findByText("Starting the install…")).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(await within(dialog).findByText("Creating the namespace monitoring…", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("a failed read says so and shows no old numbers", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline({
      jobs: [{ status: 200, body: job() }, { status: 500, body: { detail: "The server had a problem. Try again." } }],
    });
    installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await within(dialog).findByText("Installing omnikrux-kps with Helm…");
    const failed = await within(dialog).findByRole("alert", {}, { timeout: 3000 });
    expect(failed.textContent).toBe("Can't read the progress: The server had a problem. Try again. Trying again…");
    // No old numbers shown as current.
    expect(within(dialog).queryByRole("progressbar")).toBeNull();
    expect(within(dialog).queryByText("Installing omnikrux-kps with Helm…")).toBeNull();
  });

  it("a forgotten job says how it ended isn't known", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
    try {
      const user = userEvent.setup();
      const { fallback } = pipeline({ jobs: [{ status: 404, body: { detail: "OmniKrux doesn't know that job (it may have restarted)." } }] });
      installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
      renderHost();
      await user.click(screen.getByRole("button", { name: "Install tools" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Install" }));
      await within(dialog).findByText("Starting the install…");
      vi.setSystemTime(Date.now() + 6000);
      const lost = await within(dialog).findByRole("alert", {}, { timeout: 3000 });
      expect(lost.textContent).toBe("OmniKrux doesn't know that job (it may have restarted). How it ended isn't known here: check Monitoring tools and Audit.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("install progress polling", () => {
  function renderProgress(answers: (() => Response)[]) {
    const reads: number[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (!String(url).startsWith("/api/actions/jobs/")) return Promise.resolve(new Response("{}", { status: 404 }));
      reads.push(Date.now());
      const answer = answers.length > 1 ? answers.shift()! : answers[0];
      return Promise.resolve(answer());
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const out = render(
      <QueryClientProvider client={client}>
        <InstallProgress jobId="j1" action="install" onClose={() => {}} onOutcome={() => {}} />
      </QueryClientProvider>,
    );
    return { ...out, reads };
  }
  const ok = () => new Response(JSON.stringify(job()), { status: 200, headers: { "content-type": "application/json" } });
  const broken = () => new Response(JSON.stringify({ detail: "The server had a problem. Try again." }), { status: 500, headers: { "content-type": "application/json" } });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it("failed reads back off up to 8 seconds", async () => {
    vi.useFakeTimers();
    try {
      const { reads } = renderProgress([ok, broken]);
      await advance(25000);
      const gaps = reads.slice(1).map((t, i) => t - reads[i]);
      // The first read answers; then each failed read waits longer than the last, up to 8 s.
      expect(gaps).toEqual([1000, 1000, 2000, 4000, 8000, 8000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reading stops when the progress closes", async () => {
    vi.useFakeTimers();
    try {
      const { reads, unmount } = renderProgress([ok]);
      await advance(2500);
      expect(reads).toHaveLength(3);
      unmount();
      await advance(20000);
      expect(reads).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("install review queue", () => {
  it("an uninstall review opens on Cancel and types on production", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline();
    installFakeMonitoringApi({
      install: {
        uninstallPlans: [plan({
          action: "uninstall", title: "Uninstall monitoring tools from monitoring", apply_label: "Uninstall", confirm_text: "monitoring",
          cluster: { id: "c1", name: "prod-east", provider: "aks", environment: "production" },
          warnings: ["This is a production cluster."],
        })],
      },
    }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Uninstall tools" }));
    const dialog = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(dialog).getByRole("textbox", { name: "Type monitoring to confirm" })).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Uninstall" }) as HTMLButtonElement).disabled).toBe(true);
    // No settings in an uninstall review.
    expect(within(dialog).queryByRole("button", { name: "Settings" })).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(results()).toBe("cancelled"));
    expect(status().textContent).toBe("Nothing was uninstalled from prod-east.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Uninstall tools" }));
  });

  it("two requests queue one after the other", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline();
    installFakeMonitoringApi({
      install: {
        plans: [planned()],
        uninstallPlans: [plan({ plan_id: "plan-u", action: "uninstall", title: "Uninstall monitoring tools from monitoring", apply_label: "Uninstall" })],
      },
    }, fallback);
    let reviews!: InstallReviews;
    renderHost((r) => { reviews = r; });
    const order: string[] = [];
    act(() => {
      void reviews.install({ clusterId: "c1", components: ["metrics"] }).then((o) => order.push(`install:${o}`));
      void reviews.uninstall("c1").then((o) => order.push(`uninstall:${o}`));
    });

    const first = await screen.findByRole("dialog");
    expect(within(first).getByRole("heading").textContent).toBe("Install monitoring tools in monitoring");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await user.keyboard("{Escape}");

    await screen.findByRole("heading", { name: "Uninstall monitoring tools from monitoring" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(order).toEqual(["install:cancelled"]);
    const second = screen.getByRole("dialog");
    expect(document.activeElement).toBe(within(second).getByRole("button", { name: "Cancel" }));
    await user.click(within(second).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(order).toEqual(["install:cancelled", "uninstall:cancelled"]));
    expect([...status().querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Nothing was installed in kind-install.",
      "Nothing was uninstalled from kind-install.",
    ]);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("focus returns where it came from", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline();
    installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
    let reviews!: InstallReviews;
    renderHost((r) => { reviews = r; });

    // Asked from the page: back to its button.
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Install tools" }));

    // Asked for a place that is gone by the time it closes: the workspace, never <body>.
    const away = document.createElement("button");
    document.body.appendChild(away);
    act(() => { void reviews.install({ clusterId: "c1", components: ["metrics"], focusAfter: away }); });
    await screen.findByRole("dialog");
    away.remove();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("a review that can't be made says why and reads failed", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline();
    installFakeMonitoringApi({ install: { plans: [{ error: { code: "gone", message: "That cluster isn't connected to OmniKrux any more." }, status: 404 }] } }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    await waitFor(() => expect(results()).toBe("failed"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(status().textContent).toBe("Couldn't review the install in this cluster: That cluster isn't connected to OmniKrux any more.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Install tools" }));
  });

  it("contact points: none to review says nothing; a review is said either way", async () => {
    const user = userEvent.setup();
    const { fallback } = pipeline({ applies: [{ status: 200, body: { outcome: "succeeded", message: "Updated the contact points.", job_id: null, audit_id: 2 } }] });
    const api = installFakeMonitoringApi({
      install: { contacts: { c1: { kind: "done", contacts: { state: "in_sync", message: null, applied_at: null, contact_points: 2, rules: 1 } } } },
    }, fallback);
    renderHost();
    await user.click(screen.getByRole("button", { name: "Contact points" }));
    await waitFor(() => expect(results()).toBe("applied"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(status().textContent).toBe("");

    const review = plan({ plan_id: "plan-c", action: "edit", title: "Update contact points in monitoring", apply_label: "Update" });
    api.state.install.contacts.c1 = { kind: "review", plan: review };
    await user.click(screen.getByRole("button", { name: "Contact points" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(results()).toBe("applied,cancelled"));
    expect(status().textContent).toBe("Contact points in kind-install's Alertmanager aren't updated yet. Review them from Monitoring tools.");

    await user.click(screen.getByRole("button", { name: "Contact points" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(results()).toBe("applied,cancelled,applied"));
    expect(status().textContent).toContain("Contact points are up to date in kind-install's Alertmanager.");
  });

  it("outside its provider every review reads cancelled", async () => {
    let reviews!: InstallReviews;
    function Bare() {
      reviews = useInstallReviews();
      return null;
    }
    render(<Bare />);
    await expect(reviews.install({ clusterId: "c1", components: ["metrics"] })).resolves.toBe("cancelled");
    await expect(reviews.uninstall("c1")).resolves.toBe("cancelled");
    await expect(reviews.contacts("c1")).resolves.toBe("cancelled");
  });
});

describe("a job that carries on after its review closed", () => {
  /** What the Monitoring sidebar shows: the tree's source count. */
  function SourcesCount() {
    const tree = useMonitoringTree();
    return <p data-testid="count">{tree.data ? `Sources ${tree.data.source_count}` : ""}</p>;
  }

  /** The pipeline, with the job reads answering whatever `box.job` holds. */
  function liveJob(first: Job) {
    const box = { job: first };
    const { fallback: base, seen } = pipeline();
    const fallback = (url: string, init?: RequestInit) =>
      (init?.method ?? "GET").toUpperCase() === "GET" && url.startsWith("/api/actions/jobs/")
        ? (seen.push(`GET ${url}`), json(box.job))
        : base(url, init);
    return { box, seen, fallback };
  }

  function renderWithCount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const out = render(
      <QueryClientProvider client={client}>
        <main tabIndex={-1}>
          <InstallReviewHost>
            <Probe />
            <SourcesCount />
          </InstallReviewHost>
        </main>
      </QueryClientProvider>,
    );
    return { ...out, client };
  }

  const reads = (api: FakeMonitoringApi, url: string) => api.requests.filter((r) => r.method === "GET" && r.url === url).length;
  const SOURCE = { id: "s9", name: "kind-install Prometheus" } as SourceOut;

  it("an install closed mid-job reads Monitoring again when it ends", async () => {
    const user = userEvent.setup();
    const { box, fallback } = liveJob(job());
    const api = installFakeMonitoringApi({ install: { plans: [planned()] } }, fallback);
    renderWithCount();
    expect(await screen.findByText("Sources 0")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await within(dialog).findByText("Installing omnikrux-kps with Helm…");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(results()).toBe("started"));
    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("Sources 0"));
    const treeReads = reads(api, "/api/monitoring/tree");

    // The job ends on the server, with a source connected.
    api.state.sources.push(SOURCE);
    box.job = job({ state: "succeeded", message: "Installed in monitoring: Prometheus is running. Connected 1 source.", done: 6, finished_at: "2026-11-24T10:03:00Z" });
    expect(await screen.findByText("Sources 1", {}, { timeout: 6000 })).toBeTruthy();
    expect(reads(api, "/api/monitoring/tree")).toBeGreaterThan(treeReads);
    expect(status().textContent).toContain("Installed in monitoring: Prometheus is running. Connected 1 source.");
  }, 15000);

  it("an uninstall closed mid-job reads Monitoring again when it ends", async () => {
    const user = userEvent.setup();
    const { box, fallback } = liveJob(job({ action: "uninstall", message: "Uninstalling omnikrux-loki with Helm…" }));
    const api = installFakeMonitoringApi({
      sources: [SOURCE],
      install: { uninstallPlans: [plan({ plan_id: "plan-u", action: "uninstall", title: "Uninstall monitoring tools from monitoring", apply_label: "Uninstall" })] },
    }, fallback);
    renderWithCount();
    expect(await screen.findByText("Sources 1")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Uninstall tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    await within(dialog).findByText("Uninstalling omnikrux-loki with Helm…");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(results()).toBe("started"));
    expect(status().textContent).toContain("Uninstalling the monitoring tools from kind-install. Follow it on Monitoring tools.");

    api.state.sources.splice(0);
    box.job = job({ action: "uninstall", state: "cancelled", message: "Uninstall cancelled while uninstall omnikrux-loki. What was already removed stays removed. Uninstall again to finish." });
    expect(await screen.findByText("Sources 0", {}, { timeout: 6000 })).toBeTruthy();
    expect(status().textContent).toContain("Uninstall again to finish.");
  }, 15000);

  it("a job the server forgot says how it ended isn't known", async () => {
    const user = userEvent.setup();
    const { box, fallback } = liveJob(job());
    const forgot = (url: string, init?: RequestInit) =>
      box.job.state === "failed" && url.startsWith("/api/actions/jobs/")
        ? json({ detail: "OmniKrux doesn't know that job (it may have restarted)." }, 404)
        : fallback(url, init);
    installFakeMonitoringApi({ install: { plans: [planned()] } }, forgot);
    renderWithCount();
    await user.click(screen.getByRole("button", { name: "Install tools" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await within(dialog).findByText("Installing omnikrux-kps with Helm…");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(results()).toBe("started"));
    box.job = job({ state: "failed" });
    await waitFor(() => expect(status().textContent).toContain(
      "OmniKrux doesn't know that job (it may have restarted). How it ended isn't known here: check Monitoring tools and Audit.",
    ), { timeout: 6000 });
  }, 15000);
});
