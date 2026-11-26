import { describe, expect, it } from "vitest";
import { allGroups, barFor, isDeleteKey, keysFor, pressed, rowShortcut, SHORTCUTS } from "./shortcuts";

const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

describe("shortcut registry", () => {
  it("delete key is ctrl+delete or cmd+backspace only", () => {
    expect(isDeleteKey({ ...base, key: "Delete", ctrlKey: true })).toBe(true);
    expect(isDeleteKey({ ...base, key: "Backspace", metaKey: true })).toBe(true);
    expect(isDeleteKey({ ...base, key: "Backspace", ctrlKey: true })).toBe(false);
    expect(isDeleteKey({ ...base, key: "Delete" })).toBe(false);
    expect(isDeleteKey({ ...base, key: "Delete", ctrlKey: true, altKey: true })).toBe(false);
    expect(isDeleteKey({ ...base, key: "Delete", ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it("ctrl+delete on a row means delete only where delete is offered", () => {
    const e = { ...base, key: "Delete", ctrlKey: true };
    expect(rowShortcut(e, "pods", ["details", "delete"])).toBe("delete");
    expect(rowShortcut(e, "pods", ["details"])).toBeUndefined();
  });

  it("shift+L pins and plain l follows", () => {
    const available = ["logs", "pinLogs"];
    expect(rowShortcut({ ...base, key: "L", shiftKey: true }, "pods", available)).toBe("pinLogs");
    expect(rowShortcut({ ...base, key: "l" }, "pods", available)).toBe("logs");
    expect(rowShortcut({ ...base, key: "L" }, "pods", available)).toBeUndefined();
  });

  it("shift+l reported as a lower-case l still pins (caps lock, automation)", () => {
    const available = ["logs", "pinLogs"];
    expect(rowShortcut({ ...base, key: "l", shiftKey: true }, "pods", available)).toBe("pinLogs");
    expect(rowShortcut({ ...base, key: "L", shiftKey: true }, "pods", available)).toBe("pinLogs");
    expect(rowShortcut({ ...base, key: "l" }, "pods", available)).toBe("logs");
    expect(pressed("pinFollow", { ...base, key: "l", shiftKey: true })).toBe(true);
    // A lower-case letter shortcut never fires with Shift held; "?", ":" and "G" are unaffected.
    expect(pressed("logs", { ...base, key: "l", shiftKey: true })).toBe(false);
    expect(pressed("help", { ...base, key: "?", shiftKey: true })).toBe(true);
    expect(pressed("kinds", { ...base, key: ":", shiftKey: true })).toBe(true);
    expect(pressed("jumpLive", { ...base, key: "G", shiftKey: true })).toBe(true);
  });

  it("alt+down is not a row move", () => {
    const e = { ...base, key: "ArrowDown", altKey: true };
    expect(rowShortcut(e, "pods", ["logs", "pinLogs", "enterLogs"])).toBeUndefined();
    expect(pressed("enterLogs", e)).toBe(true);
  });

  it("the logs bar lists the zone's keys in order", () => {
    expect(barFor("pods", "logs", false).map((b) => [b.keys.join(" "), b.text])).toEqual([
      ["↑ ↓ PgUp PgDn", "scroll"],
      ["Home End", "top / live end"],
      ["← →", "switch tab"],
      ["Ctrl F", "search"],
      ["Shift L", "pin this log"],
      ["Ctrl Del", "close the tab"],
      ["Esc Alt ↑", "back to the table"],
    ]);
  });

  it("the shell bar says alt up goes back", () => {
    expect(barFor("pods", "shell", false).map((b) => [b.keys.join(" "), b.text])).toEqual([["Alt ↑", "back to the table"]]);
  });

  it("the pods table bar reads short words", () => {
    const texts = barFor("pods", "table", false).map((b) => b.text);
    const order = ["logs", "pin a log", "previous logs", "into the logs", "delete"];
    const at = order.map((t) => texts.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(texts.some((t) => t.includes("("))).toBe(false);
    expect(texts).not.toContain("search logs");
    expect(texts.filter((t) => t === "into the logs")).toHaveLength(1);
    expect(barFor(undefined, "table", false).some((b) => b.id === "logs")).toBe(false);
  });

  it("the help sheet keeps the full sentences", () => {
    expect(SHORTCUTS.find((e) => e.id === "logs")?.label).toBe("Logs of the selected pod (they follow the row you select)");
    expect(SHORTCUTS.find((e) => e.id === "deleteFocused")?.label).toBe("Delete what has the focus: a resource row (reviewed first) or a dock tab");
  });

  it("macOS keycaps show cmd backspace", () => {
    expect(barFor("pods", "table", true).find((b) => b.id === "deleteFocused")?.keys).toEqual(["⌘ ⌫"]);
  });

  it("help lists ctrl+enter for reviews", () => {
    const anywhere = allGroups().find(([t]) => t === "Anywhere")![1];
    const confirm = anywhere.find((s) => s.id === "confirmReview");
    expect(confirm?.keys).toEqual(["Ctrl Enter"]);
    expect(confirm?.label).toBe("Confirm the open review (Enter on its focused button too)");
    expect(confirm?.bar).toBeUndefined();
    expect(keysFor("confirmReview", true)).toEqual(["⌘ Enter"]);
    expect(pressed("confirmReview", { ...base, key: "Enter", ctrlKey: true })).toBe(true);
    expect(pressed("confirmReview", { ...base, key: "Enter", metaKey: true })).toBe(true);
    expect(pressed("confirmReview", { ...base, key: "Enter" })).toBe(false);
  });

  it("help lists the detail tab keys", () => {
    const table = allGroups("pods").find(([title]) => title === "Table")![1];
    expect(table.find((s) => s.id === "detailTab")?.keys).toEqual(["1–4"]);
    expect(rowShortcut({ ...base, key: "2" }, "pods", ["logs", "shell"])).toBeUndefined();
  });

  it("help lists both zones", () => {
    const groups = allGroups("pods");
    expect(groups.map(([t]) => t)).toEqual(["Apps and tabs", "Table", "Logs", "Anywhere", "Dock"]);
    const ids = (title: string) => groups.find(([t]) => t === title)![1].map((s) => s.id);
    expect(ids("Table")).toEqual(expect.arrayContaining(["pinLogs", "enterLogs"]));
    expect(ids("Logs")).toEqual(expect.arrayContaining(["backToTable", "leaveLogs", "pinFollow"]));
    expect(SHORTCUTS.some((s) => (s.id as string) === "closeLog")).toBe(false);
    expect(SHORTCUTS.some((s) => s.label.includes("Close the focused log"))).toBe(false);
  });

  it("the apps label lists Monitoring", () => {
    expect(SHORTCUTS.find((s) => s.id === "apps")?.label).toBe("Switch app (Kubernetes 1, Monitoring 2, Audit 8, Settings 9)");
  });

  it("help shows the Monitoring group only in Monitoring", () => {
    expect(allGroups(undefined, "kubernetes").map(([t]) => t)).not.toContain("Monitoring");
    expect(allGroups("pods").map(([t]) => t)).not.toContain("Monitoring");
    const monitoring = allGroups(undefined, "monitoring").find(([t]) => t === "Monitoring")![1];
    expect(monitoring.map((s) => [s.id, s.keys, s.label])).toEqual([
      ["monitoringFind", ["/", "Ctrl K"], "Find a project, group or source"],
      ["monitoringTree", ["↑ ↓", "← →", "Enter"], "In the sidebar: move, close or open a group, open the item"],
      ["monitoringNewDashboard", ["N"], "New dashboard"],
      ["monitoringImport", ["I"], "Import dashboards"],
    ]);
  });

  it("I imports in Monitoring only", () => {
    expect(pressed("monitoringImport", { ...base, key: "i" })).toBe(true);
    expect(pressed("monitoringImport", { ...base, key: "I", shiftKey: true })).toBe(true);
    expect(pressed("monitoringImport", { ...base, key: "i", ctrlKey: true })).toBe(false);
    expect(pressed("monitoringImport", { ...base, key: "n" })).toBe(false);
    expect(SHORTCUTS.find((s) => s.id === "monitoringImport")).toMatchObject({ scope: "monitoring", keys: ["I"], label: "Import dashboards" });
    expect(allGroups(undefined, "kubernetes").flatMap(([, list]) => list.map((s) => s.id))).not.toContain("monitoringImport");
    expect(allGroups(undefined, "monitoring").find(([t]) => t === "Monitoring")![1].map((s) => s.label)).toContain("Import dashboards");
  });

  it("the Dashboards group appears only in Monitoring", () => {
    const titles = allGroups(undefined, "monitoring").map(([t]) => t);
    const at = titles.indexOf("Monitoring");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(titles.slice(at, at + 3)).toEqual(["Monitoring", "Dashboards", "Explore"]);
    for (const title of ["Monitoring", "Dashboards", "Explore"]) {
      expect(allGroups().map(([t]) => t)).not.toContain(title);
      expect(allGroups("pods", "kubernetes").map(([t]) => t)).not.toContain(title);
    }
    const dashboards = allGroups(undefined, "monitoring").find(([t]) => t === "Dashboards")![1];
    expect(dashboards.map((s) => [s.id, s.keys, s.label])).toEqual([
      ["dashboardEdit", ["e"], "Edit the dashboard"],
      ["dashboardViews", ["1–3"], "Dashboard, JSON or Versions"],
      ["dashboardTime", ["t"], "Pick the time range"],
      ["dashboardRefresh", ["r"], "Refresh now"],
      ["dashboardSave", ["Ctrl S"], "While editing (in fields too): save the dashboard"],
      ["dashboardUndo", ["Ctrl Z"], "While editing: undo the last change"],
      ["panelFocus", ["← → ↑ ↓"], "While editing: move between panels"],
      ["panelMove", ["Shift ← → ↑ ↓"], "While editing: move the panel one step"],
      ["panelResize", ["Ctrl Shift ← → ↑ ↓"], "While editing: make the panel narrower, wider, shorter or taller"],
      ["panelSettings", ["Enter"], "While editing: open the panel's settings"],
      ["panelAdd", ["a"], "While editing: add a panel (type what you want to see)"],
      ["addPanelPick", ["↑ ↓ ← →", "Enter"], "In Add panel: move between results by row or card and add one (Ctrl+End: Empty panel; Esc clears, then closes)"],
      ["suggestionsFocus", ["s"], "While editing: show the suggestions and go to them"],
      ["panelRemove", ["Ctrl Del"], "While editing: remove the panel from the draft"],
      ["panelDuplicate", ["d"], "While editing: duplicate the panel"],
      ["panelLeave", ["Esc"], "Close the panel's settings, then go to Save dashboard"],
      ["queryRun", ["Ctrl Enter"], "In a query: run it now; in the JSON: review the changes"],
      ["chartCrosshair", ["← →"], "On a chart: move the crosshair; Esc hides it"],
      ["tableSort", ["Enter"], "On a table column: sort by it"],
      ["logLabels", ["Enter"], "On a log line: show its labels"],
    ]);
    expect(keysFor("dashboardSave", true)).toEqual(["⌘ S"]);
    expect(keysFor("panelResize", true)).toEqual(["⌘ Shift ← → ↑ ↓"]);
    expect(keysFor("panelRemove", true)).toEqual(["⌘ ⌫"]);
    expect(keysFor("queryRun", true)).toEqual(["⌘ Enter"]);
  });

  it("the Alerts group appears after Explore", () => {
    const titles = allGroups(undefined, "monitoring").map(([t]) => t);
    const at = titles.indexOf("Monitoring");
    expect(titles.slice(at, at + 4)).toEqual(["Monitoring", "Dashboards", "Explore", "Alerts"]);
    expect(titles.filter((t) => t === "Alerts")).toHaveLength(1);
    expect(allGroups().map(([t]) => t)).not.toContain("Alerts");
    expect(allGroups("pods", "kubernetes").map(([t]) => t)).not.toContain("Alerts");
    const alerts = allGroups(undefined, "monitoring").find(([t]) => t === "Alerts")![1];
    expect(alerts.map((s) => [s.id, s.keys, s.label])).toEqual([
      ["alertsViews", ["1–3"], "Rules, Silences or Contact points"],
      ["alertsMove", ["↑ ↓"], "In the rule list: move and show the rule"],
      ["alertSilence", ["s"], "Silence the selected alert"],
      ["alertsDetails", ["Enter"], "In the rule list: go to the rule's details"],
      ["alertsList", ["Esc"], "In the details: back to the rule list"],
      ["alertsSave", ["Ctrl Enter"], "In a rule, silence or contact point form: save it"],
    ]);
    expect(keysFor("alertsSave", true)).toEqual(["⌘ Enter"]);
    expect(pressed("alertSilence", { key: "s", ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
    expect(pressed("alertsViews", { key: "2", ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
  });

  it("the Explore group appears only in Monitoring, after Dashboards", () => {
    const titles = allGroups(undefined, "monitoring").map(([t]) => t);
    const at = titles.indexOf("Dashboards");
    expect(titles[at + 1]).toBe("Explore");
    expect(titles.filter((t) => t === "Explore")).toHaveLength(1);
    expect(allGroups().map(([t]) => t)).not.toContain("Explore");
    expect(allGroups("pods", "kubernetes").map(([t]) => t)).not.toContain("Explore");
    const explore = allGroups(undefined, "monitoring").find(([t]) => t === "Explore")![1];
    expect(explore.map((s) => [s.id, s.keys, s.label])).toEqual([
      ["exploreQuery", ["q"], "Go to the query"],
      ["exploreBrowse", ["b"], "Go to the metric or log stream list"],
      ["exploreLogs", ["l"], "Go to the log lines"],
      ["exploreTime", ["t"], "Pick the time range"],
      ["exploreRun", ["Ctrl Enter"], "In the query: run it now"],
      ["exploreAdd", ["a"], "Add the query to a dashboard"],
      ["exploreWindow", ["Shift ← →"], "On the chart: select a time window for the log lines"],
      ["exploreShowAll", ["Esc"], "On the chart: show all log lines again"],
    ]);
    expect(keysFor("exploreRun", true)).toEqual(["⌘ Enter"]);
  });

  it("the help sheet lists undo and duplicate", () => {
    const dashboards = allGroups(undefined, "monitoring").find(([t]) => t === "Dashboards")![1];
    expect(dashboards.find((s) => s.id === "dashboardUndo")).toMatchObject({ keys: ["Ctrl Z"], label: "While editing: undo the last change" });
    expect(dashboards.find((s) => s.id === "panelDuplicate")).toMatchObject({ keys: ["d"], label: "While editing: duplicate the panel" });
    expect(keysFor("dashboardUndo", true)).toEqual(["⌘ Z"]);
    expect(keysFor("panelDuplicate", true)).toEqual(["d"]);
    expect(pressed("dashboardUndo", { ...base, key: "z", ctrlKey: true })).toBe(true);
    expect(pressed("dashboardUndo", { ...base, key: "z", metaKey: true })).toBe(true);
    expect(pressed("dashboardUndo", { ...base, key: "z" })).toBe(false);
    expect(pressed("dashboardUndo", { ...base, key: "z", ctrlKey: true, altKey: true })).toBe(false);
    expect(pressed("panelDuplicate", { ...base, key: "d" })).toBe(true);
    expect(pressed("panelDuplicate", { ...base, key: "d", ctrlKey: true })).toBe(false);
    expect(pressed("panelDuplicate", { ...base, key: "D", shiftKey: true })).toBe(false);
    // Kubernetes' help never lists them.
    const kube = allGroups("pods", "kubernetes").flatMap(([, list]) => list.map((s) => s.id));
    expect(kube).not.toContain("dashboardUndo");
    expect(kube).not.toContain("panelDuplicate");
  });

  it("explore keys match only as listed", () => {
    expect(pressed("exploreQuery", { ...base, key: "q" })).toBe(true);
    expect(pressed("exploreQuery", { ...base, key: "q", ctrlKey: true })).toBe(false);
    expect(pressed("exploreQuery", { ...base, key: "q", metaKey: true })).toBe(false);
    expect(pressed("exploreQuery", { ...base, key: "q", altKey: true })).toBe(false);
    expect(pressed("exploreWindow", { ...base, key: "ArrowLeft", shiftKey: true })).toBe(true);
    expect(pressed("exploreWindow", { ...base, key: "ArrowRight", shiftKey: true })).toBe(true);
    expect(pressed("exploreWindow", { ...base, key: "ArrowLeft" })).toBe(false);
    expect(pressed("exploreWindow", { ...base, key: "ArrowUp", shiftKey: true })).toBe(false);
    expect(pressed("exploreRun", { ...base, key: "Enter", ctrlKey: true })).toBe(true);
    expect(pressed("exploreRun", { ...base, key: "Enter", metaKey: true })).toBe(true);
    expect(pressed("exploreRun", { ...base, key: "Enter" })).toBe(false);
    expect(pressed("exploreTime", { ...base, key: "t" })).toBe(true);
    expect(pressed("exploreShowAll", { ...base, key: "Escape" })).toBe(true);
    expect(pressed("exploreBrowse", { ...base, key: "b" })).toBe(true);
    expect(pressed("exploreLogs", { ...base, key: "l" })).toBe(true);
    expect(pressed("exploreAdd", { ...base, key: "a" })).toBe(true);
    expect(pressed("suggestionsFocus", { ...base, key: "s" })).toBe(true);
    expect(pressed("suggestionsFocus", { ...base, key: "s", ctrlKey: true })).toBe(false);
    expect(pressed("addPanelPick", { ...base, key: "Enter" })).toBe(true);
    expect(pressed("addPanelPick", { ...base, key: "ArrowDown" })).toBe(true);
  });

  it("panel resize needs Ctrl and Shift with an arrow", () => {
    expect(pressed("panelResize", { ...base, key: "ArrowRight", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(pressed("panelResize", { ...base, key: "ArrowUp", metaKey: true, shiftKey: true })).toBe(true);
    expect(pressed("panelResize", { ...base, key: "ArrowRight", shiftKey: true })).toBe(false);
    expect(pressed("panelResize", { ...base, key: "ArrowRight", ctrlKey: true })).toBe(false);
    expect(pressed("panelMove", { ...base, key: "ArrowLeft", shiftKey: true })).toBe(true);
    expect(pressed("panelMove", { ...base, key: "ArrowLeft" })).toBe(false);
    expect(pressed("dashboardSave", { ...base, key: "s", ctrlKey: true })).toBe(true);
    expect(pressed("dashboardSave", { ...base, key: "s", metaKey: true })).toBe(true);
    expect(pressed("dashboardSave", { ...base, key: "s" })).toBe(false);
    expect(pressed("queryRun", { ...base, key: "Enter", ctrlKey: true })).toBe(true);
    expect(pressed("dashboardViews", { ...base, key: "3" })).toBe(true);
    expect(pressed("dashboardViews", { ...base, key: "4" })).toBe(false);
  });

  it("new dashboard is n without Ctrl, Alt or Meta", () => {
    expect(pressed("monitoringNewDashboard", { ...base, key: "n" })).toBe(true);
    // Shift and Caps Lock give N, which matches as M1's letters do.
    expect(pressed("monitoringNewDashboard", { ...base, key: "N" })).toBe(true);
    expect(pressed("monitoringNewDashboard", { ...base, key: "N", shiftKey: true })).toBe(true);
    expect(pressed("monitoringNewDashboard", { ...base, key: "n", ctrlKey: true })).toBe(false);
    expect(pressed("monitoringNewDashboard", { ...base, key: "n", altKey: true })).toBe(false);
    expect(pressed("monitoringNewDashboard", { ...base, key: "n", metaKey: true })).toBe(false);
    expect(pressed("monitoringNewDashboard", { ...base, key: "N", ctrlKey: true, shiftKey: true })).toBe(false);
  });

  it("Monitoring's help leaves out the Kubernetes groups", () => {
    const groups = allGroups(undefined, "monitoring");
    expect(groups.map(([t]) => t)).toEqual(["Apps and tabs", "Monitoring", "Dashboards", "Explore", "Alerts", "Anywhere", "Logs", "Dock"]);
    const ids = groups.flatMap(([, list]) => list.map((s) => s.id));
    for (const id of ["moveKind", "kinds", "palette", "filter", "move", "details", "yaml", "logs", "shell", "scale", "drain"] as const) expect(ids).not.toContain(id);
    // Alt+Down still moves into the shared dock: listed under Anywhere.
    expect(groups.find(([t]) => t === "Anywhere")![1].map((s) => s.id)).toContain("enterLogs");
    expect(keysFor("monitoringFind", true)).toEqual(["/", "⌘ K"]);
    // Outside Monitoring the sheet is exactly what it was.
    const kube = (kindKey?: string) => (["shell", "row", "logs", "global", "dock"] as const).map((scope) => [
      { shell: "Apps and tabs", row: "Table", logs: "Logs", global: "Anywhere", dock: "Dock" }[scope],
      SHORTCUTS.filter((s) => s.scope === scope && (kindKey === undefined || s.kinds === undefined || s.kinds.includes(kindKey))),
    ]);
    expect(allGroups()).toEqual(kube());
    expect(allGroups(undefined, "kubernetes")).toEqual(kube());
    expect(allGroups("pods", "kubernetes")).toEqual(kube("pods"));
    expect(allGroups().find(([t]) => t === "Anywhere")![1].map((s) => s.id)).toEqual(
      ["kinds", "palette", "filter", "help", "deleteFocused", "confirmReview"],
    );
  });

  it("the sheet drops Filter rows while Monitoring is shown", () => {
    const anywhere = (app?: Parameters<typeof allGroups>[1]) => allGroups(undefined, app).find(([t]) => t === "Anywhere")![1].map((s) => s.id);
    expect(anywhere("monitoring")).not.toContain("filter");
    expect(anywhere("monitoring")).toContain("help");
    expect(anywhere("kubernetes")).toContain("filter");
    expect(anywhere()).toContain("filter");
  });
});
