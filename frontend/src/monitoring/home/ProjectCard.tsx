import { useId, type CSSProperties } from "react";
import type { HealthOut, ProjectOut, SourceOut } from "../api/types";
import { mayMixClusters, mixedLinkWords } from "../alerts/rules/clusterWarning";
import { DOT } from "../sidebar/Sidebar";
import { sortLinks, stateWords } from "../sources/sourceLabels";
import s from "./MonitoringHome.module.css";

/** A health reading older than this is shown with its age, never as current. */
export const STALE_MS = 2 * 60_000;

export type Health = Record<string, HealthOut>;
const UNKNOWN: HealthOut = { state: "unknown", message: null, version: null, checked_at: null };

/** "checked 5 min ago" for a reading older than two minutes; null for a fresh one or one never taken. */
export function ageNote(checkedAt: string | null, now: number): string | null {
  if (!checkedAt) return null;
  const age = now - Date.parse(checkedAt);
  if (!Number.isFinite(age) || age < STALE_MS) return null;
  const minutes = Math.floor(age / 60_000);
  return minutes >= 120 ? `checked ${Math.floor(minutes / 60)} h ago` : `checked ${minutes} min ago`;
}

export const firingWords = (n: number) => `${n} firing`;

export const STATE_WORDS = { up: "Up", down: "Can't be reached", unknown: "Not checked yet" } as const;

/** What a source's health reads as: a reading that was never taken is unknown, whatever the state says. */
export function stateOf(h: HealthOut | undefined): HealthOut["state"] {
  return h && h.checked_at ? h.state : "unknown";
}

/** The project's colour: its cluster's provider, or the project kind's. */
export function projectDot(p: ProjectOut): string {
  if (p.kind === "kubernetes" && p.cluster_provider && p.cluster_provider in DOT) return DOT[p.cluster_provider as keyof typeof DOT];
  return p.kind === "docker" || p.kind === "servers" ? DOT.onprem : DOT.custom;
}

export function kindLine(p: ProjectOut, clusterName: string | null): string {
  switch (p.kind) {
    case "kubernetes": return clusterName ? `Kubernetes · ${clusterName}` : "Kubernetes";
    case "docker": return "Docker host";
    case "servers": return "Servers";
    case "custom": return "Your own project";
  }
}

interface Props {
  project: ProjectOut;
  health: Health;
  now: number;
  /** The cluster's name, when known. */
  clusterName: string | null;
  /** The project's cluster is no longer in the console. */
  clusterGone: boolean;
  /** Alerts firing for the project; none shown when not known or 0. */
  firing?: number;
  onOpen(newTab: boolean): void;
}

export function ProjectCard({ project, health, now, clusterName, clusterGone, firing, onOpen }: Props) {
  const warnId = useId();
  const warned = project.links.filter((l) => mayMixClusters(project, l));
  return (
    <button type="button" className={s.card} aria-describedby={warned.length ? warnId : undefined} onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}>
      <span className={s.cardHead}>
        <i className={`${s.dot} ${s.headMark}`} style={{ "--mark": projectDot(project) } as CSSProperties} aria-hidden="true" />
        <span className={s.cardName}>{project.name}</span>
        {firing !== undefined && firing > 0 && <span className={s.firingCount}>{firingWords(firing)}</span>}
      </span>
      <span className={s.cardSub}>{kindLine(project, clusterName)}</span>
      {clusterGone && <span className={s.cardWarn}>Cluster no longer connected</span>}
      <span className={s.rows}>
        {project.links.length === 0 && <span className={s.row}><span className={s.rowText}>No sources yet</span></span>}
        {sortLinks(project.links).map((l) => {
          const h = health[l.source_id] ?? UNKNOWN;
          const state = stateOf(h);
          const why = state === "down" ? (h.message ?? undefined) : undefined;
          const age = state === "unknown" ? null : ageNote(h.checked_at, now);
          return (
            <span key={l.source_id} className={s.row} data-state={state} title={why}>
              <i className={s.pip} aria-hidden="true" />
              <span className={s.rowText} title={why}>{`${l.source_name} · ${stateWords(h, l.source_type)}`}</span>
              {age && <span className={s.age}>{age}</span>}
            </span>
          );
        })}
      </span>
      {/* Read as the card's description, not as part of its name. */}
      {warned.length > 0 && (
        <span id={warnId} className={s.cardWarn} aria-hidden="true">
          {warned.map((l) => mixedLinkWords(l.source_name)).join(" ")}
        </span>
      )}
    </button>
  );
}

/** Counts of a set of sources by health: unknown is what was never checked or has no reading. */
export function summarize(sources: Pick<SourceOut, "id">[], health: Health): { up: number; down: number; unknown: number } {
  const out = { up: 0, down: 0, unknown: 0 };
  for (const x of sources) out[stateOf(health[x.id])] += 1;
  return out;
}
