// A small ? that explains something once, without taking a line from the screen. The text is a
// tooltip the button refers to; it shows on hover, on focus and on click, and Esc closes it with
// the keyboard still on the button (Esc is spent here, so a dialog around it stays open).

import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
import s from "./HelpTip.module.css";

export interface HelpTipProps {
  /** What the button is called for a screen reader, like "About this list". */
  label: string;
  children: ReactNode;
}

export default function HelpTip({ label, children }: HelpTipProps) {
  const tipId = useId();
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [clicked, setClicked] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = !dismissed && (hover || focus || clicked);

  // Leaving it (pointer and keyboard) lets the next visit show it again.
  useEffect(() => {
    if (!hover && !focus && !clicked) setDismissed(false);
  }, [hover, focus, clicked]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "Escape" || !open) return;
    e.preventDefault();
    e.stopPropagation();
    setDismissed(true);
    setClicked(false);
  };

  return (
    <span className={s.wrap} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button type="button" className={s.button} aria-label={label} aria-expanded={open}
        aria-describedby={tipId}
        onClick={() => { if (open && clicked) { setDismissed(true); setClicked(false); } else { setDismissed(false); setClicked(true); } }}
        onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); setClicked(false); }}
        onKeyDown={onKeyDown}>
        <span aria-hidden="true">?</span>
      </button>
      <span id={tipId} role="tooltip" className={s.bubble} hidden={!open}>{children}</span>
    </span>
  );
}
