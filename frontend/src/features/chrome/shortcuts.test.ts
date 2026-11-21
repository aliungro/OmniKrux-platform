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
      ["monitoringFind", ["/"], "Find a project, group or source"],
      ["monitoringTree", ["↑ ↓", "← →", "Enter"], "In the sidebar: move, close or open a group, open the item"],
      ["monitoringNewDashboard", ["N"], "New dashboard"],
    ]);
  });

  it("the Dashboards group appears only in Monitoring", () => {
    const titles = allGroups(undefined, "monitoring").map(([t]) => t);
    const at = titles.indexOf("Monitoring");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(titles.slice(at, at + 2)).toEqual(["Monitoring", "Dashboards"]);
    expect(allGroups().map(([t]) => t)).not.toContain("Dashboards");
    expect(allGroups().map(([t]) => t)).not.toContain("Monitoring");
    expect(allGroups("pods", "kubernetes").map(([t]) => t)).not.toContain("Dashboards");
    const dashboards = allGroups(undefined, "monitoring").find(([t]) => t === "Dashboards")![1];
    expect(dashboards.map((s) => [s.id, s.keys, s.label])).toEqual([
      ["dashboardEdit", ["e"], "Edit the dashboard"],
      ["dashboardViews", ["1–3"], "Dashboard, JSON or Versions"],
      ["dashboardTime", ["t"], "Pick the time range"],
      ["dashboardRefresh", ["r"], "Refresh now"],
      ["dashboardSave", ["Ctrl S"], "While editing (in fields too): save the dashboard"],
      ["panelFocus", ["← → ↑ ↓"], "While editing: move between panels"],
      ["panelMove", ["Shift ← → ↑ ↓"], "While editing: move the panel one step"],
      ["panelResize", ["Ctrl Shift ← → ↑ ↓"], "While editing: make the panel narrower, wider, shorter or taller"],
      ["panelSettings", ["Enter"], "While editing: open the panel's settings"],
      ["panelAdd", ["a"], "While editing: add a panel"],
      ["panelRemove", ["Ctrl Del"], "While editing: remove the panel from the draft"],
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

  it("the sheet drops Filter rows while Monitoring is shown", () => {
    const anywhere = (app?: Parameters<typeof allGroups>[1]) => allGroups(undefined, app).find(([t]) => t === "Anywhere")![1].map((s) => s.id);
    expect(anywhere("monitoring")).not.toContain("filter");
    expect(anywhere("monitoring")).toContain("help");
    expect(anywhere("kubernetes")).toContain("filter");
    expect(anywhere()).toContain("filter");
  });
});
