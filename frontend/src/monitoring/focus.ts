/** Put the keyboard on the workspace: a page that is going away must not leave it on <body>. */
export function focusMainFrom(el: Element | null) {
  (el?.closest("main") ?? document.querySelector("main"))?.focus({ preventScroll: true });
}
