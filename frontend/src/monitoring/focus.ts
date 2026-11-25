import type { KeyboardEvent } from "react";

/** Put the keyboard on the workspace: a page that is going away must not leave it on <body>. */
export function focusMainFrom(el: Element | null) {
  (el?.closest("main") ?? document.querySelector("main"))?.focus({ preventScroll: true });
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
