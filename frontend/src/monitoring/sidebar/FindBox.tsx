import { useId, useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { capsOf } from "../../features/chrome/shortcuts";
import k from "../../features/chrome/key.module.css";
import { FIND_MORE, findResults, hitSubtitle, type SearchEntry } from "../search/search";
import type { MonitoringView } from "../shell/tabState";
import s from "./Sidebar.module.css";

interface Props {
  index: SearchEntry[];
  /** Opens a hit: in the active tab, or a new one (Ctrl). */
  onOpen(view: MonitoringView, newTab: boolean): void;
  /** Gives the keyboard back to the workspace. */
  onLeave(): void;
  /** The field: MonitoringApp's Find (/, Ctrl K, the top bar) puts the keyboard here. */
  inputRef: RefObject<HTMLInputElement | null>;
}

/** "Find anything": pages, projects, groups, dashboards and sources by name. */
export function FindBox({ index, onOpen, onLeave, inputRef: input }: Props) {
  const id = useId();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const { shown: hits, more } = useMemo(() => findResults(index, text), [index, text]);
  const typed = text.trim() !== "";
  const showing = open && typed;
  const current = Math.min(active, Math.max(0, hits.length - 1));

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
          aria-keyshortcuts="/ Control+K"
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
              <span className={s.hitName} title={hit.name}>{hit.name}</span>
              <span className={s.hitSub} title={hitSubtitle(hit)}>{hitSubtitle(hit)}</span>
            </li>
          ))}
        </ul>
        {/* Only while there is text: an empty field has nothing to announce. */}
        {typed && (
          <p className={s.noHits} role="status">
            {hits.length === 0 ? `Nothing matches “${text.trim()}”.` : more > 0 ? FIND_MORE.replace("{n}", String(more)) : ""}
          </p>
        )}
      </div>
    </div>
  );
}
