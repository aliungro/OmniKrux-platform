import { useId } from "react";
import s from "./Sidebar.module.css";

/** The L1 bar, drawn in its final place. Dashboards come in the next update, so both stay off. */
export function NewDashboardBar() {
  const note = useId();
  return (
    <div className={s.foot}>
      <div className={s.l1}>
        <button type="button" className={s.newDashboard} aria-disabled="true" aria-describedby={note}>
          <span className={s.newIcon} aria-hidden="true">+</span>
          New dashboard
        </button>
        <button type="button" className={s.importButton} aria-label="Import" aria-disabled="true" aria-describedby={note} title="Import">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.5h10" /></svg>
        </button>
      </div>
      <p id={note} className={s.footNote}>Dashboards arrive in the next update.</p>
    </div>
  );
}
