// The motion of adding a panel from a preview: a ghost of the card flies to the new tile, which
// then lands. Both are `element.animate` on transform and opacity only. Nothing is created under
// reduced motion. `data-landing` is a marker (tests, scripts); no stylesheet selects it. While the
// ghost flies, the tile waits see-through (opacity, never `visibility`), so it can hold the
// keyboard from the moment it is added.

import { useCallback, useRef } from "react";
import { usePrefersReducedMotion } from "../dashboards/motion";
import styles from "./PreviewCard.module.css";

export const FLY_MS = 500;
export const LAND_MS = 550;
const EASE = "cubic-bezier(.2,.8,.2,1)";
const LAND_EASE = "cubic-bezier(.2,.9,.25,1.2)";

function finished(animation: Animation, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms + 100);
    const done = () => { clearTimeout(timer); resolve(); };
    if (animation.finished) animation.finished.then(done, done);
    else animation.onfinish = done;
  });
}

export async function flyIn(from: DOMRect, to: HTMLElement, reduced: boolean): Promise<void> {
  if (reduced || typeof Element.prototype.animate !== "function") return;
  to.scrollIntoView?.({ block: "nearest" });
  const target = to.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = styles.ghost ?? "";
  Object.assign(ghost.style, {
    left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`,
  });
  document.body.appendChild(ghost);
  const hold = to.animate([{ opacity: 0 }, { opacity: 0 }], { duration: FLY_MS, fill: "forwards" });
  try {
    const dx = target.left - from.left;
    const dy = target.top - from.top;
    const sx = from.width > 0 ? target.width / from.width : 1;
    const sy = from.height > 0 ? target.height / from.height : 1;
    const flight = ghost.animate(
      [
        { transform: "translate(0px, 0px) scale(1, 1)", opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.3 },
      ],
      { duration: FLY_MS, easing: EASE, fill: "forwards" },
    );
    await finished(flight, FLY_MS);
  } finally {
    ghost.remove();
    hold.cancel?.();
  }
  to.setAttribute("data-landing", "");
  to.animate(
    [{ transform: "scale(0.85)" }, { transform: "none" }],
    { duration: LAND_MS, easing: LAND_EASE },
  );
  setTimeout(() => to.removeAttribute("data-landing"), LAND_MS);
}

/** `launch` records a flight from a card; when the tile with that id mounts, the ghost flies to it. */
export function useFlyIn(): { launch(panelId: string, from: DOMRect): void; tileRef(panelId: string): (el: HTMLElement | null) => void } {
  const reduced = usePrefersReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const pending = useRef(new Map<string, DOMRect>());
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const launch = useCallback((panelId: string, from: DOMRect) => {
    if (!reducedRef.current) pending.current.set(panelId, from);
  }, []);
  const tileRef = useCallback((panelId: string) => {
    let ref = refs.current.get(panelId);
    if (!ref) {
      ref = (el) => {
        const from = pending.current.get(panelId);
        if (!el || !from) return;
        pending.current.delete(panelId);
        void flyIn(from, el, reducedRef.current);
      };
      refs.current.set(panelId, ref);
    }
    return ref;
  }, []);
  return { launch, tileRef };
}
