// The reduced-motion preference and the changed-panel highlight's length. Outside the chart chunk
// so the grid can use them; the charts re-export them.

import { useSyncExternalStore } from "react";

/** How long an edited panel's frame stays highlighted. */
export const FLASH_MS = 450;

const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  return typeof matchMedia === "function" ? matchMedia(QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const mq = media();
  mq?.addEventListener("change", onChange);
  return () => mq?.removeEventListener("change", onChange);
}

/** Live: follows the system setting while the page is open. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => media()?.matches ?? false, () => false);
}
