import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { editorKeymap } from "./codemirrorKit";

describe("editor keymap", () => {
  it("the editor keymap reviews on mod+enter and leaves on escape", () => {
    const keys = { onSubmit: vi.fn(), onLeave: vi.fn() };
    const bindings = editorKeymap(keys);
    expect(bindings.map((b) => b.key)).toEqual([undefined, "Mod-Enter", "Escape"]);
    const view = {} as EditorView;

    // Handled either way: Mod-Enter never inserts a line, Escape never falls through.
    expect(bindings[1].run!(view)).toBe(true);
    expect(keys.onSubmit).toHaveBeenCalledTimes(1);
    expect(keys.onLeave).not.toHaveBeenCalled();

    expect(bindings[2].run!(view)).toBe(true);
    expect(keys.onLeave).toHaveBeenCalledTimes(1);
    expect(keys.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("a held mod+enter is swallowed before it can review again", () => {
    const keys = { onSubmit: vi.fn(), onLeave: vi.fn() };
    const [first] = editorKeymap(keys);
    const view = {} as EditorView;
    const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    // A repeat of Ctrl+Enter or Cmd+Enter: handled here (prevented, stopped), never reviewed.
    expect(first.any!(view, key({ key: "Enter", ctrlKey: true, repeat: true }))).toBe(true);
    expect(first.any!(view, key({ key: "Enter", metaKey: true, repeat: true }))).toBe(true);
    // The first press, and every other key, go on to the bindings.
    expect(first.any!(view, key({ key: "Enter", ctrlKey: true }))).toBe(false);
    expect(first.any!(view, key({ key: "Enter", repeat: true }))).toBe(false);
    expect(first.any!(view, key({ key: "a", ctrlKey: true, repeat: true }))).toBe(false);
    expect(keys.onSubmit).not.toHaveBeenCalled();
  });
});
