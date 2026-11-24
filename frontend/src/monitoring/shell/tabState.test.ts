import { afterEach, describe, expect, it } from "vitest";
import {
  defaultMonitoringTabs, equalMonitoringView, MONITORING_HOME, monitoringLeaveHeld, monitoringTabLabel, monitoringTabsReducer, parseMonitoringTabs,
  sameMonitoringView, setMonitoringLeaveCheck, type MonitoringView,
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
        { id: "a", view: { page: "nope", id: "x" }, back: [], forward: [], scrollTop: 0 },
        { id: "b", view: { page: "project", id: "p1" }, back: [{ page: "nope", id: "x" }, { page: "home" }], forward: [], scrollTop: 3 },
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

  it("a tools view round-trips and is named", () => {
    const view: MonitoringView = { page: "tools", clusterId: "k1" };
    const tab = (id: string, v: unknown) => ({ id, view: v, back: [], forward: [], scrollTop: 0 });
    const { tabs, dropped } = parseMonitoringTabs(JSON.parse(JSON.stringify({
      tabs: [tab("a", view), tab("b", { page: "tools" }), tab("c", { page: "tools", clusterId: "k".repeat(201) }), tab("d", { page: "tools", clusterId: "" })],
      active: "a",
      closed: [],
    })));
    expect(dropped).toBe(3);
    expect(tabs.tabs.map((t) => t.view)).toEqual([view]);
    expect(monitoringTabLabel(view, { cluster: (id) => (id === "k1" ? "kind-dev" : undefined) })).toBe("Tools · kind-dev");
    expect(monitoringTabLabel(view, {})).toBe("Monitoring tools");
    expect(monitoringTabLabel({ page: "tools", clusterId: "gone" }, { cluster: () => undefined })).toBe("Monitoring tools");
    expect(sameMonitoringView(view, { page: "tools", clusterId: "k1" })).toBe(true);
    expect(sameMonitoringView(view, { page: "tools", clusterId: "k2" })).toBe(false);
    expect(sameMonitoringView(view, { page: "setup", clusterId: "k1" })).toBe(false);
    // A push to the same cluster's tools changes nothing; another cluster's is a new place.
    let state = defaultMonitoringTabs();
    const id = state.active;
    state = monitoringTabsReducer(state, { type: "navigate", id, view, mode: "push" });
    const same = monitoringTabsReducer(state, { type: "navigate", id, view: { page: "tools", clusterId: "k1" }, mode: "push" });
    expect(same).toBe(state);
  });

  it("compares views by page and id", () => {
    expect(sameMonitoringView(project("a"), project("a"))).toBe(true);
    expect(sameMonitoringView(project("a"), project("b"))).toBe(false);
    expect(sameMonitoringView(project("a"), { page: "group", id: "a" })).toBe(false);
    expect(sameMonitoringView({ page: "setup" }, { page: "setup", clusterId: "k" })).toBe(false);
  });

  it("a dashboard view survives storage with its view state", () => {
    const view: MonitoringView = {
      page: "dashboard", id: "d1", tab: "json", vars: { namespace: ["api"] }, time: { from: "now-1h", to: "now" }, refresh: "30s",
    };
    const saved = JSON.parse(JSON.stringify({ tabs: [{ id: "a", view, back: [{ page: "dashboard", id: "d0", refresh: null }], forward: [], scrollTop: 0 }], active: "a", closed: [] }));
    const { tabs, dropped } = parseMonitoringTabs(saved);
    expect(dropped).toBe(0);
    expect(tabs.tabs[0].view).toEqual(view);
    expect(tabs.tabs[0].back).toEqual([{ page: "dashboard", id: "d0", refresh: null }]);
    const all: MonitoringView = { page: "dashboard", id: "g", vars: { __projects: ["p1", "p2"], pod: "all" } };
    expect(parseMonitoringTabs({ tabs: [{ id: "a", view: all }], active: "a" }).tabs.tabs[0].view).toEqual(all);
  });

  it("bad dashboard view state is dropped, the view kept", () => {
    const parse = (view: unknown) => {
      const { tabs, dropped } = parseMonitoringTabs({ tabs: [{ id: "a", view, back: [], forward: [], scrollTop: 0 }], active: "a", closed: [] });
      expect(dropped).toBe(0);
      return tabs.tabs[0].view;
    };
    const bare = { page: "dashboard", id: "d1" };
    expect(parse({ ...bare, vars: { a: 5 } })).toEqual(bare);
    expect(parse({ ...bare, tab: "settings", time: { from: 1, to: "now" }, refresh: 30 })).toEqual(bare);
    expect(parse({ ...bare, time: { from: "x".repeat(41), to: "now" }, refresh: "x".repeat(11) })).toEqual(bare);
    expect(parse({ ...bare, time: { from: "now-1h" } })).toEqual(bare);
    const keys = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`v${i}`, "all"]));
    expect(parse({ ...bare, vars: keys(22) })).toEqual(bare);
    expect(parse({ ...bare, vars: keys(21) })).toEqual({ ...bare, vars: keys(21) });
    expect(parse({ ...bare, vars: { a: Array.from({ length: 101 }, () => "x") } })).toEqual(bare);
    expect(parse({ ...bare, vars: { a: ["x".repeat(201)] } })).toEqual(bare);
    expect(parse({ ...bare, vars: { a: [1] } })).toEqual(bare);
    expect(parse({ ...bare, vars: { a: "some" } })).toEqual(bare);
    expect(parse({ ...bare, vars: ["a"] })).toEqual(bare);
    // The dashboard itself must be named: no id, or an overlong one, drops the tab.
    const { dropped } = parseMonitoringTabs({ tabs: [{ id: "a", view: { page: "dashboard", id: "" } }, { id: "b", view: { page: "dashboard", id: "d".repeat(201) } }] });
    expect(dropped).toBe(2);
  });

  it("an alerts view keeps its tab and selected rule through storage", () => {
    const view: MonitoringView = { page: "alerts", tab: "silences", rule: "r1" };
    const saved = JSON.parse(JSON.stringify({ tabs: [{ id: "a", view, back: [{ page: "alerts", tab: "contacts" }], forward: [], scrollTop: 0 }], active: "a", closed: [] }));
    const { tabs, dropped } = parseMonitoringTabs(saved);
    expect(dropped).toBe(0);
    expect(tabs.tabs[0].view).toEqual(view);
    expect(tabs.tabs[0].back).toEqual([{ page: "alerts", tab: "contacts" }]);
    const parse = (v: unknown) => parseMonitoringTabs({ tabs: [{ id: "a", view: v }], active: "a" }).tabs.tabs[0].view;
    // Each bad part is dropped on its own; the view stays.
    expect(parse({ page: "alerts", tab: "history", rule: "r1" })).toEqual({ page: "alerts", rule: "r1" });
    expect(parse({ page: "alerts", tab: "rules", rule: 5 })).toEqual({ page: "alerts", tab: "rules" });
    expect(parse({ page: "alerts", rule: "r".repeat(201) })).toEqual({ page: "alerts" });
    expect(parse({ page: "alerts" })).toEqual({ page: "alerts" });
  });

  it("alerts views are the same place whatever their tab or rule", () => {
    expect(sameMonitoringView({ page: "alerts", tab: "rules" }, { page: "alerts", rule: "r1" })).toBe(true);
    expect(equalMonitoringView({ page: "alerts", tab: "rules" }, { page: "alerts", rule: "r1" })).toBe(false);
    let tabs = defaultMonitoringTabs();
    const id = tabs.active;
    tabs = monitoringTabsReducer(tabs, { type: "navigate", id, view: { page: "alerts" }, mode: "push" });
    tabs = monitoringTabsReducer(tabs, { type: "navigate", id, view: { page: "alerts", rule: "r1" }, mode: "replace" });
    expect(tabs.tabs[0].view).toEqual({ page: "alerts", rule: "r1" });
    expect(tabs.tabs[0].back).toEqual([MONITORING_HOME]);
  });

  it("a dashboard view keeps the panel to show and the alert to edit", () => {
    const view: MonitoringView = { page: "dashboard", id: "d1", panel: "p-2", editAlert: true };
    const parse = (v: unknown) => parseMonitoringTabs({ tabs: [{ id: "a", view: v }], active: "a" }).tabs.tabs[0].view;
    expect(parse(JSON.parse(JSON.stringify(view)))).toEqual(view);
    const bare = { page: "dashboard", id: "d1" };
    expect(parse({ ...bare, panel: 5, editAlert: "yes" })).toEqual(bare);
    expect(parse({ ...bare, panel: "p".repeat(201), editAlert: false })).toEqual(bare);
    expect(sameMonitoringView(view, bare as MonitoringView)).toBe(true);
  });

  it("dashboard tabs are labelled by title", () => {
    const names = { dashboard: (id: string) => (id === "d1" ? "API latency" : undefined) };
    expect(monitoringTabLabel({ page: "dashboard", id: "d1" }, names)).toBe("API latency");
    expect(monitoringTabLabel({ page: "dashboard", id: "gone" }, names)).toBe("Dashboard");
    expect(monitoringTabLabel({ page: "dashboard", id: "d1" }, {})).toBe("Dashboard");
  });

  it("same dashboard with other variables is the same view", () => {
    const a: MonitoringView = { page: "dashboard", id: "d1", tab: "dashboard", vars: { ns: ["api"] }, time: { from: "now-1h", to: "now" } };
    const b: MonitoringView = { page: "dashboard", id: "d1", tab: "dashboard", vars: { ns: ["web"] }, refresh: "1m" };
    expect(sameMonitoringView(a, b)).toBe(true);
    expect(equalMonitoringView(a, b)).toBe(false);
    expect(sameMonitoringView(a, { ...a, tab: "json" })).toBe(false);
    expect(sameMonitoringView(a, { ...a, id: "d2" })).toBe(false);
    expect(sameMonitoringView({ page: "dashboard", id: "d1" }, { page: "dashboard", id: "d1", tab: "dashboard" })).toBe(true);
    expect(equalMonitoringView(a, { ...a, vars: { ns: ["api"] }, time: { to: "now", from: "now-1h" } })).toBe(true);
  });

  it("an explore view survives storage with its state", () => {
    const view: MonitoringView = { page: "explore", project: "p1", source: "s1", expr: "up", logs: '{app="api"}', time: { from: "now-1h", to: "now" } };
    const saved = JSON.parse(JSON.stringify({ tabs: [{ id: "a", view, back: [{ page: "explore" }], forward: [], scrollTop: 0 }], active: "a", closed: [] }));
    const { tabs, dropped } = parseMonitoringTabs(saved);
    expect(dropped).toBe(0);
    expect(tabs.tabs[0].view).toEqual(view);
    expect(tabs.tabs[0].back).toEqual([{ page: "explore" }]);
    expect(monitoringTabLabel(view, {})).toBe("Explore");
    // Empty query text is still a query (the user cleared it).
    const empty: MonitoringView = { page: "explore", project: "p1", expr: "", logs: "" };
    expect(parseMonitoringTabs({ tabs: [{ id: "a", view: empty }] }).tabs.tabs[0].view).toEqual(empty);
  });

  it("bad explore state is dropped, the view kept", () => {
    const parse = (view: unknown) => {
      const { tabs, dropped } = parseMonitoringTabs({ tabs: [{ id: "a", view, back: [], forward: [], scrollTop: 0 }], active: "a", closed: [] });
      expect(dropped).toBe(0);
      return tabs.tabs[0].view;
    };
    const bare = { page: "explore" };
    expect(parse({ ...bare, expr: 5 })).toEqual(bare);
    expect(parse({ ...bare, project: "p1", expr: 5 })).toEqual({ ...bare, project: "p1" });
    expect(parse({ ...bare, project: "", source: "" })).toEqual(bare);
    expect(parse({ ...bare, project: "p".repeat(201), source: 7 })).toEqual(bare);
    expect(parse({ ...bare, project: "p".repeat(200) })).toEqual({ ...bare, project: "p".repeat(200) });
    expect(parse({ ...bare, expr: "x".repeat(10001), logs: null })).toEqual(bare);
    expect(parse({ ...bare, expr: "x".repeat(10000) })).toEqual({ ...bare, expr: "x".repeat(10000) });
    expect(parse({ ...bare, time: { from: "x".repeat(41), to: "now" } })).toEqual(bare);
    expect(parse({ ...bare, time: { from: "now-1h" } })).toEqual(bare);
    expect(parse({ ...bare, time: "now-1h" })).toEqual(bare);
    expect(parse({ ...bare, extra: "kept out" })).toEqual(bare);
  });

  it("explore views in different projects are different views", () => {
    const a: MonitoringView = { page: "explore", project: "p1", expr: "up" };
    expect(sameMonitoringView(a, { page: "explore", project: "p1", expr: "rate(x[5m])", source: "s2" })).toBe(true);
    expect(sameMonitoringView(a, { page: "explore", project: "p2", expr: "up" })).toBe(false);
    expect(sameMonitoringView(a, { page: "explore" })).toBe(false);
    expect(sameMonitoringView({ page: "explore" }, { page: "explore" })).toBe(true);
    expect(equalMonitoringView(a, { ...a, expr: "up2" })).toBe(false);
  });

  it("replace with new time changes the view; back history unchanged", () => {
    let tabs = defaultMonitoringTabs();
    const id = tabs.active;
    const dash: MonitoringView = { page: "dashboard", id: "d1", tab: "dashboard", time: { from: "now-1h", to: "now" } };
    tabs = monitoringTabsReducer(tabs, { type: "navigate", id, view: project("p1"), mode: "push" });
    tabs = monitoringTabsReducer(tabs, { type: "navigate", id, view: dash, mode: "push" });
    const back = tabs.tabs[0].back;
    const later: MonitoringView = { ...dash, time: { from: "now-6h", to: "now" } };
    tabs = monitoringTabsReducer(tabs, { type: "navigate", id, view: later, mode: "replace" });
    expect(tabs.tabs[0].view).toEqual(later);
    expect(tabs.tabs[0].back).toBe(back);
    // The same value again changes nothing; a push of the same dashboard is still a no-op.
    expect(monitoringTabsReducer(tabs, { type: "navigate", id, view: { ...later }, mode: "replace" })).toBe(tabs);
    expect(monitoringTabsReducer(tabs, { type: "navigate", id, view: { ...dash, refresh: "5m" }, mode: "push" })).toBe(tabs);
  });

  describe("the leave check", () => {
    afterEach(() => setMonitoringLeaveCheck(null));

    it("a held close does not close the tab", () => {
      expect(monitoringLeaveHeld({ type: "closeTab", id: "a" })).toBe(false);
      setMonitoringLeaveCheck((a) => a.type === "closeTab");
      expect(monitoringLeaveHeld({ type: "closeTab", id: "a" })).toBe(true);
      expect(monitoringLeaveHeld({ type: "nextTab" })).toBe(false);
      setMonitoringLeaveCheck(null);
      expect(monitoringLeaveHeld({ type: "closeTab", id: "a" })).toBe(false);
      expect(monitoringLeaveHeld({ type: "nextTab" })).toBe(false);
    });

    it("asks only about ways out of a tab's page", () => {
      const asked: string[] = [];
      setMonitoringLeaveCheck((a) => { asked.push(a.type); return true; });
      expect(monitoringLeaveHeld({ type: "navigate", id: "a", view: MONITORING_HOME, mode: "push" })).toBe(true);
      expect(monitoringLeaveHeld({ type: "back", id: "a" })).toBe(true);
      expect(monitoringLeaveHeld({ type: "forward", id: "a" })).toBe(true);
      for (const action of [{ type: "newTab" }, { type: "activateTab", id: "a" }, { type: "nextTab" }, { type: "previousTab" }, { type: "scroll", id: "a", top: 1 }] as const) {
        expect(monitoringLeaveHeld(action)).toBe(false);
      }
      expect(asked).toEqual(["navigate", "back", "forward"]);
    });
  });
});
