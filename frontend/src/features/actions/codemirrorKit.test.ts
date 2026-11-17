import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { editorKeymap } from "./codemirrorKit";

describe("editor keymap", () => {
  it("the editor keymap reviews on mod+enter and leaves on escape", () => {
    const keys = { onSubmit: vi.fn(), onLeave: vi.fn() };
    const bindings = editorKeymap(keys);
    expect(bindings.map((b) => b.key)).toEqual(["Mod-Enter", "Escape"]);
    const view = {} as EditorView;

    // Handled either way: Mod-Enter never inserts a line, Escape never falls through.
    expect(bindings[0].run!(view)).toBe(true);
    expect(keys.onSubmit).toHaveBeenCalledTimes(1);
    expect(keys.onLeave).not.toHaveBeenCalled();

    expect(bindings[1].run!(view)).toBe(true);
    expect(keys.onLeave).toHaveBeenCalledTimes(1);
    expect(keys.onSubmit).toHaveBeenCalledTimes(1);
  });
});
