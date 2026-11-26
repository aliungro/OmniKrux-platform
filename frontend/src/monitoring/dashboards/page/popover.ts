// Small helpers for the page's inline menus and pickers: close on a click elsewhere or when the
// keyboard leaves, and arrow keys between menu items.
import { useEffect, type FocusEvent, type KeyboardEvent, type RefObject } from "react";

/** While open, a press outside `root` (the trigger and its popup) closes it. */
export function useCloseOutside(open: boolean, root: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) onClose();
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [open, root, onClose]);
}

/** The keyboard left the popup for somewhere else on the page (Tab away): close without taking it back.
 * Moving to anything inside `root` (the trigger) doesn't close: the trigger's own click does that,
 * so a second click on it closes the menu instead of reopening it. */
export function closesOnLeave(onClose: () => void, root?: RefObject<HTMLElement | null>) {
  return (e: FocusEvent<HTMLElement>) => {
    const to = e.relatedTarget;
    if (!(to instanceof Node) || e.currentTarget.contains(to) || root?.current?.contains(to)) return;
    onClose();
  };
}

/** Up, Down, Home and End between a menu's items; wraps around. */
export function menuKeys(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'));
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const last = items.length - 1;
  const next = e.key === "Home" ? 0 : e.key === "End" ? last
    : e.key === "ArrowDown" ? (at + 1) % items.length
    : at <= 0 ? last : at - 1;
  items[next].focus();
}

/** Marks an inline popup, so the page's letter keys leave it alone. */
export const POPUP = { "data-dashboard-popup": "" } as const;
