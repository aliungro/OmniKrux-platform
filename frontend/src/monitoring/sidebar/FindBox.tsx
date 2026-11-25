import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { capsOf, pageKey, pressed } from "../../features/chrome/shortcuts";
import k from "../../features/chrome/key.module.css";
import { searchMonitoring, type SearchEntry } from "../search/search";
import type { MonitoringView } from "../shell/tabState";
import s from "./Sidebar.module.css";

interface Props {
  index: SearchEntry[];
  /** Opens a hit: in the active tab, or a new one (Ctrl). */
  onOpen(view: MonitoringView, newTab: boolean): void;
  /** Gives the keyboard back to the workspace. */
  onLeave(): void;
}

const KIND_LABEL: Record<SearchEntry["kind"], string> = { project: "Project", group: "Group", source: "Source", dashboard: "Dashboard" };

/** "Find anything": projects, groups and sources by name. "/" outside a field comes here. */
export function FindBox({ index, onOpen, onLeave }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => searchMonitoring(index, text), [index, text]);
  const showing = open && text.trim() !== "";
  const current = Math.min(active, Math.max(0, hits.length - 1));

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!pressed("monitoringFind", e) || !pageKey(e)) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const choose = (hit: SearchEntry, newTab: boolean) => {
    setText("");
    setActive(0);
    onOpen(hit.view, newTab);
    onLeave();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (text !== "") { setText(""); setActive(0); } else onLeave();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!hits.length) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + hits.length) % hits.length);
    } else if (e.key === "Enter" && !e.altKey && !e.shiftKey) {
      const hit = hits[current];
      if (!hit) return;
      e.preventDefault();
      choose(hit, e.ctrlKey || e.metaKey);
    }
  };

  const listId = `${id}-hits`;
  const optionId = (i: number) => `${id}-hit-${i}`;
  return (
    <div className={s.find}>
      <div className={s.findField}>
        <svg className={s.findIcon} viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label="Find anything"
          aria-expanded={showing}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showing && hits.length ? optionId(current) : undefined}
          aria-keyshortcuts="/"
          placeholder="Find anything"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => { setText(e.target.value); setActive(0); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {text === "" && <span className={k.k} aria-hidden="true">{capsOf("monitoringFind")[0]}</span>}
      </div>
      <div className={s.hits} hidden={!showing}>
        <ul id={listId} role="listbox" aria-label="Find results">
          {hits.map((hit, i) => (
            <li
              key={`${hit.kind}:${hit.id}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === current}
              className={s.hit}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => choose(hit, e.ctrlKey || e.metaKey)}
            >
              <span className={s.hitName}>{hit.name}</span>
              <span className={s.hitSub}>{KIND_LABEL[hit.kind]} · {hit.subtitle}</span>
            </li>
          ))}
        </ul>
        {hits.length === 0 && <p className={s.noHits} role="status">No project, group or source matches “{text.trim()}”.</p>}
      </div>
    </div>
  );
}
