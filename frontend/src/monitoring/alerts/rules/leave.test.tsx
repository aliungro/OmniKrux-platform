// Leaving an alert rule being written, through the real shell: the sidebar, Back, the Monitoring tab
// strip and closing a tab ask first when the form has changes (M2's leave question), and never when
// it has none. Switching Monitoring tabs isn't a way out: the form comes back as it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Shell } from "../../../features/shell/Shell";
import { defaultWorkspace } from "../../../features/shell/workspace";
import { KINDS } from "../../../test/kinds";
import type { LinkOut, ProjectOut } from "../../api/types";
import type { MonitoringView } from "../../shell/tabState";
import { installFakeMonitoringApi } from "../../test/fakeMonitoringApi";
import { seedProject } from "../../test/renderMonitoringApp";
import type { RuleOut } from "../api";
import {
  alertFormMarks, clearAlertForms, endRuleForm, heldFormLeave, keepRuleForm, markAlertForm, ruleFormSessions, startRuleForm, type AlertFormMark,
} from "./formSessions";
import type { AppTabs } from "../../../features/shell/workspace";

// The chart chunk as a stub.
vi.mock("../../charts", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("span", null, "chart") };
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  for (const id of [...ruleFormSessions.keys()]) endRuleForm(id);
  vi.unstubAllGlobals();
});

const T = "2026-01-01T00:00:00Z";
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const shellApi = async (url: string) => json(
  url.startsWith("/api/kinds") ? KINDS
    : url.startsWith("/api/audit") ? { records: [], next_before: null }
      : url === "/api/settings" ? { encryption: { source: "environment", path: null }, discovery_interval_s: 600 } : [],
);

const link: LinkOut = { source_id: "s1", source_name: "Prometheus", source_type: "prometheus", filter: "", filter_origin: "none", created_by_project: false };
const shop: ProjectOut = { ...seedProject("p1", "Shop"), links: [link] };
const slow: RuleOut = {
  id: "rA", name: "Slow checkout", scope: { kind: "project", id: "p1", name: "Shop" }, source_type: "prometheus", source_id: null, expr: "up",
  condition: { of: "each", op: "above", threshold: 5, for: "5m", every: "1m" }, severity: "warning", message: "",
  contact_points: [], engine: "omnikrux", channel: null, paused: false, origin: "page", panel: null, state: "ok", firing_since: null,
  targets: [], removing: false, version: 1, created_at: T, updated_at: T,
};

const ALERTS: MonitoringView = { page: "alerts" };
const HOME: MonitoringView = { page: "home" };
const ASK = 'Leave "Half written" with unsaved changes?';

function setup(...tabs: { view: MonitoringView; back?: MonitoringView[] }[]) {
  installFakeMonitoringApi({ projects: [shop], rules: [slow] }, shellApi);
  const ws = defaultWorkspace();
  ws.app = "monitoring";
  ws.monitoring = { tabs: tabs.map((t, i) => ({ id: `m${i}`, view: t.view, back: t.back ?? [], forward: [], scrollTop: 0 })), active: "m0", closed: [] };
  localStorage.setItem("omnikrux.workspace", JSON.stringify(ws));
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Shell /></QueryClientProvider>);
}

const monitoringTabs = () => within(screen.getByRole("tablist", { name: "Monitoring tabs" })).getAllByRole("tab");
const altKey = (key: string, code: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key, code, altKey: true });
const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

/** The Alerts page with the rule form open; `change` types a name, so there is something to lose. */
async function writing({ change = true } = {}) {
  const user = userEvent.setup();
  await screen.findByRole("heading", { level: 2, name: "Slow checkout" }, { timeout: 3000 });
  await user.click(screen.getByRole("button", { name: "New alert rule" }));
  const name = await screen.findByLabelText("Name");
  if (change) await user.type(name, "Half written");
  return user;
}

describe("leaving an alert rule being written", () => {
  it("the sidebar asks first, and Stay keeps the form", async () => {
    setup({ view: ALERTS });
    const user = await writing();
    await user.click(await screen.findByRole("treeitem", { name: "Shop" }));
    const ask = screen.getByRole("alertdialog", { name: ASK });
    expect(within(ask).getByText("Leaving loses what you wrote in this rule.")).toBeTruthy();
    expect(within(ask).getAllByRole("button").map((b) => b.textContent)).toEqual(["Stay", "Discard changes"]);
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Stay" }));
    await user.click(within(ask).getByRole("button", { name: "Stay" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Half written");
    // Discard changes goes on to the project.
    await user.click(screen.getByRole("treeitem", { name: "Shop" }));
    await user.click(within(screen.getByRole("alertdialog", { name: ASK })).getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Shop" })).toBeTruthy();
    expect(ruleFormSessions.size).toBe(0);
    await frame();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("Back asks first", async () => {
    setup({ view: ALERTS, back: [HOME] });
    const user = await writing();
    // Shell keys aren't taken in a text field: from the form's heading.
    act(() => screen.getByRole("heading", { level: 2, name: "New alert rule" }).focus());
    altKey("ArrowLeft", "ArrowLeft");
    expect(screen.getByRole("alertdialog", { name: ASK })).toBeTruthy();
    await user.click(within(screen.getByRole("alertdialog", { name: ASK })).getByRole("button", { name: "Stay" }));
    expect(screen.getByRole("heading", { level: 2, name: "New alert rule" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(within(screen.getByRole("alertdialog", { name: ASK })).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Alerts" })).toBeNull());
  });

  it("switching Monitoring tabs keeps the form, and closing its tab asks", async () => {
    setup({ view: ALERTS }, { view: HOME });
    const user = await writing();
    await user.click(monitoringTabs()[1]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
    await user.click(monitoringTabs()[0]);
    const name = await screen.findByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Half written");
    expect(screen.getByRole("heading", { level: 2, name: "New alert rule" })).toBeTruthy();
    // Closing the tab asks; Discard changes closes it.
    altKey("w", "KeyW");
    const ask = screen.getByRole("alertdialog", { name: ASK });
    expect(monitoringTabs()).toHaveLength(2);
    await user.click(within(ask).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(monitoringTabs()).toHaveLength(1));
    expect(ruleFormSessions.size).toBe(0);
  });

  it("an untouched form never asks", async () => {
    setup({ view: ALERTS, back: [HOME] }, { view: HOME });
    const user = await writing({ change: false });
    await user.click(monitoringTabs()[1]);
    await user.click(monitoringTabs()[0]);
    await screen.findByRole("heading", { level: 2, name: "Slow checkout" });
    await user.click(screen.getByRole("button", { name: "New alert rule" }));
    await screen.findByLabelText("Name");
    act(() => screen.getByRole("heading", { level: 2, name: "New alert rule" }).focus());
    altKey("ArrowLeft", "ArrowLeft");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Alerts" })).toBeNull());
    await user.click(await screen.findByRole("treeitem", { name: "Shop" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(await screen.findByRole("heading", { level: 1, name: "Shop" })).toBeTruthy();
  });

  it("closing or reloading the browser tab asks while a form has changes", () => {
    const unload = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    startRuleForm("m9", { mode: "new" }, 1);
    expect(unload()).toBe(false);
    keepRuleForm("m9", { base: undefined, draft: {}, start: {}, thresholdText: "1" }, true, "Half written");
    expect(unload()).toBe(true);
    endRuleForm("m9");
    expect(unload()).toBe(false);
  });
});

// The Silences and Contact points forms keep nothing outside their page (never a secret): every
// way out of their tab asks while they have changes, switching Monitoring tabs included.
describe("leaving a silence or contact point being written", () => {
  const SILENCES: MonitoringView = { page: "alerts", tab: "silences" };
  const CONTACTS: MonitoringView = { page: "alerts", tab: "contacts" };
  const ASK_SILENCE = 'Leave "New silence" with unsaved changes?';

  afterEach(() => { for (const id of [...alertFormMarks.keys()]) clearAlertForms(id); });

  async function silencing() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New silence" }, { timeout: 3000 }));
    await user.type(await screen.findByLabelText("Matchers"), 'alertname="A"');
    return user;
  }

  it("the sidebar asks first; Stay keeps it, Discard changes leaves", async () => {
    setup({ view: SILENCES });
    const user = await silencing();
    expect([...(alertFormMarks.get("m0")?.values() ?? [])]).toEqual([{ title: "New silence", tab: "silences" }]);
    await user.click(await screen.findByRole("treeitem", { name: "Shop" }));
    const ask = screen.getByRole("alertdialog", { name: ASK_SILENCE });
    expect(within(ask).getByText("Leaving loses what you entered in this form.")).toBeTruthy();
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Stay" }));
    await user.click(within(ask).getByRole("button", { name: "Stay" }));
    expect((screen.getByLabelText("Matchers") as HTMLInputElement).value).toBe('alertname="A"');
    await user.click(screen.getByRole("treeitem", { name: "Shop" }));
    await user.click(within(screen.getByRole("alertdialog", { name: ASK_SILENCE })).getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Shop" })).toBeTruthy();
    expect(alertFormMarks.size).toBe(0);
    await frame();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("switching Monitoring tabs, Back and closing the tab ask first", async () => {
    setup({ view: SILENCES, back: [HOME] }, { view: HOME });
    const user = await silencing();
    await user.click(monitoringTabs()[1]);
    const ask = screen.getByRole("alertdialog", { name: ASK_SILENCE });
    await user.click(within(ask).getByRole("button", { name: "Stay" }));
    expect((screen.getByLabelText("Matchers") as HTMLInputElement).value).toBe('alertname="A"');
    act(() => screen.getByRole("heading", { level: 1, name: "Alerts" }).focus());
    altKey("ArrowLeft", "ArrowLeft");
    await user.click(within(screen.getByRole("alertdialog", { name: ASK_SILENCE })).getByRole("button", { name: "Stay" }));
    altKey("w", "KeyW");
    await user.click(within(screen.getByRole("alertdialog", { name: ASK_SILENCE })).getByRole("button", { name: "Stay" }));
    expect(monitoringTabs()).toHaveLength(2);
    // Discard changes on a switch goes to the other tab.
    await user.click(monitoringTabs()[1]);
    await user.click(within(screen.getByRole("alertdialog", { name: ASK_SILENCE })).getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(monitoringTabs()[1].getAttribute("aria-selected")).toBe("true"));
    expect(alertFormMarks.size).toBe(0);
  });

  it("an untouched form never asks, and a contact point being added asks too", async () => {
    setup({ view: SILENCES }, { view: CONTACTS });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New silence" }, { timeout: 3000 }));
    await screen.findByLabelText("Matchers");
    await user.click(monitoringTabs()[1]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Add a contact point" }));
    await user.type(await screen.findByLabelText("Name"), "Ops");
    await user.click(await screen.findByRole("treeitem", { name: "Shop" }));
    expect(screen.getByRole("alertdialog", { name: 'Leave "New contact point" with unsaved changes?' })).toBeTruthy();
  });

  it("closing or reloading the browser tab asks while a form has changes", () => {
    const unload = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    markAlertForm("m9", "f1", { title: "New silence", tab: "silences" });
    expect(unload()).toBe(true);
    markAlertForm("m9", "f1", null);
    expect(unload()).toBe(false);
  });
});

describe("a close-only mark", () => {
  const SETUP_MARK: AlertFormMark = { title: "New project", page: "setup", closeOnly: true };
  const tabs: AppTabs<MonitoringView> = {
    tabs: [
      { id: "a", view: { page: "setup" }, back: [HOME], forward: [ALERTS], scrollTop: 0 },
      { id: "b", view: HOME, back: [], forward: [], scrollTop: 0 },
    ],
    active: "a", closed: [],
  };
  const marks = (...list: AlertFormMark[]) => new Map([["a", new Map(list.map((m, i) => [`f${i}`, m]))]]);

  it("a close-only mark holds only closing the tab", () => {
    const only = marks(SETUP_MARK);
    // Every other way out keeps the setup draft: none of them asks.
    expect(heldFormLeave({ type: "navigate", id: "a", view: HOME, mode: "push" }, tabs, only)).toBeNull();
    expect(heldFormLeave({ type: "back", id: "a" }, tabs, only)).toBeNull();
    expect(heldFormLeave({ type: "forward", id: "a" }, tabs, only)).toBeNull();
    expect(heldFormLeave({ type: "activateTab", id: "b" }, tabs, only)).toBeNull();
    expect(heldFormLeave({ type: "nextTab" }, tabs, only)).toBeNull();
    expect(heldFormLeave({ type: "newTab" }, tabs, only)).toBeNull();
    expect(heldFormLeave({ type: "closeTab", id: "a" }, tabs, only)).toEqual({ tabId: "a", title: "New project", mark: SETUP_MARK });
    // A form with changes on the same tab holds as before, and names the question when the tab closes.
    const hand: AlertFormMark = { title: "New source", page: "setup" };
    const both = marks(SETUP_MARK, hand);
    expect(heldFormLeave({ type: "closeTab", id: "a" }, tabs, both)?.mark).toBe(hand);
    expect(heldFormLeave({ type: "activateTab", id: "b" }, tabs, both)?.mark).toBe(hand);
    expect(heldFormLeave({ type: "navigate", id: "a", view: HOME, mode: "push" }, tabs, both)?.mark).toBe(hand);
  });

  it("a mark about one item holds going to another item's page of the same kind", () => {
    const onSource: AppTabs<MonitoringView> = {
      tabs: [{ id: "a", view: { page: "source", id: "s1" }, back: [{ page: "source", id: "s2" }], forward: [], scrollTop: 0 }],
      active: "a", closed: [],
    };
    const edited = marks({ title: "Prom", page: "source", id: "s1" });
    expect(heldFormLeave({ type: "navigate", id: "a", view: { page: "source", id: "s1" }, mode: "push" }, onSource, edited)).toBeNull();
    expect(heldFormLeave({ type: "navigate", id: "a", view: { page: "source", id: "s2" }, mode: "push" }, onSource, edited)?.title).toBe("Prom");
    expect(heldFormLeave({ type: "back", id: "a" }, onSource, edited)?.title).toBe("Prom");
    // Without an item, any view of the page keeps the form (the Sources list's forms).
    const listed = marks({ title: "New source", page: "sources" });
    expect(heldFormLeave({ type: "navigate", id: "a", view: { page: "sources" }, mode: "replace" }, onSource, listed)).toBeNull();
  });

  it("a close-only mark doesn't ask before a reload: the setup draft survives it", () => {
    const unload = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    markAlertForm("m9", "setup", SETUP_MARK);
    expect(unload()).toBe(false);
    expect(alertFormMarks.get("m9")?.get("setup")).toEqual(SETUP_MARK);
    markAlertForm("m9", "setup", null);
    expect(alertFormMarks.has("m9")).toBe(false);
  });
});
