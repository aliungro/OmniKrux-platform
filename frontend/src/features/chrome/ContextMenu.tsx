import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import s from "./ContextMenu.module.css";

export interface MenuAnchor {
  trigger: HTMLElement;
  x: number;
  y: number;
}

export interface MenuItem {
  id: string;
  label: string;
  onSelect(): void;
  disabled?: boolean;
  divider?: boolean;
  restoreFocus?: boolean;
  danger?: boolean;
}

export function menuAnchor(trigger: HTMLElement, point?: { clientX: number; clientY: number }): MenuAnchor {
  const bounds = trigger.getBoundingClientRect();
  return { trigger, x: point?.clientX ?? bounds.left, y: point?.clientY ?? bounds.bottom };
}

export function isMenuKey(e: KeyboardEvent): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

export function isBlankMenuSurface(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest(
    'a, button, input, textarea, select, label, [contenteditable], [role="tab"], [role="menu"], [role="listbox"], [role="row"], [role="dialog"]',
  );
}

export function ContextMenu({ anchor, label, items, onClose }: {
  anchor: MenuAnchor;
  label: string;
  items: readonly MenuItem[];
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = (restore: boolean) => {
    onClose();
    if (restore && anchor.trigger.isConnected) anchor.trigger.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const menu = ref.current!;
    const margin = 8;
    const left = Math.max(margin, Math.min(anchor.x, window.innerWidth - menu.offsetWidth - margin));
    const top = Math.max(margin, Math.min(anchor.y, window.innerHeight - menu.offsetHeight - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [anchor]);

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !ref.current?.contains(e.target)) onClose();
    };
    window.addEventListener("pointerdown", outside, true);
    return () => window.removeEventListener("pointerdown", outside, true);
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const options = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    if (!options.length) return;
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const last = options.length - 1;
    const next = e.key === "Home" ? 0 : e.key === "End" ? last
      : e.key === "ArrowDown" ? (at + 1) % options.length
      : at <= 0 ? last : at - 1;
    options[next].focus();
  };

  return createPortal(
    <div ref={ref} role="menu" aria-label={label} className={s.menu} onKeyDown={onKeyDown}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) onClose(); }}>
      {items.map((item) => (
        <button key={item.id} role="menuitem" type="button" disabled={item.disabled}
          data-divider={item.divider || undefined} data-danger={item.danger || undefined}
          onClick={() => { close(item.restoreFocus !== false); item.onSelect(); }}>
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
