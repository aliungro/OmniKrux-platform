import { useId } from "react";
import k from "../../features/chrome/key.module.css";
import type { Owner } from "../dashboards/create/currentOwner";
import s from "./Sidebar.module.css";

const IMPORT_LATER = "Importing dashboards arrives in a later update.";

/**
 * The L1 bar: New dashboard (N), Import (a later update), and a line saying where a new dashboard
 * goes. With no project yet there is nowhere for one to go, so New dashboard stays off.
 */
export function NewDashboardBar({ owner, loaded, hasProjects, onNew }: {
  /** Where new dashboards go (`currentOwner`); null: picked in the dialog. */
  owner: Owner | null;
  /** The projects and groups have been read. */
  loaded: boolean;
  hasProjects: boolean;
  onNew(from: HTMLElement): void;
}) {
  const note = useId();
  const off = !loaded || !hasProjects;
  const line = !loaded ? null
    : !hasProjects ? "Set up a project first."
    : owner ? <>New dashboards go to <b className={s.footOwner}>{owner.name}</b></>
    : "Pick where it goes when you create it.";
  return (
    <div className={s.foot}>
      <div className={s.l1}>
        <button type="button" className={s.newDashboard} aria-disabled={off || undefined} aria-describedby={note} aria-keyshortcuts="n"
          onClick={(e) => { if (!off) onNew(e.currentTarget); }}>
          <span className={s.newIcon} aria-hidden="true">+</span>
          New dashboard
          <span className={`${k.k} ${s.newKey}`} aria-hidden="true">N</span>
        </button>
        <button type="button" className={s.importButton} aria-label="Import" aria-disabled="true" title={IMPORT_LATER} aria-description={IMPORT_LATER}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.5h10" /></svg>
        </button>
      </div>
      <p id={note} className={s.footNote} data-new-dashboard-note="">{line}</p>
    </div>
  );
}
