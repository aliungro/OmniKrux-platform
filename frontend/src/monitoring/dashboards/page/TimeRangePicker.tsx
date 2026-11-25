// The time range: a button showing it, and a menu of the presets and a custom range.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { escapeCloses } from "../../focus";
import { TIME_COPY, type TimeSpec } from "../schema";
import { parseTimeExpr, TIME_PRESETS, timeLabel } from "../time";
import { closesOnLeave, menuKeys, POPUP, useCloseOutside } from "./popover";
import s from "./DashboardPage.module.css";

interface Props {
  time: TimeSpec;
  open: boolean;
  onOpen(): void;
  /** `restore`: give the keyboard back to the time button. */
  onClose(restore: boolean): void;
  onPick(time: TimeSpec): void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

const AFTER = "Pick a To time after From.";

export function TimeRangePicker({ time, open, onOpen, onClose, onPick, buttonRef }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const fromField = useRef<HTMLInputElement>(null);
  // A press on the trigger moves the focus there before its click: that blur must not close the menu
  // (the click does), while the keyboard (Shift+Tab) back to it still closes.
  const pressing = useRef(false);
  const id = useId();
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(time.from);
  const [to, setTo] = useState(time.to);
  const [problems, setProblems] = useState<{ from?: string; to?: string }>({});

  // Each opening starts from the range in use, with the checked preset (or the first) focused.
  useLayoutEffect(() => {
    if (!open) return;
    setCustom(false);
    setFrom(time.from);
    setTo(time.to);
    setProblems({});
    const items = menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    const checked = menu.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    (checked ?? items?.[0])?.focus({ preventScroll: true });
    // Only when it opens.
  }, [open]);
  useEffect(() => { if (custom) fromField.current?.focus(); }, [custom]);

  const close = useCallback(() => onClose(false), [onClose]);
  useCloseOutside(open, root, close);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const now = Math.floor(Date.now() / 1000);
    const start = parseTimeExpr(from, now);
    const end = parseTimeExpr(to, now);
    const next = {
      from: start === null ? TIME_COPY : undefined,
      to: end === null ? TIME_COPY : start !== null && start >= end ? AFTER : undefined,
    };
    setProblems(next);
    if (next.from) { fromField.current?.focus(); return; }
    if (next.to) return;
    onPick({ from: from.trim(), to: to.trim() });
  };

  const label = timeLabel(time);
  return (
    <div ref={root} className={s.popAnchor}>
      <button ref={buttonRef} type="button" className={s.chip} aria-haspopup="menu" aria-expanded={open} aria-keyshortcuts="t"
        onPointerDown={() => { pressing.current = true; setTimeout(() => { pressing.current = false; }, 500); }}
        onClick={() => { pressing.current = false; if (open) onClose(true); else onOpen(); }}>
        <svg className={s.chipIcon} viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></svg>
        {label}
        <span className={s.caret} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div {...POPUP} className={s.popup} onKeyDown={escapeCloses(() => onClose(true))} onBlur={(e) => closesOnLeave(close, pressing.current ? root : undefined)(e)}>
          <div ref={menu} role="menu" aria-label="Time range" className={s.menu} onKeyDown={menuKeys}>
            {TIME_PRESETS.map((p) => {
              const on = time.to === "now" && time.from === p.from;
              return (
                <button key={p.from} type="button" role="menuitemradio" aria-checked={on} className={s.menuItem} tabIndex={-1}
                  onClick={() => onPick({ from: p.from, to: "now" })}>
                  <span className={s.check} aria-hidden="true">{on ? "✓" : ""}</span>{p.label}
                </button>
              );
            })}
            <button type="button" role="menuitem" aria-expanded={custom} className={s.menuItem} data-divider tabIndex={-1}
              onClick={() => setCustom(true)}>
              <span className={s.check} aria-hidden="true" />Custom range…
            </button>
          </div>
          {custom && (
            <form className={s.custom} onSubmit={apply} noValidate>
              <label className={s.field}>
                <span className={s.fieldLabel}>From</span>
                <input ref={fromField} className={s.input} value={from} placeholder="now-6h" spellCheck={false} autoComplete="off"
                  aria-invalid={problems.from ? true : undefined} aria-describedby={problems.from ? `${id}-from` : undefined}
                  onChange={(e) => { setFrom(e.target.value); setProblems((p) => ({ ...p, from: undefined })); }} />
              </label>
              {problems.from && <p id={`${id}-from`} className={s.fieldProblem}>{problems.from}</p>}
              <label className={s.field}>
                <span className={s.fieldLabel}>To</span>
                <input className={s.input} value={to} placeholder="now" spellCheck={false} autoComplete="off"
                  aria-invalid={problems.to ? true : undefined} aria-describedby={problems.to ? `${id}-to` : undefined}
                  onChange={(e) => { setTo(e.target.value); setProblems((p) => ({ ...p, to: undefined })); }} />
              </label>
              {problems.to && <p id={`${id}-to`} className={s.fieldProblem}>{problems.to}</p>}
              <button type="submit" className={s.apply}>Apply</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
