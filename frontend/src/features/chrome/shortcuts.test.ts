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

  it("help lists both zones", () => {
    const groups = allGroups("pods");
    expect(groups.map(([t]) => t)).toEqual(["Apps and tabs", "Table", "Logs", "Anywhere", "Dock"]);
    const ids = (title: string) => groups.find(([t]) => t === title)![1].map((s) => s.id);
    expect(ids("Table")).toEqual(expect.arrayContaining(["pinLogs", "enterLogs"]));
    expect(ids("Logs")).toEqual(expect.arrayContaining(["backToTable", "leaveLogs", "pinFollow"]));
    expect(SHORTCUTS.some((s) => (s.id as string) === "closeLog")).toBe(false);
    expect(SHORTCUTS.some((s) => s.label.includes("Close the focused log"))).toBe(false);
  });
});
