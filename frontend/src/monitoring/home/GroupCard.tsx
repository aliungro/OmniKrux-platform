import type { HealthOut } from "../api/types";
import { ageNote, firingWords, stateOf, summarize, type Health } from "./ProjectCard";
import s from "./MonitoringHome.module.css";

interface Props {
  name: string;
  projectCount: number;
  /** The distinct sources of the group's projects. */
  sourceIds: string[];
  health: Health;
  now: number;
  /** Alerts firing for the group; none shown when not known or 0. */
  firing?: number;
  onOpen(newTab: boolean): void;
}

export function GroupCard({ name, projectCount, sourceIds, health, now, firing, onOpen }: Props) {
  const { up, down, unknown } = summarize(sourceIds.map((id) => ({ id })), health);
  const total = sourceIds.length;
  let line: string;
  let state: HealthOut["state"];
  if (total === 0 || unknown === total) { line = "Sources not checked yet"; state = "unknown"; }
  else if (down > 0) { line = `${down} of ${total} sources can't be reached`; state = "down"; }
  else if (up === total) { line = "All sources up"; state = "up"; }
  else { line = `${up} of ${total} sources up, ${unknown} not checked yet`; state = "unknown"; }
  // The oldest reading that went into the line: the line is never shown as current if it isn't.
  const stale = sourceIds
    .filter((id) => stateOf(health[id]) !== "unknown")
    .map((id) => health[id].checked_at as string)
    .sort()[0];
  const age = stale ? ageNote(stale, now) : null;
  return (
    <button type="button" className={s.card} onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}>
      <span className={s.cardHead}>
        <i className={`${s.folder} ${s.headMark}`} aria-hidden="true" />
        <span className={s.cardName}>{name}</span>
        {firing !== undefined && firing > 0 && <span className={s.firingCount}>{firingWords(firing)}</span>}
      </span>
      <span className={s.cardSub}>{projectCount === 0 ? "No projects yet" : `${projectCount} ${projectCount === 1 ? "project" : "projects"}`}</span>
      {projectCount > 0 && <span className={s.rows}>
        <span className={s.row} data-state={state}>
          <i className={s.pip} aria-hidden="true" />
          <span className={s.rowText}>{line}</span>
          {age && <span className={s.age}>{age}</span>}
        </span>
      </span>}
    </button>
  );
}
