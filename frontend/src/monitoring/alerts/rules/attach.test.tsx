import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LinkOut, ProjectOut } from "../../api/types";
import { panel, seedDashboard, spec } from "../../test/dashboardSeeds";
import { installFakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../../test/renderMonitoringApp";
import { newAlert } from "../../dashboards/schema";
import type { RuleOut } from "../api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const T = "2026-01-01T00:00:00Z";
const link: LinkOut = { source_id: "s1", source_name: "Prometheus", source_type: "prometheus", filter: "", filter_origin: "none", created_by_project: false };
const shop: ProjectOut = { ...seedProject("p1", "Shop"), links: [link] };

const pageRule: RuleOut = {
  id: "rA", name: "Slow checkout", scope: { kind: "project", id: "p1", name: "Shop" }, source_type: "prometheus", source_id: null, expr: "up",
  condition: { of: "each", op: "above", threshold: 5, for: "5m", every: "1m" }, severity: "warning", message: "",
  contact_points: [], engine: "omnikrux", channel: null, paused: false, origin: "page", panel: null, state: "ok", firing_since: null,
  targets: [], removing: false, version: 1, created_at: T, updated_at: T,
};

function board() {
  const latency = panel("pa", "Latency", "up");
  const pods = panel("pb", "Pods", "up", { y: 8 }, "table");
  const errors = panel("pc", "Errors", "up", { y: 16 });
  errors.alert = newAlert(errors, 1);
  return seedDashboard("d1", { kind: "project", id: "p1", name: "Shop" }, spec("Checkout", [pods, errors, latency]));
}

describe("attach to a panel", () => {
  it("attach lists only panels that can take an alert", async () => {
    const user = userEvent.setup();
    const api = installFakeMonitoringApi({ projects: [shop], rules: [pageRule], dashboards: { d1: board() } });
    renderMonitoringApp({ tabs: tabsWith({ page: "alerts", rule: "rA" }) });
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Slow checkout"));
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Attach to a panel…" }));

    const dialog = await screen.findByRole("dialog", { name: 'Attach "Slow checkout" to a panel' });
    const go = within(dialog).getByRole("button", { name: "Attach" });
    expect(document.activeElement).toBe(go);
    const dashboard = within(dialog).getByLabelText("Dashboard") as HTMLSelectElement;
    expect([...dashboard.options].map((o) => o.textContent)).toEqual(["Checkout"]);
    const panels = await within(dialog).findByLabelText("Panel") as HTMLSelectElement;
    expect([...panels.options].map((o) => [o.textContent, o.disabled])).toEqual([
      ["Pods (can't have an alert)", true],
      ["Errors (has an alert)", true],
      ["Latency", false],
    ]);
    expect(panels.value).toBe("pa");

    // Saved somewhere else since the dialog read it: the refusal stays in the dialog.
    api.state.dashboards.d1.out.version = 2;
    await user.keyboard("{Control>}{Enter}{/Control}");
    const refusal = await within(dialog).findByRole("alert");
    expect(refusal.textContent).toBe("This dashboard was saved somewhere else since you started (version 2). Review the differences before saving.");
    expect(screen.getByRole("dialog")).toBe(dialog);

    // Read again, the next Attach goes through.
    await waitFor(() => expect(document.activeElement).toBe(go));
    await waitFor(() => expect(api.requests.filter((r) => r.method === "GET" && r.url.endsWith("/dashboards/d1")).length).toBeGreaterThan(1));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const attaches = api.requests.filter((r) => r.url.endsWith("/alerts/rules/rA/attach"));
    expect(attaches.at(-1)!.body).toEqual({ dashboard_id: "d1", panel_id: "pa", base_version: 2 });
    expect((await screen.findByText('Attached. The rule now lives on the panel "Latency".')).getAttribute("role")).toBe("status");
    const facts = document.querySelector("dl")!;
    expect(facts.textContent).toContain("From panelLatency on Checkout");
    expect(screen.getByRole("button", { name: "Edit on its panel" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More actions" }));
  });
});
