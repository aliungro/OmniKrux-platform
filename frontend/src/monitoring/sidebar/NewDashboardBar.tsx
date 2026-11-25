import { useId } from "react";
import k from "../../features/chrome/key.module.css";
import type { Owner } from "../dashboards/create/currentOwner";
import s from "./Sidebar.module.css";

export const IMPORT_TITLE = "Import dashboards (I)";

/**
 * The L1 bar: New dashboard (N), Import (I), and a line saying where a new dashboard goes. With no
 * project yet there is nowhere for one to go, so New dashboard stays off; Import stays on (a
 * Grafana import can still go into a group, and the Import page explains the rest).
 */
export function NewDashboardBar({ owner, loaded, hasProjects, onNew, onImport }: {
  /** Where new dashboards go (`currentOwner`); null: picked in the dialog. */
  owner: Owner | null;
  /** The projects and groups have been read. */
  loaded: boolean;
  hasProjects: boolean;
  onNew(from: HTMLElement): void;
  /** Opens Import for `owner` (none: picked there); `newTab` on Ctrl+click. */
  onImport(newTab: boolean): void;
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
        <button type="button" className={s.importButton} aria-label="Import" title={IMPORT_TITLE} aria-keyshortcuts="i"
          onClick={(e) => onImport(e.ctrlKey || e.metaKey)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.5h10" /></svg>
        </button>
      </div>
      <p id={note} className={s.footNote} data-new-dashboard-note="">{line}</p>
    </div>
  );
}
