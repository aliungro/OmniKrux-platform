import { useCallback, useEffect, useId, useRef, useState, type PointerEvent } from "react";
import type { KindInfo } from "../../api/types";
import { fallbackKind, kindTitle } from "../territories/model";
import { usePinnedKinds } from "./pinnedKinds";
import s from "./SettingsView.module.css";

type Drop = { key: string; placement: "before" | "after" };

function dropAt(e: PointerEvent<HTMLSpanElement>): Drop | null {
  const row = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-pin-key]");
  const key = row?.dataset.pinKey;
  if (!row || !key || !e.currentTarget.closest("ul")?.contains(row)) return null;
  const { top, height } = row.getBoundingClientRect();
  return { key, placement: e.clientY < top + height / 2 ? "before" : "after" };
}

export function PinnedKindsSection({ kinds }: { kinds: readonly KindInfo[] | undefined }) {
  const { pinned, pin, unpin, move, reorder, reset } = usePinnedKinds();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [dropCue, setDropCue] = useState<Drop | null>(null);
  const dragged = useRef<{ key: string; pointer: number } | null>(null);
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
  const clearDrag = useCallback(() => {
    dragged.current = null;
    setDropCue(null);
  }, []);
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragged.current) clearDrag();
    };
    document.addEventListener("keydown", cancel);
    return () => document.removeEventListener("keydown", cancel);
  }, [clearDrag]);
  const dragStart = (e: PointerEvent<HTMLSpanElement>, key: string) => {
    if (e.button !== 0 || dragged.current) return;
    e.preventDefault();
    dragged.current = { key, pointer: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const dragMove = (e: PointerEvent<HTMLSpanElement>) => {
    const drag = dragged.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    const drop = dropAt(e);
    const next = drop?.key === drag.key ? null : drop;
    setDropCue((previous) => previous?.key === next?.key && previous?.placement === next?.placement ? previous : next);
  };
  const dragEnd = (e: PointerEvent<HTMLSpanElement>) => {
    const drag = dragged.current;
    if (!drag || drag.pointer !== e.pointerId) return;
    const drop = dropAt(e);
    clearDrag();
    if (!drop || drop.key === drag.key) return;
    const { key } = drag;
    const { key: target, placement } = drop;
    const from = pinned.indexOf(key);
    const targetIndex = pinned.indexOf(target);
    if (from < 0 || targetIndex < 0) return;
    const to = targetIndex + Number(placement === "after") - Number(from < targetIndex);
    if (to === from) return;
    reorder(key, target, placement);
    announceMove(key, to);
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
          data-drop-placement={dropCue?.key === key ? dropCue.placement : undefined}>
          <div className={s.identity}>
            <span className={s.dragHandle} aria-hidden="true" title={`Drag ${title} to reorder`}
              onPointerDown={(e) => dragStart(e, key)} onPointerMove={dragMove} onPointerUp={dragEnd}
              onPointerCancel={clearDrag} onLostPointerCapture={clearDrag} />
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
