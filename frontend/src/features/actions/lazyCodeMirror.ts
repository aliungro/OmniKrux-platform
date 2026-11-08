/**
 * CodeMirror, loaded on first use: the YAML editor and the diff are the only places that need it,
 * so the page's first paint never waits for it (like the terminal). Everything that touches
 * CodeMirror goes through the kit this resolves to.
 */

export interface MountedView {
  destroy: () => void;
}

export interface MountedEditor extends MountedView {
  focus: () => void;
}

export interface CodeMirrorKit {
  /** A read-only side-by-side diff, before on the left, after on the right. */
  mergeView: (parent: HTMLElement, before: string, after: string) => MountedView;
  /** A YAML editor; `onChange` gets the whole text after every change. */
  editor: (parent: HTMLElement, doc: string, onChange: (text: string) => void, label: string) => MountedEditor;
}

export const EDITOR_UNAVAILABLE = "Couldn't load the editor. Reload the page.";

let loading: Promise<CodeMirrorKit> | null = null;

/** The kit, loaded once; a failed load (an old page after an upgrade) is tried again next time. */
export function loadCodeMirror(): Promise<CodeMirrorKit> {
  loading ??= import("./codemirrorKit").then((m) => m.buildKit()).catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}
