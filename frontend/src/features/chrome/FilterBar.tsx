import { useEffect, useRef, type KeyboardEvent } from "react";
import type { FilterCounts, Filters } from "../territories/model";
import k from "./key.module.css";
import s from "./FilterBar.module.css";

type Status = Filters["status"];

/** Keys typed here belong to the field, so "/" must not steal focus from it. */
function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export function FilterBar({
  value,
  onChange,
  counts,
}: {
  value: Filters;
  onChange: (f: Filters) => void;
  counts: FilterCounts;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isEditable(e.target) || isEditable(document.activeElement)) return;
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

  const chip = (status: Status, label: string, icon?: "diamond" | "ring") => (
    <button
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
    <div className={s.filters} role="group" aria-label="Filter pods">
      {chip("all", "All")}
      {chip("failing", `Failing ${counts.failing}`, "diamond")}
      {chip("pending", `Pending ${counts.pending}`, "ring")}
      {chip("restartedToday", `Restarted today ${counts.restartedToday}`)}
      <label className={s.search}>
        <span className={k.k} aria-hidden="true">/</span>
        <input
          ref={inputRef}
          type="text"
          className={s.input}
          placeholder="Filter by name, namespace or node"
          aria-label="Filter by name, namespace or node"
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
