/**
 * The CodeMirror kit itself: imported only by `loadCodeMirror`, so neither CodeMirror nor this
 * setup is part of the page's first load.
 */
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { yaml } from "@codemirror/lang-yaml";
import { MergeView } from "@codemirror/merge";
import { tags } from "@lezer/highlight";
import type { CodeMirrorKit } from "./lazyCodeMirror";

const MONO = '"Geist Mono", ui-monospace, monospace';

export function buildKit(): CodeMirrorKit {
  // The console's palette (tokens.css), so the editor reads as part of the details, not a widget.
  const theme = EditorView.theme(
    {
      "&": { color: "var(--ink)", backgroundColor: "transparent", fontSize: "12px" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: MONO, lineHeight: "1.6" },
      ".cm-content": { caretColor: "var(--focus)", padding: "10px 0" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--focus)" },
      ".cm-gutters": { backgroundColor: "transparent", color: "var(--ink-3)", border: "none", borderRight: "1px solid var(--rule)" },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 12px", minWidth: "4ch" },
      ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--surf-2) 55%, transparent)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-2)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, var(--focus) 26%, transparent)",
      },
      ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--focus) 20%, transparent)", outline: "none" },
      // The diff: what goes in rose, what comes in green, the changed words a shade stronger.
      "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "color-mix(in srgb, var(--bad) 11%, transparent)" },
      "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "color-mix(in srgb, var(--ok) 10%, transparent)" },
      "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": {
        background: "color-mix(in srgb, var(--bad) 32%, transparent)",
        borderRadius: "2px",
      },
      "&.cm-merge-b .cm-changedText": { background: "color-mix(in srgb, var(--ok) 30%, transparent)", borderRadius: "2px" },
      "&.cm-merge-a .cm-changedLineGutter": { backgroundColor: "var(--bad)" },
      "&.cm-merge-b .cm-changedLineGutter": { backgroundColor: "var(--ok)" },
      ".cm-collapsedLines": {
        padding: "4px 12px",
        background: "var(--surf-2)",
        color: "var(--ink-2)",
        fontFamily: "inherit",
        fontSize: "11px",
        cursor: "pointer",
      },
      ".cm-collapsedLines:before, .cm-collapsedLines:after": { display: "none" },
    },
    { dark: true },
  );

  const highlight = syntaxHighlighting(
    HighlightStyle.define([
      { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: "var(--focus)" },
      { tag: [tags.string, tags.special(tags.string), tags.content], color: "var(--ink)" },
      { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--ok)" },
      { tag: [tags.comment, tags.lineComment], color: "var(--ink-3)", fontStyle: "italic" },
      { tag: [tags.punctuation, tags.separator, tags.meta, tags.typeName, tags.labelName], color: "var(--ink-3)" },
      { tag: [tags.keyword], color: "var(--warn)" },
    ]),
  );

  const base = [theme, highlight, yaml(), lineNumbers(), EditorView.lineWrapping];

  return {
    mergeView(parent, before, after) {
      const side = (label: string) => [
        ...base,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ "aria-label": label }),
      ];
      const merge = new MergeView({
        a: { doc: before, extensions: side("Before") },
        b: { doc: after, extensions: side("After") },
        parent,
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      });
      return { destroy: () => merge.destroy() };
    },
    editor(parent, doc, onChange, label) {
      const editor = new EditorView({
        parent,
        state: EditorState.create({
          doc,
          extensions: [
            ...base,
            highlightActiveLine(),
            highlightActiveLineGutter(),
            drawSelection(),
            indentOnInput(),
            bracketMatching(),
            history(),
            // No Tab binding: Tab moves focus on, so the keyboard is never trapped in the editor.
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorState.tabSize.of(2),
            EditorView.contentAttributes.of({ "aria-label": label }),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) onChange(u.state.doc.toString());
            }),
          ],
        }),
      });
      return { focus: () => editor.focus(), destroy: () => editor.destroy() };
    },
  };
}
