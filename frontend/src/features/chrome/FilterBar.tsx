import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ChipDef, FilterCounts, Filters } from "../territories/model";
import { capsOf, pageKey, pressed } from "./shortcuts";
import k from "./key.module.css";
import s from "./FilterBar.module.css";

const PLACEHOLDER = "Filter by name, label or image";

/** The namespace chip's list: every namespace in the rows on screen, plus all of them. */
function NamespacePicker({
  value,
  namespaces,
  onPick,
}: {
  value: string | null;
  namespaces: string[];
  onPick: (ns: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const chipRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const id = useId();
  // The current choice stays listed even when no row on screen is in it any more.
  const options: (string | null)[] = [null, ...namespaces];
  if (value !== null && !namespaces.includes(value)) options.splice(1, 0, value);

  const show = () => {
    setActive(Math.max(0, options.indexOf(value)));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) chipRef.current?.focus();
  };
  const pick = (ns: string | null) => {
    close(true);
    if (ns !== value) onPick(ns);
  };

  // Focus follows the active option while the list is open.
  useEffect(() => {
    if (open) optionRefs.current[active]?.focus();
  }, [open, active]);

  // A click anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const last = options.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(last, active + 1),
      ArrowUp: Math.max(0, active - 1),
      Home: 0,
      End: last,
    };
    if (e.key in moves) {
      e.preventDefault();
      setActive(moves[e.key]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      close(e.key === "Escape");
    }
  };

  return (
    <div ref={boxRef} className={s.pick}>
      <button
        ref={chipRef}
        type="button"
        className={`${s.fchip}${value !== null ? ` ${s.on}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            show();
          }
        }}
      >
        Namespace: {value ?? "all"}
        <i className={s.caret} aria-hidden="true" />
      </button>
      {open && (
        <ul id={`${id}-list`} role="listbox" aria-label="Namespace" className={s.menu} onKeyDown={onListKey}>
          {options.map((ns, i) => (
            <li
              key={ns ?? ""}
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              role="option"
              aria-selected={ns === value}
              tabIndex={i === active ? 0 : -1}
              className={`${s.option}${ns === null ? ` ${s.allNs}` : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(ns)}
            >
              {ns ?? "All namespaces"}
            </li>
          ))}
          {namespaces.length === 0 && <li className={s.none} role="presentation">No namespaces in the rows on screen</li>}
        </ul>
      )}
    </div>
  );
}

export function FilterBar({
  value,
  onChange,
  chips,
  counts,
  namespaces,
}: {
  value: Filters;
  onChange: (f: Filters) => void;
  /** The kind's status chips (`chipsFor`); none for a kind without a status. */
  chips: ChipDef[];
  counts: FilterCounts;
  /** Namespaces to pick from; null for a kind without namespaces (no chip). */
  namespaces: string[] | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!pressed("filter", e) || !pageKey(e)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (value.text !== "") onChange({ ...value, text: "" });
    e.currentTarget.blur();
  };

  const chip = (status: Filters["status"], label: string, icon?: ChipDef["icon"]) => (
    <button
      key={status}
      type="button"
      className={`${s.fchip}${value.status === status ? ` ${s.on}` : ""}`}
      aria-pressed={value.status === status}
      onClick={() => onChange({ ...value, status })}
    >
      {icon && <i className={s[icon]} aria-hidden="true" />}
      {label}
    </button>
  );

  return (
    <div className={s.filters} role="group" aria-label="Filter rows">
      {chips.length > 0 && chip("all", "All")}
      {/* No number until a cluster has reported one: never a made-up 0. */}
      {chips.map((c) => chip(c.status, counts[c.status] === undefined ? c.label : `${c.label} ${counts[c.status]}`, c.icon))}
      {namespaces !== null && (
        <NamespacePicker value={value.namespace} namespaces={namespaces} onPick={(namespace) => onChange({ ...value, namespace })} />
      )}
      <label className={s.search}>
        <span className={k.k} aria-hidden="true">{capsOf("filter")[0]}</span>
        <input
          ref={inputRef}
          type="text"
          className={s.input}
          placeholder={PLACEHOLDER}
          aria-label={PLACEHOLDER}
          aria-keyshortcuts="/"
          spellCheck={false}
          autoComplete="off"
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
          onKeyDown={onInputKey}
        />
      </label>
    </div>
  );
}
