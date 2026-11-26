import type { KeyboardEvent } from "react";

/** Put the keyboard on the workspace: a page that is going away must not leave it on <body>. */
export function focusMainFrom(el: Element | null) {
  (el?.closest("main") ?? document.querySelector("main"))?.focus({ preventScroll: true });
}

/**
 * After a held way out was answered: the keyboard rests on the workspace until the next page shows,
 * then goes to that page's heading. Gives up after a few seconds, or when the keyboard went elsewhere.
 */
export function focusNextHeading(root: Element | null) {
  const main = root?.closest("main") ?? document.querySelector("main");
  const scope = root ?? document;
  const old = scope.querySelector("[data-monitoring-page] h1");
  if (!root) return;
  const free = () => {
    const a = document.activeElement;
    return a === null || a === document.body || a === main || !a.isConnected;
  };
  const stop = () => { watch.disconnect(); window.clearTimeout(timer); };
  const look = () => {
    if (!free()) { stop(); return; }
    const h = scope.querySelector<HTMLElement>("[data-monitoring-page] h1");
    if (!h || h === old || !h.isConnected) return;
    if (!h.hasAttribute("tabindex")) h.tabIndex = -1;
    h.focus({ preventScroll: true });
    stop();
  };
  const watch = new MutationObserver(look);
  const timer = window.setTimeout(stop, 4000);
  watch.observe(root, { childList: true, subtree: true });
}

/**
 * Esc in an inline panel closes it (not while it is saving) and goes no further, so nothing around
 * it, such as the logs, also takes the key. The panel's own effect returns the keyboard to its opener.
 */
export function escapeCloses(onClose: () => void, busy = false) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    if (!busy) onClose();
  };
}
