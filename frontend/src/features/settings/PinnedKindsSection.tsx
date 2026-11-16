import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { KindInfo } from "../../api/types";
import { fallbackKind, kindTitle } from "../territories/model";
import { usePinnedKinds } from "./pinnedKinds";
import s from "./SettingsView.module.css";

type Drop = { key: string; placement: "before" | "after" };
type Drag = {
  key: string;
  pointer: number;
  handle: HTMLSpanElement;
  pinned: readonly string[];
  startX: number;
  startY: number;
  x: number;
  y: number;
  lifted: boolean;
  drop: Drop | null;
  frame: number | null;
};

function dropAt(handle: HTMLSpanElement, x: number, y: number): Drop | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pin-key]");
  const key = row?.dataset.pinKey;
  if (!row || !key || !handle.closest("ul")?.contains(row)) return null;
  const { top, height } = row.getBoundingClientRect();
  return { key, placement: y < top + height / 2 ? "before" : "after" };
}

function dropIndex(pinned: readonly string[], source: string, drop: Drop | null): number | null {
  if (!drop || source === drop.key) return null;
  const from = pinned.indexOf(source);
  const target = pinned.indexOf(drop.key);
  if (from < 0 || target < 0) return null;
  const to = target + Number(drop.placement === "after") - Number(from < target);
  return to === from ? null : to;
}

export function PinnedKindsSection({ kinds }: { kinds: readonly KindInfo[] | undefined }) {
  const { pinned, pin, unpin, move, reorder, reset } = usePinnedKinds();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [dropCue, setDropCue] = useState<Drop | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const dragged = useRef<Drag | null>(null);
  const preview = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const id = useId();
  const byKey = new Map((kinds ?? []).map(k => [k.key, k]));
  const served = new Map([...byKey].filter(([, k]) => k.clusters.length > 0));
  const options = [...served.values()].filter(k => !pinned.includes(k.key) &&
    `${kindTitle(k)} ${k.key}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => kindTitle(a).localeCompare(kindTitle(b)));
  const at = Math.min(active, options.length - 1);
  const announceMove = (key: string, index: number) => {
    const title = kindTitle(byKey.get(key) ?? fallbackKind(key));
    setAnnouncement(`${title} moved to position ${index + 1} of ${pinned.length}.`);
  };
  const releaseDrag = useCallback(() => {
    const drag = dragged.current;
    if (!drag) return;
    dragged.current = null;
    if (drag.frame !== null) window.cancelAnimationFrame(drag.frame);
    if (drag.handle.hasPointerCapture?.(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
  }, []);
  const clearDrag = useCallback(() => {
    releaseDrag();
    setDragKey(null);
    setDropCue(null);
  }, [releaseDrag]);
  const refreshDropCue = useCallback((drag: Drag) => {
    const drop = dropAt(drag.handle, drag.x, drag.y);
    const next = dropIndex(drag.pinned, drag.key, drop) === null ? null : drop;
    if (drag.drop?.key !== next?.key || drag.drop?.placement !== next?.placement) {
      drag.drop = next;
      setDropCue(next);
    }
  }, []);
  useLayoutEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !dragged.current) return;
      // The Escape is the drag's: it must not also close a log or dialog that still has focus.
      e.preventDefault();
      e.stopPropagation();
      clearDrag();
    };
    const refreshAfterScroll = (e: Event) => {
      const drag = dragged.current;
      if (drag?.lifted && e.target instanceof Node && e.target.contains(drag.handle)) refreshDropCue(drag);
    };
    document.addEventListener("keydown", cancel, true);
    document.addEventListener("scroll", refreshAfterScroll, true);
    return () => {
      document.removeEventListener("keydown", cancel, true);
      document.removeEventListener("scroll", refreshAfterScroll, true);
      releaseDrag();
    };
  }, [clearDrag, refreshDropCue, releaseDrag]);
  useLayoutEffect(() => {
    if (dragged.current && dragged.current.pinned !== pinned) clearDrag();
  }, [pinned, clearDrag]);

  const schedulePreview = useCallback((drag: Drag) => {
    if (drag.frame !== null) return;
    drag.frame = window.requestAnimationFrame(() => {
      drag.frame = null;
      const card = preview.current;
      if (!card) return;
      const x = Math.max(8, Math.min(drag.x + 12, window.innerWidth - card.offsetWidth - 8));
      const y = Math.max(8, Math.min(drag.y + 12, window.innerHeight - card.offsetHeight - 8));
      card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    });
  }, []);
  const setPreview = useCallback((card: HTMLDivElement | null) => {
    preview.current = card;
    if (!card) return;
    try {
      card.showPopover?.();
    } catch {
      // Already shown, or no top layer: it still draws in place.
    }
    if (dragged.current) schedulePreview(dragged.current);
  }, [schedulePreview]);
  const dragStart = (e: PointerEvent<HTMLSpanElement>, key: string) => {
    if (e.button !== 0 || dragged.current) return;
    e.preventDefault();
    const { currentTarget: handle, pointerId: pointer, clientX: x, clientY: y } = e;
    dragged.current = { key, pointer, handle, pinned, startX: x, startY: y, x, y, lifted: false, drop: null, frame: null };
    handle.setPointerCapture?.(pointer);
  };
  const dragFor = (e: PointerEvent<HTMLSpanElement>) => {
    const drag = dragged.current;
    return drag?.pointer === e.pointerId && drag.handle === e.currentTarget ? drag : null;
  };
  const dragMove = (e: PointerEvent<HTMLSpanElement>) => {
    const drag = dragFor(e);
    if (!drag || drag.pinned !== pinned) return;
    const { clientX: x, clientY: y } = e;
    if (!drag.lifted) {
      if (Math.hypot(x - drag.startX, y - drag.startY) < 4) return;
      drag.lifted = true;
      setDragKey(drag.key);
    }
    drag.x = x;
    drag.y = y;
    schedulePreview(drag);
    refreshDropCue(drag);
  };
  const dragEnd = (e: PointerEvent<HTMLSpanElement>) => {
    const drag = dragFor(e);
    if (!drag) return;
    const drop = drag.lifted && drag.pinned === pinned ? dropAt(drag.handle, e.clientX, e.clientY) : null;
    const to = dropIndex(pinned, drag.key, drop);
    clearDrag();
    if (!drop || to === null) return;
    reorder(drag.key, drop.key, drop.placement);
    announceMove(drag.key, to);
  };
  const dragCancel = (e: PointerEvent<HTMLSpanElement>) => {
    if (dragFor(e)) clearDrag();
  };
  const add = (key: string) => { pin(key); setQuery(""); setActive(0); setOpen(false); input.current?.focus(); };
  const remove = (key: string, index: number) => {
    const next = pinned[index + 1] ?? pinned[index - 1];
    if (dragged.current?.key === key) clearDrag();
    unpin(key);
    (removeButtons.current.get(next) ?? input.current)?.focus();
  };
  useEffect(() => {
    if (open && at >= 0) document.getElementById(`${id}-option-${at}`)?.scrollIntoView?.({ block: "nearest" });
  });

  return <section id="pinned-kinds" aria-labelledby={`${id}-heading`} className={s.section}>
    <h2 id={`${id}-heading`}>Pinned kinds</h2>
    <p className={s.lede}>The kind tabs above every Kubernetes table, in this order. Saved in this browser.</p>
    {pinned.length === 0 ? <p className={s.empty}>No pinned kinds: only the kind you open gets a tab.</p> :
      <ul aria-label="Pinned kinds" className={s.rows}>{pinned.map((key, i) => {
        const kind = byKey.get(key), title = kindTitle(kind ?? fallbackKind(key));
        return <li key={key} className={s.row} data-pin-key={key}
          data-pin-dragging={dragKey === key ? "" : undefined}
          data-drop-placement={dropCue?.key === key ? dropCue.placement : undefined}>
          <div className={s.identity}>
            <span className={s.dragHandle} aria-hidden="true" title={`Drag ${title} to reorder`}
              onPointerDown={(e) => dragStart(e, key)} onPointerMove={dragMove} onPointerUp={dragEnd}
              onPointerCancel={dragCancel} onLostPointerCapture={dragCancel} />
            <div className={s.name}><strong>{title}</strong><span className={s.key}>{key}</span>
              {kinds !== undefined && !served.has(key) && <p className={s.hidden}>No cluster serves this kind right now, so its tab is hidden.</p>}</div>
          </div>
          <div className={s.controls}>
            <button type="button" aria-label={`Move ${title} up`} disabled={i === 0} onClick={() => { move(key, -1); announceMove(key, i - 1); }}>Move up</button>
            <button type="button" aria-label={`Move ${title} down`} disabled={i === pinned.length - 1} onClick={() => { move(key, 1); announceMove(key, i + 1); }}>Move down</button>
            <button ref={button => { if (button) removeButtons.current.set(key, button); else removeButtons.current.delete(key); }} type="button" aria-label={`Remove ${title}`} onClick={() => remove(key, i)}>Remove</button>
          </div>
        </li>;
      })}</ul>}
    {dragKey !== null && <div ref={setPreview} popover="manual" className={s.dragPreview} data-pin-drag-preview aria-hidden="true">
      <div className={`${s.name} ${s.dragCard}`}>
        <strong>{kindTitle(byKey.get(dragKey) ?? fallbackKind(dragKey))}</strong>
        <span className={s.key}>{dragKey}</span>
      </div>
    </div>}
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
