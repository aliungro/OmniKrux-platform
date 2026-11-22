import { describe, expect, it } from "vitest";
import { panel, spec } from "../../test/dashboardSeeds";
import { dashboardJson, type DashboardSpec } from "../schema";
import { changedPanelIds, editorReducer, isDirty, VIEW, type EditingState, type EditorAction, type EditorState } from "./editorState";

const doc = (): DashboardSpec => spec("API latency", [
  panel("p-1", "Requests", "up", { x: 0, y: 0, w: 12, h: 8 }),
  panel("p-2", "Errors", "errors", { x: 12, y: 0, w: 12, h: 8 }),
]);

const run = (state: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, state);
const edit = (state: EditorState): EditingState => {
  if (state.mode !== "edit") throw new Error("not editing");
  return state;
};
const start = (spec: DashboardSpec = doc()) => edit(editorReducer(VIEW, { type: "start", dashboardId: "d1", version: 1, spec }));
const retitle = (id: string, title: string): EditorAction => ({ type: "updatePanel", id, update: (p) => ({ ...p, title }) });

describe("editorReducer", () => {
  it("start then a change makes it dirty and keeps other panels identical", () => {
    const s0 = start();
    expect(isDirty(s0)).toBe(false);
    expect(s0.draft).toBe(s0.base);
    const s1 = edit(run(s0, retitle("p-1", "Requests per second")));
    expect(isDirty(s1)).toBe(true);
    expect(s1.draft.panels[0].title).toBe("Requests per second");
    expect(s1.draft.panels[1]).toBe(s0.base.panels[1]);
    expect(s1.base).toBe(s0.base);
  });

  it("add places at the free spot with the next id", () => {
    const s0 = start(spec("Small", [panel("p-1", "Requests", "up", { x: 0, y: 0, w: 12, h: 8 })]));
    const s1 = edit(run(s0, { type: "addPanel", panelType: "timeseries" }));
    const added = s1.draft.panels[1];
    expect(added).toMatchObject({ id: "p-2", type: "timeseries", title: "New panel", layout: { x: 12, y: 0, w: 12, h: 8 } });
    expect(s1.selected).toBe("p-2");
    expect(s1.sideTab).toBe("query");
    expect(s1.draft.panels[0]).toBe(s0.draft.panels[0]);
    // A full grid: a new row under everything.
    const s2 = edit(run(s1, { type: "addPanel", panelType: "timeseries" }));
    expect(s2.draft.panels[2]).toMatchObject({ id: "p-3", layout: { x: 0, y: 8, w: 12, h: 8 } });
  });

  it("remove then discard brings it back", () => {
    const s0 = start();
    const s1 = edit(run(s0, { type: "select", id: "p-1" }, { type: "removePanel", id: "p-1" }));
    expect(s1.draft.panels.map((p) => p.id)).toEqual(["p-2"]);
    expect(s1.selected).toBeNull();
    // Compaction after a remove moves nothing that was in place here; the survivor keeps its object.
    expect(s1.draft.panels[0]).toBe(s0.draft.panels[1]);
    expect(isDirty(s1)).toBe(true);
    expect(run(s1, { type: "discard" })).toEqual(VIEW);
    // The saved document never lost it: editing again starts from it.
    expect(start(s1.base).draft.panels.map((p) => p.id)).toEqual(["p-1", "p-2"]);
  });

  it("saved clears the draft and leaves edit mode", () => {
    const s1 = run(start(), retitle("p-1", "New"));
    const saved = edit(s1).draft;
    expect(run(s1, { type: "saved", version: 2, spec: saved })).toEqual(VIEW);
    expect(isDirty(VIEW)).toBe(false);
  });

  it("a save of an older draft keeps editing the newer one over the saved version", () => {
    const s1 = edit(run(start(), retitle("p-1", "New")));
    const sent = s1.draft;
    const s2 = edit(run(s1, retitle("p-2", "Newer")));
    const s3 = edit(run(s2, { type: "saved", version: 2, spec: sent, sent }));
    expect(s3.baseVersion).toBe(2);
    expect(s3.base).toBe(sent);
    expect(s3.draft).toBe(s2.draft);
    expect(s3.writer).toBe(s1.writer);
    expect(isDirty(s3)).toBe(true);
    // Nothing changed since it was sent: edit mode ends.
    expect(run(s1, { type: "saved", version: 2, spec: sent, sent })).toEqual(VIEW);
    // Changed and changed back while it was on its way: the same document, so edit mode ends too.
    const undone = edit(run(s2, retitle("p-2", sent.panels[1].title)));
    expect(undone.draft).not.toBe(sent);
    expect(run(undone, { type: "saved", version: 2, spec: sent, sent })).toEqual(VIEW);
  });

  it("each session gets its own writer", () => {
    expect(start().writer).not.toBe(start().writer);
    expect(edit(editorReducer(VIEW, { type: "start", dashboardId: "d1", version: 1, spec: doc(), writer: "w1" })).writer).toBe("w1");
  });

  it("rebase keeps the draft and moves the base", () => {
    const s1 = edit(run(start(), retitle("p-1", "Mine")));
    const theirs = spec("API latency", [panel("p-1", "Theirs", "up")]);
    const s2 = edit(run(s1, { type: "rebase", version: 2, base: theirs }));
    expect(s2.baseVersion).toBe(2);
    expect(s2.base).toBe(theirs);
    expect(s2.draft).toBe(s1.draft);
    expect(s2.changes).toBe(s1.changes);
  });

  it("changes count per panel", () => {
    const s = edit(run(start(), retitle("p-1", "One"), retitle("p-1", "Two")));
    expect(s.changes["p-1"]).toBe(2);
    expect(s.changes["p-2"]).toBeUndefined();
    // An update that changes nothing isn't a change.
    expect(run(s, retitle("p-1", "Two"))).toBe(s);
  });

  it("moves count only for the panel acted on, keep the document's order and undo cleanly", () => {
    const s0 = start(spec("Two", [
      panel("p-1", "Requests", "up", { x: 0, y: 0, w: 8, h: 8 }),
      panel("p-2", "Errors", "errors", { x: 0, y: 8, w: 8, h: 8 }),
    ]));
    // Down swaps the panel below over this one: p-2 moves, p-1 is pushed (no flash for it).
    const s1 = edit(run(s0, { type: "nudge", id: "p-2", dir: "up" }));
    expect(s1.draft.panels.map((p) => [p.id, p.layout.y])).toEqual([["p-1", 8], ["p-2", 0]]);
    expect(s1.changes).toEqual({ "p-2": 1 });
    const s2 = edit(run(s0, { type: "nudge", id: "p-1", dir: "right" }, { type: "nudge", id: "p-1", dir: "left" }));
    expect(isDirty(s2)).toBe(false);
    // Growing past the grid's edge does nothing.
    const wide = start(spec("Wide", [panel("p-1", "All", "up", { x: 0, y: 0, w: 24, h: 8 })]));
    expect(run(wide, { type: "grow", id: "p-1", dir: "right" })).toBe(wide);
  });

  it("loading a gapped layout never compacts it", () => {
    const gapped = spec("Gaps", [panel("p-1", "Low", "up", { x: 0, y: 10, w: 8, h: 4 })]);
    expect(start(gapped).draft.panels[0].layout.y).toBe(10);
    const resumed = edit(editorReducer(VIEW, { type: "resume", dashboardId: "d1", baseVersion: 1, base: gapped, draft: gapped, jsonText: null }));
    expect(resumed.draft.panels[0].layout.y).toBe(10);
  });

  it("setJson applies a valid document and keeps unchanged panels; an invalid one is kept as text", () => {
    const s0 = start();
    const next = structuredClone(s0.draft);
    next.panels[1].title = "Errors per second";
    const s1 = edit(run(s0, { type: "setJson", text: dashboardJson(next), ownerKind: "project" }));
    expect(s1.draft.panels[1].title).toBe("Errors per second");
    expect(s1.draft.panels[0]).toBe(s0.draft.panels[0]);
    expect(s1.changes).toEqual({ "p-2": 1 });
    expect(s1.jsonText).toBeNull();

    const broken = edit(run(s1, { type: "setJson", text: "{ nope", ownerKind: "project" }));
    expect(broken.draft).toBe(s1.draft);
    expect(broken.jsonText).toBe("{ nope");
    expect(broken.jsonProblems[0].message).toMatch(/^Not valid JSON/);
    // A change made elsewhere is refused while the text doesn't apply: it would drop the text.
    expect(run(broken, retitle("p-1", "Fixed"))).toBe(broken);
    expect(run(broken, { type: "addPanel", panelType: "stat" })).toBe(broken);
    expect(run(broken, { type: "setDashboard", update: (d) => ({ ...d, title: "x" }) })).toBe(broken);
    // Fixed in the JSON, the draft follows it again.
    const fixed = edit(run(broken, { type: "setJson", text: dashboardJson(next), ownerKind: "project" }));
    expect(fixed.jsonText).toBeNull();
    expect(fixed.jsonProblems).toEqual([]);
  });

  it("resume re-checks kept JSON text, so its problems show again", () => {
    const d = doc();
    const back = edit(editorReducer(VIEW, { type: "resume", dashboardId: "d1", baseVersion: 1, base: d, draft: d, jsonText: "{ nope", ownerKind: "project" }));
    expect(back.jsonText).toBe("{ nope");
    expect(back.jsonProblems[0].message).toMatch(/^Not valid JSON/);
    // Text that is valid after all becomes the draft.
    const next = structuredClone(d);
    next.title = "Renamed";
    const valid = edit(editorReducer(VIEW, { type: "resume", dashboardId: "d1", baseVersion: 1, base: d, draft: d, jsonText: dashboardJson(next), ownerKind: "project" }));
    expect(valid.draft.title).toBe("Renamed");
    expect(valid.jsonText).toBeNull();
    expect(valid.jsonProblems).toEqual([]);
  });

  it("changedPanelIds lists changed and added panels", () => {
    const a = doc();
    const b = { ...a, panels: [a.panels[0], { ...a.panels[1], title: "x" }, panel("p-3", "New", "up")] };
    expect(changedPanelIds(a, b)).toEqual(["p-2", "p-3"]);
  });
});
