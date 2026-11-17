import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { KindInfo } from "../../api/types";
import { ContextMenu, menuAnchor, type MenuAnchor, type MenuItem } from "../chrome/ContextMenu";
import { fallbackKind, kindTitle } from "../territories/model";
import { dropFor, landingIndex, shiftOf, type Slot } from "./pinDrag";
import { usePinnedKinds } from "./pinnedKinds";
import s from "./SettingsView.module.css";

/** Pointer travel before a press on the grip becomes a drag. */
const LIFT_PX = 4;

type Drag = {
  key: string;
  pointer: number;
  handle: HTMLSpanElement;
  pinned: readonly string[];
  startX: number;
  startY: number;
  y: number;
  lifted: boolean;
  /** Captured at lift, relative to the list's top. */
  slots: Slot[];
  from: number;
  /** The press point in list coordinates, so scrolling under a still pointer moves the row. */
  startLocal: number;
  to: number;
};

const rowsOf = (list: HTMLElement) => Array.from(list.children) as HTMLElement[];
const plain = (e: KeyboardEvent) => !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;

export function PinnedKindsSection({ kinds }: { kinds: readonly KindInfo[] | undefined }) {
  const { pinned, pin, unpin, move, reorder, reset } = usePinnedKinds();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; anchor: MenuAnchor } | null>(null);
  const dragged = useRef<Drag | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const gap = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLLIElement>());
  const moreButtons = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef<HTMLElement | null>(null);
  const menuWasOpen = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const byKey = new Map((kinds ?? []).map(k => [k.key, k]));
  const served = new Map([...byKey].filter(([, k]) => k.clusters.length > 0));
  const options = [...served.values()].filter(k => !pinned.includes(k.key) &&
    `${kindTitle(k)} ${k.key}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => kindTitle(a).localeCompare(kindTitle(b)));
  const at = Math.min(active, options.length - 1);
  const tabbable = current !== null && pinned.includes(current) ? current : pinned[0];
  const titleOf = (key: string) => kindTitle(byKey.get(key) ?? fallbackKind(key));
  const announceMove = (key: string, index: number) => {
    setAnnouncement(`${titleOf(key)} moved to position ${index + 1} of ${pinned.length}.`);
  };

  const clearDrag = useCallback(() => {
    const drag = dragged.current;
    if (!drag) return;
    dragged.current = null;
    if (drag.handle.hasPointerCapture?.(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
    const ul = list.current;
    if (!ul) return;
    ul.removeAttribute("data-pin-dragging");
    ul.style.minHeight = "";
    for (const row of rowsOf(ul)) {
      row.removeAttribute("data-pin-lifted");
      row.style.transform = "";
    }
  }, []);
  /** Moves the lifted row with the pointer and slides the others apart where it will land. */
  const place = useCallback((drag: Drag) => {
    const ul = list.current;
    if (!ul) return;
    const source = drag.slots[drag.from], last = drag.slots[drag.slots.length - 1];
    const local = drag.y - ul.getBoundingClientRect().top;
    const delta = Math.max(-source.top, Math.min(local - drag.startLocal, last.top + last.height - source.top - source.height));
    drag.to = landingIndex(drag.slots, drag.from, source.top + delta);
    rowsOf(ul).forEach((row, i) => {
      const shift = i === drag.from ? delta : shiftOf(i, drag.from, drag.to, source.height);
      row.style.transform = shift ? `translateY(${shift}px)` : "";
    });
    const landing = drag.slots[drag.to];
    if (gap.current) {
      gap.current.style.top = `${drag.to <= drag.from ? landing.top : landing.top + landing.height - source.height}px`;
      gap.current.style.height = `${source.height}px`;
    }
  }, []);
  const lift = (drag: Drag): boolean => {
    const ul = list.current;
    if (!ul) return false;
    const bounds = ul.getBoundingClientRect();
    const rows = rowsOf(ul);
    drag.slots = rows.map(row => {
      const { top, height } = row.getBoundingClientRect();
      return { key: row.dataset.pinKey ?? "", top: top - bounds.top, height };
    });
    drag.from = drag.slots.findIndex(slot => slot.key === drag.key);
    if (drag.from < 0) return false;
    drag.startLocal = drag.startY - bounds.top;
    drag.to = drag.from;
    drag.lifted = true;
    ul.style.minHeight = `${bounds.height}px`;
    ul.setAttribute("data-pin-dragging", "");
    rows[drag.from].setAttribute("data-pin-lifted", "");
    setMenu(null);
    return true;
  };

  useLayoutEffect(() => {
    const cancel = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !dragged.current) return;
      // The Escape is the drag's: it must not also close a log or dialog that still has focus.
      e.preventDefault();
      e.stopPropagation();
      clearDrag();
    };
    const followScroll = (e: Event) => {
      const drag = dragged.current;
      if (drag?.lifted && e.target instanceof Node && e.target.contains(drag.handle)) place(drag);
    };
    document.addEventListener("keydown", cancel, true);
    document.addEventListener("scroll", followScroll, true);
    return () => {
      document.removeEventListener("keydown", cancel, true);
      document.removeEventListener("scroll", followScroll, true);
      clearDrag();
    };
  }, [clearDrag, place]);
  useLayoutEffect(() => {
    if (dragged.current && dragged.current.pinned !== pinned) clearDrag();
    // A move or removal re-renders the rows: put focus back where the action left it.
    const target = refocus.current;
    refocus.current = null;
    if (target?.isConnected && document.activeElement !== target) target.focus();
  }, [pinned, clearDrag]);

  const dragStart = (e: PointerEvent<HTMLSpanElement>, key: string) => {
    if (e.button !== 0 || dragged.current) return;
    e.preventDefault();
    const { currentTarget: handle, pointerId: pointer, clientX: x, clientY: y } = e;
    dragged.current = { key, pointer, handle, pinned, startX: x, startY: y, y, lifted: false, slots: [], from: -1, startLocal: 0, to: -1 };
    handle.setPointerCapture?.(pointer);
  };
  const dragFor = (e: PointerEvent<HTMLSpanElement>) => {
    const drag = dragged.current;
    return drag?.pointer === e.pointerId && drag.handle === e.currentTarget ? drag : null;
  };
  const dragMove = (e: PointerEvent<HTMLSpanElement>) => {
    const drag = dragFor(e);
    if (!drag || drag.pinned !== pinned) return;
    drag.y = e.clientY;
    if (!drag.lifted && (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < LIFT_PX || !lift(drag))) return;
    place(drag);
  };
  const dragEnd = (e: PointerEvent<HTMLSpanElement>) => {
    const drag = dragFor(e);
    if (!drag) return;
    let drop: ReturnType<typeof dropFor> = null;
    if (drag.lifted && drag.pinned === pinned) {
      drag.y = e.clientY;
      place(drag);
      drop = dropFor(pinned, drag.key, drag.to);
    }
    clearDrag();
    if (!drop) return;
    reorder(drag.key, drop.key, drop.placement);
    announceMove(drag.key, drag.to);
  };
  const dragCancel = (e: PointerEvent<HTMLSpanElement>) => {
    if (dragFor(e)) clearDrag();
  };

  const add = (key: string) => { pin(key); setQuery(""); setActive(0); setOpen(false); input.current?.focus(); };
  const moveBy = (key: string, index: number, by: -1 | 1, focus: HTMLElement) => {
    const to = index + by;
    if (to < 0 || to >= pinned.length) return;
    refocus.current = focus;
    move(key, by);
    announceMove(key, to);
  };
  const remove = (key: string, index: number) => {
    const next = pinned[index + 1] ?? pinned[index - 1];
    refocus.current = (next !== undefined ? rowEls.current.get(next) : undefined) ?? input.current;
    if (next !== undefined) setCurrent(next);
    if (dragged.current?.key === key) clearDrag();
    unpin(key);
  };
  const openMenu = (key: string, anchor: MenuAnchor) => setMenu({ key, anchor });
  const rowKey = (e: KeyboardEvent<HTMLLIElement>, key: string, index: number) => {
    const by = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (by && e.altKey) {
      // Alt+arrows anywhere in the row (its "⋯" too) are the row's, even at the ends and with
      // other modifiers: Alt+Down must never fall through to the logs. Only plain Alt moves it.
      e.preventDefault();
      e.stopPropagation();
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.target instanceof HTMLElement) moveBy(key, index, by, e.target);
      return;
    }
    if (e.target !== e.currentTarget) return;
    if (by && plain(e)) {
      e.preventDefault();
      const next = pinned[index + by];
      if (next !== undefined) rowEls.current.get(next)?.focus();
    } else if (e.key === "Enter" && plain(e)) {
      e.preventDefault();
      // Keyboard opens hand focus back to the row; the menu sits under the row's "⋯".
      const more = moreButtons.current.get(key)?.getBoundingClientRect();
      openMenu(key, menuAnchor(e.currentTarget, more ? { clientX: more.left, clientY: more.bottom } : undefined));
    }
  };
  const menuIndex = menu ? pinned.indexOf(menu.key) : -1;
  const menuItems = (key: string, index: number, trigger: HTMLElement): MenuItem[] => [
    { id: "up", label: "Move up", disabled: index === 0, onSelect: () => moveBy(key, index, -1, trigger) },
    { id: "down", label: "Move down", disabled: index === pinned.length - 1, onSelect: () => moveBy(key, index, 1, trigger) },
    { id: "remove", label: "Remove", restoreFocus: false, onSelect: () => remove(key, index) },
  ];
  useEffect(() => {
    if (open && at >= 0) document.getElementById(`${id}-option-${at}`)?.scrollIntoView?.({ block: "nearest" });
  });

  return <section id="pinned-kinds" aria-labelledby={`${id}-heading`} className={s.section}>
    <h2 id={`${id}-heading`}>Pinned kinds</h2>
    <p className={s.lede}>The kind tabs above every Kubernetes table, in this order. Drag a row, or focus it and press Alt ↑ / Alt ↓. Saved in this browser.</p>
    {pinned.length === 0 ? <p className={s.empty}>No pinned kinds: only the kind you open gets a tab.</p> :
      <div className={s.list}>
        <ul ref={list} aria-label="Pinned kinds" className={s.rows}>{pinned.map((key, i) => {
          const title = titleOf(key);
          const unserved = kinds !== undefined && !served.has(key);
          return <li key={key} className={s.row} data-pin-key={key} tabIndex={key === tabbable ? 0 : -1}
            ref={row => { if (row) rowEls.current.set(key, row); else rowEls.current.delete(key); }}
            aria-label={`${title}, position ${i + 1} of ${pinned.length}`} aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Enter"
            aria-describedby={unserved ? `${id}-unserved-${i}` : undefined}
            onFocus={() => setCurrent(key)} onKeyDown={e => rowKey(e, key, i)}>
            <span className={s.grip} aria-hidden="true" title={`Drag ${title} to reorder`}
              onPointerDown={(e) => dragStart(e, key)} onPointerMove={dragMove} onPointerUp={dragEnd}
              onPointerCancel={dragCancel} onLostPointerCapture={dragCancel} />
            <div className={s.name}><strong>{title}</strong><span className={s.key}>{key}</span>
              {unserved && <p id={`${id}-unserved-${i}`} className={s.hidden}>No cluster serves this kind right now, so its tab is hidden.</p>}</div>
            <button type="button" className={s.more} tabIndex={-1} aria-label={`Actions for ${title}`}
              aria-haspopup="menu" aria-expanded={menu?.key === key}
              ref={button => { if (button) moreButtons.current.set(key, button); else moreButtons.current.delete(key); }}
              onPointerDown={() => { menuWasOpen.current = menu?.key === key; }}
              onClick={e => {
                // A click on the open menu's own "⋯" closes it (the press already did); it must not reopen.
                if (menuWasOpen.current) { menuWasOpen.current = false; return; }
                openMenu(key, menuAnchor(e.currentTarget));
              }}>⋯</button>
          </li>;
        })}</ul>
        <div ref={gap} className={s.gap} aria-hidden="true" />
      </div>}
    {menu && menuIndex >= 0 && <ContextMenu anchor={menu.anchor} label={`${titleOf(menu.key)} actions`}
      items={menuItems(menu.key, menuIndex, menu.anchor.trigger)} onClose={() => setMenu(null)} />}
    <p className={s.announcement} role="status">{announcement}</p>
    <div className={s.footer}>
      <div className={s.add} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
        <input ref={input} role="combobox" aria-label="Add a kind" placeholder="Add a kind…" autoComplete="off"
          aria-expanded={open} aria-controls={`${id}-options`} aria-autocomplete="list"
          aria-activedescendant={open && at >= 0 ? `${id}-option-${at}` : undefined}
          value={query} disabled={pinned.length >= 40} onFocus={() => setOpen(true)}
          onChange={e => { setQuery(e.target.value); setActive(0); setOpen(true); }}
          onKeyDown={e => {
            if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault(); setOpen(true);
              if (open && options.length) setActive((at + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
            }
            if (e.key === "Enter" && open && at >= 0) { e.preventDefault(); add(options[at].key); }
          }}/>
        {open && <div id={`${id}-options`} role="listbox" aria-label="Add a kind" className={s.options}>
          {options.length === 0 ? <p>No kind matches</p> : options.map((k, i) => <div key={k.key} id={`${id}-option-${i}`}
            role="option" aria-selected={i === at} onMouseDown={e => e.preventDefault()} onClick={() => add(k.key)}>{kindTitle(k)}</div>)}
        </div>}
      </div>
      <button type="button" onClick={() => { clearDrag(); reset(); }}>Reset to default</button>
    </div>
  </section>;
}
