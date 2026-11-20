import { describe, expect, it } from "vitest";
import {
  defaultMonitoringTabs, MONITORING_HOME, monitoringTabLabel, monitoringTabsReducer, parseMonitoringTabs, sameMonitoringView,
  type MonitoringView,
} from "./tabState";

const project = (id: string): MonitoringView => ({ page: "project", id });

describe("monitoring tab state", () => {
  it("closing the last Monitoring tab leaves a Home tab", () => {
    let tabs = defaultMonitoringTabs();
    const first = tabs.active;
    tabs = monitoringTabsReducer(tabs, { type: "navigate", id: first, view: project("p1"), mode: "push" });
    tabs = monitoringTabsReducer(tabs, { type: "closeTab", id: first, replacementId: "fresh", closedAt: 7 });
    expect(tabs.tabs).toEqual([{ id: "fresh", view: MONITORING_HOME, back: [], forward: [], scrollTop: 0 }]);
    expect(tabs.active).toBe("fresh");
    expect(tabs.closed).toHaveLength(1);
    expect(tabs.closed[0]).toMatchObject({ closedAt: 7, tab: { id: first, view: project("p1") } });
    // A Home tab is not kept among the closed ones.
    tabs = monitoringTabsReducer(tabs, { type: "closeTab", id: "fresh", replacementId: "again", closedAt: 8 });
    expect(tabs.closed).toHaveLength(1);
    expect(tabs.tabs.map((t) => t.id)).toEqual(["again"]);
  });

  it("navigate push keeps back history up to 50", () => {
    let tabs = defaultMonitoringTabs();
    const id = tabs.active;
    for (let i = 0; i < 60; i++) tabs = monitoringTabsReducer(tabs, { type: "navigate", id, view: project(`p${i}`), mode: "push" });
    const tab = tabs.tabs[0];
    expect(tab.view).toEqual(project("p59"));
    expect(tab.back).toHaveLength(50);
    expect(tab.back[49]).toEqual(project("p58"));
    tabs = monitoringTabsReducer(tabs, { type: "back", id });
    expect(tabs.tabs[0].view).toEqual(project("p58"));
    expect(tabs.tabs[0].forward).toEqual([project("p59")]);
    tabs = monitoringTabsReducer(tabs, { type: "forward", id });
    expect(tabs.tabs[0].view).toEqual(project("p59"));
    // Replace changes the view without adding history; the same view is a no-op.
    const before = tabs;
    expect(monitoringTabsReducer(before, { type: "navigate", id, view: project("p59"), mode: "push" })).toBe(before);
    tabs = monitoringTabsReducer(tabs, { type: "navigate", id, view: { page: "sources" }, mode: "replace" });
    expect(tabs.tabs[0].back).toHaveLength(50);
  });

  it("opens, moves between and scrolls tabs", () => {
    let tabs = defaultMonitoringTabs();
    const first = tabs.active;
    tabs = monitoringTabsReducer(tabs, { type: "newTab", id: "second", view: { page: "alerts" } });
    expect(tabs.tabs.map((t) => t.id)).toEqual([first, "second"]);
    expect(tabs.active).toBe("second");
    tabs = monitoringTabsReducer(tabs, { type: "nextTab" });
    expect(tabs.active).toBe(first);
    tabs = monitoringTabsReducer(tabs, { type: "previousTab" });
    expect(tabs.active).toBe("second");
    tabs = monitoringTabsReducer(tabs, { type: "activateTab", id: first });
    expect(tabs.active).toBe(first);
    tabs = monitoringTabsReducer(tabs, { type: "scroll", id: "second", top: 120 });
    expect(tabs.tabs[1].scrollTop).toBe(120);
    expect(monitoringTabsReducer(tabs, { type: "activateTab", id: "missing" })).toBe(tabs);
  });

  it("parseMonitoringTabs drops unknown pages and keeps the rest", () => {
    const input = {
      tabs: [
        { id: "a", view: { page: "dashboard", id: "x" }, back: [], forward: [], scrollTop: 0 },
        { id: "b", view: { page: "project", id: "p1" }, back: [{ page: "dashboard", id: "x" }, { page: "home" }], forward: [], scrollTop: 3 },
      ],
      active: "a",
      closed: [],
    };
    const { tabs, dropped } = parseMonitoringTabs(input);
    expect(dropped).toBe(1);
    expect(tabs.tabs).toEqual([{ id: "b", view: project("p1"), back: [MONITORING_HOME], forward: [], scrollTop: 3 }]);
    expect(tabs.active).toBe("b");
  });

  it("parseMonitoringTabs refuses empty and overlong ids", () => {
    const tab = (id: string, view: unknown) => ({ id, view, back: [], forward: [], scrollTop: 0 });
    const { tabs, dropped } = parseMonitoringTabs({
      tabs: [tab("a", { page: "project", id: "" }), tab("b", { page: "group", id: "g".repeat(201) }), tab("c", { page: "setup", clusterId: "k1" }), tab("", { page: "home" })],
      active: "c",
      closed: [],
    });
    expect(dropped).toBe(3);
    expect(tabs.tabs.map((t) => t.view)).toEqual([{ page: "setup", clusterId: "k1" }]);
  });

  it("parseMonitoringTabs starts fresh when nothing was saved", () => {
    const { tabs, dropped } = parseMonitoringTabs(undefined);
    expect(dropped).toBe(0);
    expect(tabs.tabs).toHaveLength(1);
    expect(tabs.tabs[0].view).toEqual(MONITORING_HOME);
  });

  it("monitoringTabLabel names a project or falls back", () => {
    const names = { project: (id: string) => (id === "p1" ? "Payments" : undefined) };
    expect(monitoringTabLabel(project("p1"), names)).toBe("Payments");
    expect(monitoringTabLabel(project("gone"), names)).toBe("Project");
    expect(monitoringTabLabel({ page: "group", id: "g" }, {})).toBe("Group");
    expect(monitoringTabLabel({ page: "source", id: "s" }, { source: () => "Prometheus" })).toBe("Prometheus");
    expect(monitoringTabLabel(MONITORING_HOME, {})).toBe("Home");
    expect(monitoringTabLabel({ page: "setup" }, {})).toBe("New project");
    expect(monitoringTabLabel({ page: "newGroup" }, {})).toBe("New group");
  });

  it("compares views by page and id", () => {
    expect(sameMonitoringView(project("a"), project("a"))).toBe(true);
    expect(sameMonitoringView(project("a"), project("b"))).toBe(false);
    expect(sameMonitoringView(project("a"), { page: "group", id: "a" })).toBe(false);
    expect(sameMonitoringView({ page: "setup" }, { page: "setup", clusterId: "k" })).toBe(false);
  });
});
