import { Component, Suspense, lazy, type ComponentProps, type ReactNode } from "react";
import s from "./Dock.module.css";

export const TERMINAL_UNAVAILABLE = "Couldn't load the terminal. Reload the page.";

// The terminal is most of the page's code; it loads with the first shell, not with the page.
const loadShellPane = () => import("../shell/ShellPane");
const ShellPane = lazy(() => loadShellPane().then((m) => ({ default: m.ShellPane })));

/**
 * Loads the terminal's code before something is made for it (a node-shell pod, a debug
 * container), so a failed load stops at the confirm instead of leaving that behind unused.
 */
export async function prefetchShellPane(): Promise<void> {
  try {
    await loadShellPane();
  } catch {
    throw new Error(TERMINAL_UNAVAILABLE);
  }
}

/** A failed load (most likely an old page after an upgrade) stays in its pane, in plain words. */
class TerminalBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <p className={s.hint} role="alert">{TERMINAL_UNAVAILABLE}</p>;
    return this.props.children;
  }
}

/** The shell pane, loaded on first use. */
export function LazyShellPane(props: ComponentProps<typeof ShellPane>) {
  return (
    <TerminalBoundary>
      <Suspense fallback={<p className={s.hint} role="status">Loading the terminal…</p>}>
        <ShellPane {...props} />
      </Suspense>
    </TerminalBoundary>
  );
}
