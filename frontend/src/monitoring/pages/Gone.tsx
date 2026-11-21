import { useEffect, useRef } from "react";
import s from "../MonitoringApp.module.css";

export type GoneWhat = "project" | "group" | "source" | "dashboard";

/**
 * Whether a page may take the keyboard as it appears: only when nothing else has it (`<body>`,
 * the workspace's `<main>`, or the page area). Typing in Find or moving in the tree keeps it.
 */
export function keyboardIsFree(): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || active.tagName === "MAIN") return true;
  return active.closest("[data-monitoring-page]") !== null;
}

/** A page whose project, group, source or dashboard was removed: say so, and offer Home. */
export function Gone({ what, onHome }: { what: GoneWhat; onHome(): void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (keyboardIsFree()) button.current?.focus(); }, []);
  return (
    <section className={s.gone}>
      <p className={s.goneText}>This {what} no longer exists.</p>
      <button ref={button} type="button" className={s.primary} onClick={onHome}>Go to Home</button>
    </section>
  );
}
