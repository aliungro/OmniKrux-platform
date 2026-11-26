import { describe, expect, it } from "vitest";
import { panel, spec } from "../../test/dashboardSeeds";
import type { NewPanel } from "../layout";
import { dashboardJson, newPanel, type DashboardSpec } from "../schema";
import { canUndo, changedPanelIds, editorReducer, hasUnsavedWork, isDirty, isDraftEdit, UNDO_LIMIT, VIEW, type EditingState, type EditorAction, type EditorState } from "./editorState";

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

  it("JSON text that doesn't apply is unsaved work even when the draft equals its base", () => {
    const s0 = start();
    expect(hasUnsavedWork(s0)).toBe(false);
    expect(hasUnsavedWork(VIEW)).toBe(false);
    const s1 = edit(run(s0, { type: "setJson", text: "{ nope", ownerKind: "project" }));
    expect(s1.draft).toBe(s0.draft);
    expect(isDirty(s1)).toBe(false);
    expect(hasUnsavedWork(s1)).toBe(true);
    expect(hasUnsavedWork(run(s0, retitle("p-1", "New")))).toBe(true);
  });

  it("broken JSON typed while a save was on its way keeps edit mode, and its text", () => {
    const s1 = edit(run(start(), retitle("p-1", "New")));
    const sent = s1.draft;
    // The draft didn't change (the text doesn't apply), but the text did.
    const s2 = edit(run(s1, { type: "setJson", text: "{ nope", ownerKind: "project" }));
    expect(s2.draft).toBe(sent);
    const s3 = edit(run(s2, { type: "saved", version: 2, spec: sent, sent }));
    expect(s3.baseVersion).toBe(2);
    expect(s3.base).toBe(sent);
    expect(s3.jsonText).toBe("{ nope");
    expect(hasUnsavedWork(s3)).toBe(true);
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

describe("insertPanel", () => {
  const small = () => start(spec("Small", [panel("p-1", "Requests", "up", { x: 0, y: 0, w: 12, h: 8 })]));
  const fresh = (id: string): NewPanel => {
    const { layout: _layout, ...rest } = newPanel("timeseries", id, { x: 0, y: 0, w: 12, h: 8 });
    void _layout;
    return { ...rest, title: "Errors by route" };
  };

  it("insertPanel appends at the free spot and counts the change", () => {
    const s0 = small();
    const s1 = edit(run(s0, { type: "insertPanel", panel: fresh("p-2"), select: false }));
    expect(s1.draft.panels.map((p) => p.id)).toEqual(["p-1", "p-2"]);
    expect(s1.draft.panels[1]).toMatchObject({ id: "p-2", title: "Errors by route", layout: { x: 12, y: 0, w: 12, h: 8 } });
    expect(s1.changes["p-2"]).toBe(1);
    expect(s1.changes["p-1"]).toBeUndefined();
    expect(s1.draft.panels[0]).toBe(s0.draft.panels[0]);
    expect(s1.selected).toBeNull();
    expect(isDirty(s1)).toBe(true);
  });

  it("insertPanel with select selects it", () => {
    const s1 = edit(run(small(), { type: "insertPanel", panel: fresh("p-2"), select: true }));
    expect(s1.selected).toBe("p-2");
    expect(s1.sideTab).toBe("query");
  });

  it("insertPanel is refused while the JSON text doesn't apply", () => {
    const action: EditorAction = { type: "insertPanel", panel: fresh("p-2"), select: false };
    expect(isDraftEdit(action)).toBe(true);
    const broken = edit(run(small(), { type: "setJson", text: "{ nope", ownerKind: "project" }));
    const after = run(broken, action);
    expect(after).toBe(broken);
    expect(edit(after).jsonText).toBe("{ nope");
  });

  it("suggestions: start opens it for a draft with no panels, resume likewise, and it isn't a draft edit", () => {
    expect(start().suggestions).toBe("closed");
    const empty = start(spec("Empty", []));
    expect(empty.suggestions).toBe("open");
    const closed = edit(run(empty, { type: "suggestions", open: false }));
    expect(closed.suggestions).toBe("closed");
    expect(edit(run(closed, { type: "suggestions", open: false }))).toBe(closed);
    expect(isDraftEdit({ type: "suggestions", open: true })).toBe(false);
    const resumeWith = (draft: DashboardSpec) => edit(editorReducer(VIEW, { type: "resume", dashboardId: "d1", baseVersion: 1, base: spec("Empty", []), draft, jsonText: null }));
    expect(resumeWith(spec("Empty", [])).suggestions).toBe("open");
    expect(resumeWith(doc()).suggestions).toBe("closed");
  });

  it("suggestions can be closed while the JSON text doesn't apply", () => {
    const bad = edit(run(start(spec("Empty", [])), { type: "setJson", text: "{ nope", ownerKind: "project" }));
    expect(bad.jsonText).not.toBeNull();
    expect(edit(run(bad, { type: "suggestions", open: false })).suggestions).toBe("closed");
  });
});

describe("undo", () => {
  const ids = (s: EditingState) => s.draft.panels.map((p) => p.id);
  const json = (s: EditingState, change: (d: DashboardSpec) => void): EditorAction => {
    const next = structuredClone(s.draft);
    change(next);
    return { type: "setJson", text: dashboardJson(next), ownerKind: "project" };
  };

  it("undo brings back a removed panel", () => {
    const s0 = start();
    expect(s0.past).toEqual([]);
    expect(canUndo(s0)).toBe(false);
    const s1 = edit(run(s0, { type: "removePanel", id: "p-1" }));
    expect(s1.past).toHaveLength(1);
    expect(canUndo(s1)).toBe(true);
    const s2 = edit(run(s1, { type: "undo" }));
    expect(ids(s2)).toEqual(["p-1", "p-2"]);
    expect(s2.draft.panels[0]).toEqual(s0.draft.panels[0]);
    expect(isDirty(s2)).toBe(false);
    expect(s2.past).toEqual([]);
    expect(canUndo(s2)).toBe(false);
    expect(isDraftEdit({ type: "undo" })).toBe(true);
    expect(isDraftEdit({ type: "duplicatePanel", id: "p-1" })).toBe(true);
  });

  it("typing in one panel's settings is one undo step", () => {
    const s0 = start();
    const s1 = edit(run(s0, retitle("p-1", "R"), retitle("p-1", "Re"), retitle("p-1", "Req")));
    expect(s1.past).toHaveLength(1);
    expect(s1.pastKey).toBe("updatePanel:p-1");
    // Another panel's settings are a step of their own; so is a move between them.
    const s2 = edit(run(s1, retitle("p-2", "E"), retitle("p-2", "Er")));
    expect(s2.past).toHaveLength(2);
    const s3 = edit(run(s2, { type: "undo" }));
    expect(s3.draft.panels.map((p) => p.title)).toEqual(["Req", "Errors"]);
    const s4 = edit(run(s3, { type: "undo" }));
    expect(s4.draft.panels.map((p) => p.title)).toEqual(["Requests", "Errors"]);
    // After an undo, the next keystroke in the same panel is a new step.
    const s5 = edit(run(s1, { type: "undo" }, retitle("p-1", "X"), retitle("p-1", "XY")));
    expect(s5.past).toHaveLength(1);
  });

  it("remove, then typing in another panel's title, then undo twice: one step each", () => {
    const s1 = edit(run(start(), { type: "removePanel", id: "p-1" }, retitle("p-2", "E"), retitle("p-2", "Er")));
    const s2 = edit(run(s1, { type: "undo" }));
    expect(ids(s2)).toEqual(["p-2"]);
    expect(s2.draft.panels[0].title).toBe("Errors");
    const s3 = edit(run(s2, { type: "undo" }));
    expect(ids(s3)).toEqual(["p-1", "p-2"]);
  });

  it("undo stops at the start of the session", () => {
    const s0 = start();
    expect(run(s0, { type: "undo" })).toBe(s0);
    const s1 = edit(run(s0, { type: "nudge", id: "p-1", dir: "down" }, { type: "undo" }));
    expect(s1.draft.panels[0].layout).toEqual(s0.draft.panels[0].layout);
    expect(run(s1, { type: "undo" })).toBe(s1);
    // A resumed session starts afresh too.
    const resumed = edit(run(s1, { type: "resume", dashboardId: "d1", baseVersion: 1, base: s0.base, draft: s0.base, jsonText: null }));
    expect(resumed.past).toEqual([]);
  });

  it("undo is refused while the JSON doesn't apply", () => {
    const s1 = edit(run(start(), { type: "removePanel", id: "p-1" }));
    const broken = edit(run(s1, { type: "setJson", text: "{ nope", ownerKind: "project" }));
    expect(broken.past).toBe(s1.past);
    expect(run(broken, { type: "undo" })).toBe(broken);
    expect(broken.jsonText).toBe("{ nope");
  });

  it("JSON edits are one undo step", () => {
    const s0 = start();
    const s1 = edit(run(s0, { type: "removePanel", id: "p-1" }));
    const a = edit(run(s1, json(s1, (d) => { d.panels[0].title = "E"; })));
    const b = edit(run(a, json(a, (d) => { d.panels[0].title = "Er"; })));
    // Text that doesn't apply between two that do neither steps nor breaks the step.
    const c = edit(run(b, { type: "setJson", text: "{ no", ownerKind: "project" }, json(b, (d) => { d.panels[0].title = "Err"; })));
    expect(c.past).toHaveLength(2);
    expect(c.pastKey).toBe("json");
    const back = edit(run(c, { type: "undo" }));
    expect(back.draft.panels.map((p) => p.title)).toEqual(["Errors"]);
    expect(ids(edit(run(back, { type: "undo" })))).toEqual(["p-1", "p-2"]);
  });

  it("typing a title is one undo step", () => {
    const s0 = start();
    const title = (t: string): EditorAction => ({ type: "setDashboard", key: "title", update: (d) => ({ ...d, title: t }) });
    const s1 = edit(run(s0, title("A"), title("AP"), title("API")));
    expect(s1.past).toHaveLength(1);
    expect(s1.pastKey).toBe("title");
    expect(edit(run(s1, { type: "undo" })).draft.title).toBe("API latency");
    // Typed back to where it began: nothing left to undo (an equal snapshot is dropped).
    const s2 = edit(run(s0, title("API latenc"), title("API latency")));
    expect(canUndo(s2)).toBe(false);
    expect(edit(run(s2, { type: "undo" })).past).toEqual([]);
    // A dashboard edit without a key is a step each time.
    const plain = edit(run(s0, { type: "setDashboard", update: (d) => ({ ...d, title: "x" }) }, { type: "setDashboard", update: (d) => ({ ...d, title: "y" }) }));
    expect(plain.past).toHaveLength(2);
  });

  it("keeps at most UNDO_LIMIT steps; saving in place and rebase keep them", () => {
    let s = start();
    for (let i = 0; i < UNDO_LIMIT + 5; i += 1) s = edit(run(s, retitle(i % 2 === 0 ? "p-1" : "p-2", `t${i}`)));
    expect(s.past).toHaveLength(UNDO_LIMIT);
    const rebased = edit(run(s, { type: "rebase", version: 2, base: s.draft }));
    expect(rebased.past).toBe(s.past);
    const stays = edit(run(s, { type: "saved", version: 3, spec: s.draft, sent: s.base }));
    expect(stays.past).toBe(s.past);
    expect(edit(run(s, { type: "discard" }, { type: "start", dashboardId: "d1", version: 3, spec: s.draft })).past).toEqual([]);
  });

  it("duplicate places a copy below with a new id and no alert", () => {
    const base = doc();
    base.panels[0].alert = {
      name: "Slow", query: "A", of: "each", op: "above", threshold: 1, for: "5m", every: "1m", severity: "warning",
      message: "", notify: [], engine: "omnikrux", channel: null,
    };
    const s0 = start(base);
    const s1 = edit(run(s0, { type: "duplicatePanel", id: "p-1" }));
    expect(ids(s1)).toEqual(["p-1", "p-2", "p-3"]);
    const copy = s1.draft.panels[2];
    expect(copy).toMatchObject({ id: "p-3", title: "Requests (copy)", alert: null, layout: { x: 0, y: 8, w: 12, h: 8 } });
    expect(copy.queries).toEqual(s0.draft.panels[0].queries);
    expect(s1.draft.panels[0]).toBe(s0.draft.panels[0]);
    expect(s1.changes).toEqual({ "p-3": 1 });
    expect(s1.past).toHaveLength(1);
    // A long title is cut to 120 characters.
    const long = edit(run(s0, retitle("p-1", "x".repeat(118)), { type: "duplicatePanel", id: "p-1" }));
    expect(long.draft.panels[2].title).toHaveLength(120);
    expect(run(s0, { type: "duplicatePanel", id: "nope" })).toBe(s0);
    const broken = edit(run(s0, { type: "setJson", text: "{ nope", ownerKind: "project" }));
    expect(run(broken, { type: "duplicatePanel", id: "p-1" })).toBe(broken);
  });
});
