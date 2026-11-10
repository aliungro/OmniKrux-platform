import { useId, useRef, useState } from "react";
import type { KindInfo } from "../../api/types";
import { fallbackKind, kindTitle } from "../territories/model";
import { usePinnedKinds } from "./pinnedKinds";
import s from "./SettingsView.module.css";

export function PinnedKindsSection({ kinds }: { kinds: readonly KindInfo[] | undefined }) {
  const { pinned, pin, unpin, move, reset } = usePinnedKinds();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const byKey = new Map((kinds ?? []).map(k => [k.key, k]));
  const served = new Map([...byKey].filter(([, k]) => k.clusters.length > 0));
  const options = [...served.values()].filter(k => !pinned.includes(k.key) &&
    `${kindTitle(k)} ${k.key}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => kindTitle(a).localeCompare(kindTitle(b)));
  const at = Math.min(active, options.length - 1);
  const add = (key: string) => { pin(key); setQuery(""); setActive(0); setOpen(false); input.current?.focus(); };

  return <section id="pinned-kinds" aria-labelledby={`${id}-heading`} className={s.section}>
    <h2 id={`${id}-heading`}>Pinned kinds</h2>
    <p className={s.lede}>The kind tabs above every Kubernetes table, in this order. Saved in this browser.</p>
    {pinned.length === 0 ? <p className={s.empty}>No pinned kinds: only the kind you open gets a tab.</p> :
      <ul aria-label="Pinned kinds" className={s.rows}>{pinned.map((key, i) => {
        const kind = byKey.get(key), title = kindTitle(kind ?? fallbackKind(key));
        return <li key={key} className={s.row}>
          <div className={s.name}><strong>{title}</strong><span className={s.key}>{key}</span>
            {kinds !== undefined && !served.has(key) && <p className={s.hidden}>No cluster serves this kind right now, so its tab is hidden.</p>}</div>
          <div className={s.controls}>
            <button type="button" aria-label={`Move ${title} up`} disabled={i === 0} onClick={() => move(key, -1)}>Move up</button>
            <button type="button" aria-label={`Move ${title} down`} disabled={i === pinned.length - 1} onClick={() => move(key, 1)}>Move down</button>
            <button type="button" aria-label={`Remove ${title}`} onClick={() => unpin(key)}>Remove</button>
          </div>
        </li>;
      })}</ul>}
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
      <button type="button" onClick={reset}>Reset to default</button>
    </div>
  </section>;
}
