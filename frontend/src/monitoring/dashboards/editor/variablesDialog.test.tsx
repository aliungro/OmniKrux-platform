import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { installFakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { linkedProject, panel, seedDashboard, spec, variable } from "../../test/dashboardSeeds";
import { renderMonitoringApp, tabsWith } from "../../test/renderMonitoringApp";
import { emptyDashboard, newAlert, type DashboardSpec } from "../schema";
import { editSessions } from "./useDashboardEditor";
import { PANELS_RENAME, PANELS_USE, VARIABLES_EMPTY, variableProblems, VariablesDialog } from "./VariablesDialog";

vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return { default: ({ data }: { data: { series: unknown[] } }) => createElement("span", null, `chart ${data.series.length}`) };
});

// CodeMirror doesn't run in jsdom: the JSON tab is a textarea.
vi.mock("../../../features/actions/lazyCodeMirror", () => ({
  loadCodeMirror: () => Promise.resolve({
    mergeView: () => ({ destroy: () => {} }),
    editor: (parent: HTMLElement, doc: string, onChange: (text: string) => void, label: string) => {
      const area = document.createElement("textarea");
      area.value = doc;
      area.setAttribute("aria-label", label);
      area.addEventListener("input", () => onChange(area.value));
      parent.append(area);
      return { destroy: () => area.remove(), focus: () => area.focus() };
    },
  }),
}));

beforeEach(() => { localStorage.clear(); editSessions.clear(); });
afterEach(() => cleanup());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const SHOP = { kind: "project" as const, id: "p1", name: "Shop" };
const ok = { result_type: "matrix" as const, series: [{ labels: { job: "api" }, points: [[1, 1]] as [number, number][] }] };
const notBody = () => expect(document.activeElement).not.toBe(document.body);

const DEFAULT_DOC = () => spec("Pods", [panel("p-1", "CPU in $namespace", 'up{namespace=~"$namespace"}')], [variable("namespace", "Namespace")]);

async function editing(doc: DashboardSpec = DEFAULT_DOC()) {
  installFakeMonitoringApi({
    projects: [linkedProject("p1", "Shop", "s1")],
    dashboards: { d1: seedDashboard("d1", SHOP, doc) },
    labelValues: { "p1|namespace": ["api", "web"], "p1|container": ["app", "sidecar"] },
    queryAnswers: { 'up{namespace=~"api"}': ok },
  }, async () => json([]));
  const user = userEvent.setup();
  renderMonitoringApp({ tabs: tabsWith({ page: "dashboard", id: "d1" }) });
  await screen.findByRole("heading", { level: 1, name: "Pods" });
  if (doc.variables.length > 0) await screen.findByRole("button", { name: "Namespace: api" });
  else await screen.findByRole("heading", { level: 2, name: "Old" });
  await user.keyboard("e");
  await screen.findByRole("button", { name: "Save dashboard" });
  return { user };
}

const dialog = () => screen.getByRole("dialog", { name: "Variables" });
const row = (n: number) => within(dialog()).getByRole("group", { name: new RegExp(`^Variable ${n}`) });

describe("Variables dialog", () => {
  it("adds a variable that the bar then offers", async () => {
    const { user } = await editing();
    await user.click(screen.getByRole("button", { name: "Variables" }));
    await user.click(within(dialog()).getByRole("button", { name: "Add variable" }));
    const added = row(2);
    await waitFor(() => expect(document.activeElement).toBe(within(added).getByLabelText("Name")));
    await user.type(within(added).getByLabelText("Name"), "container");
    await user.type(within(added).getByLabelText("Label name"), "container");
    await user.type(within(added).getByLabelText("Match"), "kube_pod_container_info");
    await user.click(within(dialog()).getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("dialog", { name: "Variables" })).toBeNull();
    expect(await screen.findByRole("button", { name: "container: All" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Variables" }));
    notBody();
    // One undo step.
    await user.keyboard("{Control>}z{/Control}");
    await waitFor(() => expect(screen.queryByRole("button", { name: "container: All" })).toBeNull());
    expect(screen.getByRole("button", { name: "Namespace: api" })).toBeTruthy();
    notBody();
  });

  it("a name that breaks the rules is said at its field", async () => {
    const { user } = await editing();
    await user.click(screen.getByRole("button", { name: "Variables" }));
    const name = within(row(1)).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "bad name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const said = document.getElementById(name.getAttribute("aria-describedby")!)!;
    expect(said.textContent).toMatch(/letters|digits|name/i);
    await user.click(within(dialog()).getByRole("button", { name: "Apply" }));
    // Refused: still open, the keyboard on the field.
    expect(dialog()).toBeTruthy();
    expect(document.activeElement).toBe(name);
    notBody();
  });

  it("removing a variable that panels use is refused with the panel words", async () => {
    const { user } = await editing();
    await user.click(screen.getByRole("button", { name: "Variables" }));
    await user.click(within(row(1)).getByRole("button", { name: "Remove" }));
    expect(await within(dialog()).findByText(PANELS_USE("namespace"))).toBeTruthy();
    expect(PANELS_USE("namespace")).toBe("Panels use $namespace: change their queries before removing it.");
    expect(within(dialog()).queryByText(/renaming/)).toBeNull();
    expect(within(dialog()).getByText(VARIABLES_EMPTY)).toBeTruthy();
    notBody();
    await user.click(within(dialog()).getByRole("button", { name: "Apply" }));
    expect(dialog()).toBeTruthy();
    // The dashboard still has it.
    expect(screen.getByRole("button", { name: "Namespace: api" })).toBeTruthy();
  });

  it("apply is refused while the JSON doesn't apply", async () => {
    const { user } = await editing();
    await user.click(screen.getByRole("tab", { name: "JSON" }));
    const area = await screen.findByRole("textbox", { name: "Dashboard JSON" });
    fireEvent.input(area, { target: { value: "{ nope" } });
    await waitFor(() => expect(screen.getByTestId("json-state").textContent).toMatch(/^✗/));
    await user.click(screen.getByRole("tab", { name: "Dashboard" }));
    await user.click(screen.getByRole("button", { name: "Variables" }));
    await user.click(within(dialog()).getByRole("button", { name: "Add variable" }));
    const added = row(2);
    await user.type(within(added).getByLabelText("Name"), "pod");
    await user.type(within(added).getByLabelText("Label name"), "pod");
    await user.click(within(dialog()).getByRole("button", { name: "Apply" }));
    expect((await within(dialog()).findByRole("alert")).textContent).toBe("Fix the JSON first, or discard it.");
    expect(dialog()).toBeTruthy();
  });

  it("Esc closes the dialog and returns to Variables", async () => {
    const { user } = await editing();
    await user.click(screen.getByRole("button", { name: "Variables" }));
    notBody();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Variables" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Variables" }));
  });

  it("moves a variable up and down and keeps the keyboard on its button", async () => {
    const { user } = await editing();
    await user.click(screen.getByRole("button", { name: "Variables" }));
    notBody();
    await user.click(within(dialog()).getByRole("button", { name: "Add variable" }));
    notBody();
    await user.type(within(row(2)).getByLabelText("Name"), "pod");
    await user.type(within(row(2)).getByLabelText("Label name"), "pod");
    notBody();
    await user.click(within(row(2)).getByRole("button", { name: "Move up" }));
    expect((within(row(1)).getByLabelText("Name") as HTMLInputElement).value).toBe("pod");
    expect(document.activeElement).toBe(within(row(1)).getByRole("button", { name: "Move up" }));
    await user.click(within(row(1)).getByRole("button", { name: "Move down" }));
    expect((within(row(2)).getByLabelText("Name") as HTMLInputElement).value).toBe("pod");
    expect(document.activeElement).toBe(within(row(2)).getByRole("button", { name: "Move down" }));
    notBody();
  });

  it("a group dashboard offers only the default source", () => {
    render(<VariablesDialog draft={spec("Fleet", [], [variable("namespace", "Namespace")])} ownerKind="group" owner={null}
      restoreFocusTo={createRef()} onApply={() => null} onCancel={() => {}} />);
    const options = within(screen.getByLabelText("Source")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Each project's Prometheus-compatible source", "Each project's Loki source"]);
  });
});

const alertDoc = () => {
  const p = panel("p-1", "CPU in $namespace", 'up{namespace="$namespace"}');
  return spec("Pods", [{ ...p, alert: { ...newAlert(p, 0.3), query: "A" } }], [variable("namespace", "Namespace", { default: ["api"] })]);
};

describe("Variables dialog: what blocks Apply", () => {
  it("changing a single-value variable that an alert panel uses applies", async () => {
    const { user } = await editing(alertDoc());
    await user.click(screen.getByRole("button", { name: "Variables" }));
    const label = within(row(1)).getByLabelText("Label name");
    await user.clear(label);
    await user.type(label, "ns");
    expect(within(dialog()).queryByText(/Panels use/)).toBeNull();
    await user.click(within(dialog()).getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("dialog", { name: "Variables" })).toBeNull();
    notBody();
  });

  it("a stale undefined variable already in a panel doesn't block an unrelated Apply", async () => {
    const stale = spec("Pods", [panel("p-1", "Old", 'up{x="$ghost"}')], []);
    const { user } = await editing(stale);
    await user.click(screen.getByRole("button", { name: "Variables" }));
    await user.click(within(dialog()).getByRole("button", { name: "Add variable" }));
    await user.type(within(row(1)).getByLabelText("Name"), "pod");
    await user.type(within(row(1)).getByLabelText("Label name"), "pod");
    expect(within(dialog()).queryByText(/Panels use/)).toBeNull();
    await user.click(within(dialog()).getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("dialog", { name: "Variables" })).toBeNull();
    notBody();
  });

  it("renaming a variable panels use says renaming, not removing", async () => {
    const { user } = await editing();
    await user.click(screen.getByRole("button", { name: "Variables" }));
    const name = within(row(1)).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "ns");
    expect(await within(dialog()).findByText(PANELS_RENAME("namespace"))).toBeTruthy();
    expect(PANELS_RENAME("namespace")).toBe("Panels use $namespace: change their queries before renaming it.");
    expect(within(dialog()).queryByText(PANELS_USE("namespace"))).toBeNull();
    await user.click(within(dialog()).getByRole("button", { name: "Apply" }));
    expect(dialog()).toBeTruthy();
    notBody();
  });

  it("a tile in edit mode is named by the title it shows", async () => {
    await editing();
    const tile = within(screen.getByRole("group", { name: "Panels" })).getAllByRole("region").find((r) => r.getAttribute("aria-label")?.startsWith("CPU in"));
    expect(tile?.getAttribute("aria-label")).toMatch(/^CPU in api, /);
  });

  it("the Match example follows the source type", () => {
    render(<VariablesDialog draft={spec("Fleet", [], [variable("namespace", "Namespace")])} ownerKind="group" owner={null}
      restoreFocusTo={createRef()} onApply={() => null} onCancel={() => {}} />);
    expect(screen.getByLabelText("Match").getAttribute("placeholder")).toMatch(/kube_pod_info/);
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "loki" } });
    expect(screen.getByLabelText("Match").getAttribute("placeholder")).toMatch(/^Optional, like \{namespace/);
  });
});

describe("variableProblems", () => {
  it("keys problems by row and field, and names the variables panels use", () => {
    const draft = spec("D", [panel("p-1", "T", 'up{n="$namespace"}')], []);
    const out = variableProblems(draft, [variable("bad name", "x")], "project");
    expect(out.fields.get("0.name")).toBeTruthy();
    expect(out.panels).toEqual(["namespace"]);
    expect(variableProblems(emptyDashboard("E"), [variable("ok", "Ok")], "project").fields.size).toBe(0);
  });
});
