import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Job, Plan } from "../../api/types";
import type { TabNav } from "../../features/shell/browserHistory";
import type { MonitoringPageProps } from "../MonitoringApp";
import { installFakeMonitoringApi, type FakeMonitoringApi } from "../test/fakeMonitoringApi";
import type { MonitoringView } from "../shell/tabState";
import type { InstallPlanOut } from "./api";
import { InstallReviewHost } from "./InstallReviewHost";
import ToolsPage, { POLL_IDLE_MS, POLL_RUNNING_MS } from "./ToolsPage";
import { CONTACTS, lokiRelease, record, release, SETTINGS, status, TOOLS } from "./toolsFixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const plan = (over: Partial<Plan> = {}): Plan => ({
  plan_id: "plan-1",
  action: "install",
  target: { cluster_id: "c1", kind_key: "omnikrux.monitoring/install", namespace: null, name: "monitoring" },
  kind: "Monitoring tools",
  cluster: { id: "c1", name: "kind-install", provider: "kind", environment: "development" },
  title: "Install monitoring tools in monitoring",
  summary: ["Installs metrics into kind-install, namespace monitoring."],
  warnings: [],
  blocked: [],
  diff: null,
  confirm_text: null,
  apply_label: "Install",
  expires_at: "2026-11-24T10:05:00Z",
  ...over,
});

const planned = (): InstallPlanOut => ({
  plan: plan(),
  settings: SETTINGS,
  problems: [],
  facts: { default_storage_class: "standard", kube_version: "1.31.0" },
});

const uninstallPlan = (over: Partial<Plan> = {}) =>
  plan({ plan_id: "plan-u", action: "uninstall", title: "Uninstall monitoring tools from monitoring", apply_label: "Uninstall", ...over });

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1", action: "install", state: "running", message: "Installing omnikrux-kps with Helm…", total: 6, done: 2, blocked: [],
  started_at: "2026-11-24T10:00:00Z", finished_at: null, ...over,
});

/** The pipeline's routes the page can reach. */
function pipeline(jobAnswer: Job = job()) {
  return (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/clusters") return json([]);
    if (method === "GET" && url.startsWith("/api/actions/jobs/")) return json(jobAnswer);
    if (method === "DELETE" && url.startsWith("/api/actions/")) return Promise.resolve(new Response(null, { status: 204 }));
    return json({ detail: "Not found" }, 404);
  };
}

function renderPage(api: { seed?: Parameters<typeof installFakeMonitoringApi>[0]; fallback?: Parameters<typeof installFakeMonitoringApi>[1] } = {}) {
  const fake = installFakeMonitoringApi(api.seed, api.fallback ?? pipeline());
  const navigate = vi.fn();
  const openInNewTab = vi.fn();
  const nav = { navigate } as unknown as TabNav<MonitoringView>;
  const view: MonitoringView = { page: "tools", clusterId: "c1" };
  const props: MonitoringPageProps = {
    view, tabId: "t1", nav, openInNewTab, activateTab: () => {}, onOpenSettings: () => {},
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const out = render(
    <QueryClientProvider client={client}>
      <main tabIndex={-1}>
        <InstallReviewHost>
          <ToolsPage {...props} />
        </InstallReviewHost>
      </main>
    </QueryClientProvider>,
  );
  return { ...out, client, fake, navigate, openInNewTab };
}

const statusReads = (api: FakeMonitoringApi) => api.requests.filter((r) => r.method === "GET" && r.url === "/api/monitoring/install/clusters/c1").length;
const noBody = () => expect(document.activeElement).not.toBe(document.body);
const AVAILABLE = { tools: TOOLS };

describe("a cluster without an install", () => {
  it("offers both components", async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({ seed: { install: { ...AVAILABLE, status: { c1: status() }, plans: [planned()] } } });

    const h1 = await screen.findByRole("heading", { level: 1, name: "Monitoring tools in kind-install" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(screen.getByText("OmniKrux hasn't installed anything in this cluster.")).toBeTruthy();
    expect(screen.getByText("Read 10:04:12")).toBeTruthy();
    expect(screen.getByText("Prometheus, Alertmanager, node-exporter and kube-state-metrics")).toBeTruthy();
    expect(screen.getByText("kube-prometheus-stack 66.2.1")).toBeTruthy();
    expect(screen.getByText("Loki and Grafana Alloy, which collects Pod logs")).toBeTruthy();
    expect(screen.getByText("loki 3.2.1 · alloy v1.4.3")).toBeTruthy();

    const review = screen.getByRole("button", { name: "Review install…" }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: /Metrics/ }));
    expect(review.disabled).toBe(false);
    await user.click(review);

    const dialog = await screen.findByRole("dialog");
    const bodies = fake.requests.filter((r) => r.url === "/api/monitoring/install/plan").map((r) => r.body);
    expect(bodies).toEqual([{ cluster_id: "c1", components: ["metrics"] }]);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(review);
  });

  it("tools the user runs are pointed out", async () => {
    const user = userEvent.setup();
    const found = { type: "prometheus", state: "reachable", namespace: "obs", service: "prometheus-k8s", port: "9090", scheme: "http", version: null, message: null, existing_source_id: null, detail: null } as const;
    const { navigate } = renderPage({ seed: { install: { ...AVAILABLE, status: { c1: status({ others: [found] }) } } } });
    expect(await screen.findByText("kind-install already runs Prometheus at obs/prometheus-k8s. You can connect it instead of installing another.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Use it in a project" }));
    expect(navigate).toHaveBeenCalledWith({ page: "setup", clusterId: "c1" }, "push");
  });

  it("unavailable tools disable install with the reason", async () => {
    const user = userEvent.setup();
    const why = "Installing needs Helm, which ships in the OmniKrux image. It wasn't found.";
    renderPage({ seed: { install: { tools: { ...TOOLS, available: false, message: why }, status: { c1: status() } } } });
    expect(await screen.findByText(`Installing isn't available here: ${why}`)).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: /Logs/ }));
    const review = screen.getByRole("button", { name: "Review install…" }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    expect(review.title).toBe(`Installing isn't available here: ${why}`);
  });
});

describe("an install", () => {
  const sources = { prometheus: { id: "s1", name: "kind-install Prometheus" }, alertmanager: null, loki: null };

  it("shows releases and readiness in words", async () => {
    const user = userEvent.setup();
    const waiting = release({
      release: "omnikrux-alloy", label: "Grafana Alloy", chart: "alloy", version: "0.9.2",
      workloads: [{ kind: "DaemonSet", name: "alloy", label: "Alloy", ready: 2, desired: 3, why: "A Pod is Pending: no node has room." }],
    });
    const { navigate, openInNewTab } = renderPage({
      seed: { install: { ...AVAILABLE, status: { c1: status({
        install: record({ components: ["metrics", "logs"], message: "Installed with Helm.", sources, contacts: { ...CONTACTS, state: "in_sync", contact_points: 2, rules: 5 } }),
        releases: [release(), lokiRelease({ status: "missing", version: null, workloads: [] }), waiting],
      }) } } },
    });
    expect(await screen.findByText("Installed by OmniKrux in monitoring")).toBeTruthy();
    expect(screen.getByText("Installed with Helm.")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Installed tools" });
    expect(within(table).getByText("Prometheus and Alertmanager")).toBeTruthy();
    expect(within(table).getByText("kube-prometheus-stack 66.2.1")).toBeTruthy();
    expect(within(table).getAllByText("Helm: deployed")).toHaveLength(2);
    expect(within(table).getByText("Helm: missing")).toBeTruthy();
    expect(within(table).getByText("1 of 1 ready")).toBeTruthy();
    expect(within(table).getByText("2 of 3 ready")).toBeTruthy();
    expect(within(table).getByText("A Pod is Pending: no node has room.")).toBeTruthy();
    expect(screen.getByText("Up to date · 2 contact points for 5 rules")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "kind-install Prometheus" }));
    expect(navigate).toHaveBeenCalledWith({ page: "source", id: "s1" }, "push");
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("button", { name: "kind-install Prometheus" }));
    expect(openInNewTab).toHaveBeenCalledWith({ page: "source", id: "s1" });
  });

  it("offers what's missing only when something is", async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({
      seed: { install: { ...AVAILABLE, status: { c1: status({ install: record(), releases: [release()] }) }, plans: [planned()] } },
    });
    const button = await screen.findByRole("button", { name: "Install what's missing…" });
    expect(screen.queryByRole("button", { name: "Install again…" })).toBeNull();
    await user.click(button);
    await screen.findByRole("dialog");
    expect(fake.requests.filter((r) => r.url === "/api/monitoring/install/plan").map((r) => r.body)).toEqual([{ cluster_id: "c1", components: ["logs"] }]);
  });

  it("update appears only when the shipped versions differ", async () => {
    renderPage({ seed: { install: { ...AVAILABLE, status: { c1: status({ install: record({ components: ["metrics", "logs"] }), releases: [release(), lokiRelease()] }) } } } });
    await screen.findByText("Installed by OmniKrux in monitoring");
    expect(screen.queryByRole("button", { name: "Update to the shipped versions…" })).toBeNull();
    cleanup();

    renderPage({
      seed: { install: { ...AVAILABLE, status: { c1: status({ install: record({ components: ["metrics", "logs"], update_available: true }), releases: [release(), lokiRelease()] }) } } },
    });
    expect(await screen.findByRole("button", { name: "Update to the shipped versions…" })).toBeTruthy();
  });

  it("a failed install says so and offers Install again", async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({
      seed: { install: { ...AVAILABLE, status: { c1: status({ install: record({ state: "failed", message: "Helm stopped at Prometheus." }) }) }, plans: [planned()] } },
    });
    expect(await screen.findByText("The last change failed")).toBeTruthy();
    expect(screen.getByText("Helm stopped at Prometheus.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install what's missing…" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Install again…" }));
    await screen.findByRole("dialog");
    expect(fake.requests.filter((r) => r.url === "/api/monitoring/install/plan").map((r) => r.body)).toEqual([{ cluster_id: "c1", components: ["metrics"] }]);
  });

  it("a cancelled install says so", async () => {
    renderPage({ seed: { install: { ...AVAILABLE, status: { c1: status({ install: record({ state: "cancelled" }) }) } } } });
    expect(await screen.findByText("The last change was cancelled")).toBeTruthy();
    const again = screen.getByRole("button", { name: "Install again…" });
    expect(again.className).toMatch(/primary/);
    // The install's own ending: Uninstall stays last and quiet.
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons.indexOf("Install again…")).toBeLessThan(buttons.indexOf("Uninstall monitoring tools…"));
  });

  it("a cancelled or failed uninstall leads with Uninstall, not Install again", async () => {
    const message = "Uninstall cancelled while uninstall omnikrux-loki. What was already removed stays removed. Uninstall again to finish.";
    renderPage({ seed: { install: { ...AVAILABLE, status: { c1: status({ install: record({ state: "cancelled", message }) }) } } } });
    expect(await screen.findByText("The last change was cancelled")).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
    const uninstall = screen.getByRole("button", { name: "Uninstall monitoring tools…" });
    expect(uninstall.hasAttribute("data-lead")).toBe(true);
    expect(screen.getByRole("button", { name: "Install again…" }).className).toMatch(/secondary/);
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons.indexOf("Uninstall monitoring tools…")).toBeLessThan(buttons.indexOf("Install again…"));
    cleanup();

    renderPage({ seed: { install: { ...AVAILABLE, status: { c1: status({ install: record({
      state: "failed", message: "OmniKrux stopped during the uninstall. What Helm applied stays as Helm left it. Open Monitoring tools to see what's there, then run it again.",
    }) }) } } } });
    expect(await screen.findByText("The last change failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Uninstall monitoring tools…" }).hasAttribute("data-lead")).toBe(true);
  });

  it("a disabled uninstall says uninstalling isn't available", async () => {
    const why = "Installing needs Helm, which ships in the OmniKrux image. It wasn't found.";
    renderPage({ seed: { install: { tools: { ...TOOLS, available: false, message: why }, status: { c1: status({ install: record(), releases: [release()] }) } } } });
    const uninstall = await screen.findByRole("button", { name: "Uninstall monitoring tools…" }) as HTMLButtonElement;
    expect(uninstall.disabled).toBe(true);
    expect(uninstall.title).toBe(`Uninstalling isn't available here: ${why}`);
  });

  it("uninstall opens its review, and the stored data is a choice that plans it again", async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({
      seed: { install: { ...AVAILABLE, status: { c1: status({ install: record(), releases: [release()] }) }, uninstallPlans: [uninstallPlan()] } },
    });
    const open = await screen.findByRole("button", { name: "Uninstall monitoring tools…" });
    await user.click(open);

    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByRole("checkbox", { name: "Also delete the stored data (metrics, logs and alerts history on the volumes)" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    const bodies = () => fake.requests.filter((r) => r.url.endsWith("/uninstall/plan")).map((r) => r.body);
    expect(bodies()).toEqual([{ delete_data: false }]);

    await user.click(box);
    await waitFor(() => expect(bodies()).toEqual([{ delete_data: false }, { delete_data: true }]));
    await waitFor(() => expect((within(screen.getByRole("dialog")).getByRole("checkbox") as HTMLInputElement).checked).toBe(true));
    await user.click(within(screen.getByRole("dialog")).getByRole("checkbox"));
    await waitFor(() => expect(bodies()).toEqual([{ delete_data: false }, { delete_data: true }, { delete_data: false }]));
    await waitFor(() => expect((within(screen.getByRole("dialog")).getByRole("checkbox") as HTMLInputElement).checked).toBe(false));
    noBody();
  });

  it("a refused change of the stored-data choice reverts, and Review again then sends false", async () => {
    const user = userEvent.setup();
    const fallback = (url: string, init?: RequestInit) =>
      (init?.method ?? "GET").toUpperCase() === "POST" && url.endsWith("/apply")
        ? json({ detail: "That changed since you looked. Review it again." }, 409)
        : pipeline()(url, init);
    const { fake } = renderPage({
      fallback,
      seed: {
        install: {
          ...AVAILABLE,
          status: { c1: status({ install: record(), releases: [release()] }) },
          uninstallPlans: [uninstallPlan(), { status: 500, error: { message: "Couldn't plan the uninstall." } }, uninstallPlan({ plan_id: "plan-u2" })],
        },
      },
    });
    await user.click(await screen.findByRole("button", { name: "Uninstall monitoring tools…" }));
    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByRole("checkbox") as HTMLInputElement;
    await user.click(box);
    await within(dialog).findByText(/Couldn't plan the uninstall/);
    await waitFor(() => expect(box.checked).toBe(false));

    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    await user.click(await within(dialog).findByRole("button", { name: "Review again" }));
    const bodies = () => fake.requests.filter((r) => r.url.endsWith("/uninstall/plan")).map((r) => r.body);
    await waitFor(() => expect(bodies()).toEqual([{ delete_data: false }, { delete_data: true }, { delete_data: false }]));
    noBody();
  });

  it("a running job shows its progress inline", async () => {
    renderPage({
      seed: { install: { ...AVAILABLE, status: { c1: status({ install: record({ state: "installing", job_id: "j1", message: "Installing…" }) }) } } },
    });
    expect(await screen.findByText("Installing…", { selector: "p[data-state]" })).toBeTruthy();
    expect(await screen.findByText("Installing omnikrux-kps with Helm…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel install" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Uninstall monitoring tools…" })).toBeNull();
    // On this page itself: no "follow it on Monitoring tools", and Close hides the progress.
    expect(screen.getByRole("button", { name: "Hide progress" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByText(/carries on if you close this/)).toBeNull();
    noBody();
  });
});

describe("the keyboard and a running job", () => {
  const running = { install: { ...AVAILABLE, status: { c1: status({ install: record({ state: "installing", job_id: "j1", message: "Installing…" }) }) } } };

  it("a job already running on load leaves the keyboard on the heading", async () => {
    renderPage({ seed: running });
    const h1 = await screen.findByRole("heading", { level: 1 });
    await screen.findByText("Installing omnikrux-kps with Helm…");
    expect(document.activeElement).toBe(h1);
  });

  it("a job that starts elsewhere leaves the keyboard where it is", async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({ seed: { install: { ...AVAILABLE, status: { c1: status() } } } });
    const refresh = await screen.findByRole("button", { name: "Refresh" });
    fake.state.install.status.c1 = status({ install: record({ state: "installing", job_id: "j1", message: "Installing…" }) });
    await user.click(refresh);
    await screen.findByText("Installing omnikrux-kps with Helm…");
    expect(document.activeElement).toBe(refresh);
  });
});

describe("contact points", () => {
  const withContacts = (contacts: Partial<typeof CONTACTS>) => ({
    install: { ...AVAILABLE, status: { c1: status({ install: record({ contacts: { ...CONTACTS, ...contacts } }), releases: [release()] }) } },
  });

  it("none says no rule sends yet", async () => {
    renderPage({ seed: withContacts({}) });
    expect(await screen.findByText("No alert rules here send to contact points yet.")).toBeTruthy();
  });

  it("contacts needing review offer Review", async () => {
    const user = userEvent.setup();
    const sync = { kind: "review", plan: plan({ plan_id: "plan-c", action: "install", title: "Update contact points", apply_label: "Apply" }) } as const;
    const { fake } = renderPage({ seed: { install: { ...withContacts({ state: "needs_review" }).install, contacts: { c1: sync } } } });
    expect(await screen.findByText("Changed since the last review")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Review" }));
    await screen.findByRole("dialog");
    expect(fake.requests.some((r) => r.url === "/api/monitoring/install/clusters/c1/contacts/sync")).toBe(true);
  });

  it("one contact point and one rule read in the singular", async () => {
    renderPage({ seed: withContacts({ state: "in_sync", contact_points: 1, rules: 1 }) });
    expect(await screen.findByText("Up to date · 1 contact point for 1 rule")).toBeTruthy();
  });

  it("failed says why and offers Try again", async () => {
    renderPage({ seed: withContacts({ state: "failed", message: "Alertmanager didn't answer." }) });
    expect(await screen.findByText("Couldn't be updated: Alertmanager didn't answer.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("reading the cluster", () => {
  it("a read problem shows no old rows", async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({
      seed: { install: { ...AVAILABLE, status: { c1: status({ install: record(), releases: [release()] }) } } },
    });
    expect(await screen.findByRole("table", { name: "Installed tools" })).toBeTruthy();
    fake.state.install.status.c1 = status({ install: record(), releases: [], problem: "Couldn't read the monitoring tools in monitoring: the cluster didn't answer." });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Couldn't read the monitoring tools in monitoring: the cluster didn't answer.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Installed tools" })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Uninstall monitoring tools…" })).toBeNull();

    // The answer works again: the rows come back.
    fake.state.install.status.c1 = status({ install: record(), releases: [release()] });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Installed tools" })).toBeTruthy();
  });

  it("a failed request shows the words and no old rows either", async () => {
    const user = userEvent.setup();
    const { fake } = renderPage({
      seed: { install: { ...AVAILABLE, status: { c1: status({ install: record(), releases: [release()] }) } } },
    });
    await screen.findByRole("table", { name: "Installed tools" });
    delete fake.state.install.status.c1;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/no longer connected|isn't connected/)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Installed tools" })).toBeNull();
    expect(screen.queryByText(/^Read /)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    noBody();
  });

  it("asks again every 30 s, every 3 s while a job runs, and not after other Monitoring changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fake, client } = renderPage({
      seed: { install: { ...AVAILABLE, status: { c1: status({ install: record(), releases: [release()] }) } } },
    });
    await screen.findByRole("table", { name: "Installed tools" });
    expect(statusReads(fake)).toBe(1);

    // Unrelated Monitoring changes don't read the cluster again.
    await act(async () => { await client.invalidateQueries({ queryKey: ["monitoring"] }); });
    expect(statusReads(fake)).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_IDLE_MS - 1000); });
    expect(statusReads(fake)).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    await waitFor(() => expect(statusReads(fake)).toBe(2));

    fake.state.install.status.c1 = status({ install: record({ state: "installing", job_id: "j1" }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_IDLE_MS + 100); });
    await waitFor(() => expect(statusReads(fake)).toBe(3));
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_RUNNING_MS * 2 + 200); });
    await waitFor(() => expect(statusReads(fake)).toBeGreaterThanOrEqual(5));
  });
});
