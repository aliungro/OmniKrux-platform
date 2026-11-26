// Home's line about alerts: what fires now (a row each, opening the Alerts page on that rule), or
// one quiet line, plus a warn line for rules that can't be checked. An overview that can't be read
// says so and shows no counts; a refresh that fails keeps the last good read and says how old it is.

import { failure } from "../../api/http";
import { useAlertOverview, type FiringOut, type OverviewOut } from "../alerts/api";
import { staleStateWords } from "../alerts/page/words";
import type { ProjectOut } from "../api/types";
import type { MonitoringView } from "../shell/tabState";
import { projectDot } from "./ProjectCard";
import s from "./MonitoringHome.module.css";

/** The overview to show counts from: undefined unless the last read worked (never a stale count). */
export function useFreshOverview(): OverviewOut | undefined {
  const overview = useAlertOverview();
  return overview.isError ? undefined : overview.data;
}

export const quietWords = (rules: number) =>
  rules === 0 ? "All quiet · no alert rules yet" : rules === 1 ? "All quiet · 1 rule, not firing" : `All quiet · ${rules} rules, none firing`;
export const cantCheckWords = (n: number) => (n === 1 ? "1 rule can't be checked right now." : `${n} rules can't be checked right now.`);

interface Props {
  projects: ProjectOut[];
  onOpen(view: MonitoringView, newTab: boolean): void;
}

function FiringRow({ row, project, onOpen }: { row: FiringOut; project: ProjectOut | undefined; onOpen: Props["onOpen"] }) {
  const rule: MonitoringView = { page: "alerts", rule: row.rule_id };
  return (
    <li className={s.firingRow} data-severity={row.severity}>
      <span className={s.firingName}>{row.rule_name}</span>
      <span className={s.chip}>
        {project && <i className={s.dot} style={{ background: projectDot(project) }} aria-hidden="true" />}
        {row.project_name}
      </span>
      <span className={s.firingSummary}>{row.summary}</span>
      {row.instances > 0 && row.silenced >= row.instances && <span className={s.chip} data-quiet="">Silenced</span>}
      <span className={s.chip} data-quiet="">{row.where}</span>
      <span className={s.firingActions}>
        <button type="button" className={s.small} aria-label={`Silence ${row.rule_name}`}
          onClick={(e) => onOpen({ page: "alerts", tab: "silences", silence: { rule: row.rule_id, target: row.target_id } }, e.ctrlKey || e.metaKey)}>
          Silence
        </button>
        <button type="button" className={s.small} aria-label={`Open ${row.rule_name}`}
          onClick={(e) => onOpen(rule, e.ctrlKey || e.metaKey)}>Open</button>
      </span>
    </li>
  );
}

export function FiringSection({ projects, onOpen }: Props) {
  const query = useAlertOverview();
  const overview = query.data;
  if (!overview) {
    if (!query.isError) return null;
    return <p className={s.note} role="status">{`Alerts couldn't be read, so what is firing isn't shown. ${failure(query.error, "try again")}`}</p>;
  }
  const stale = query.isError ? staleStateWords(query.dataUpdatedAt) : null;
  const { counts, engine } = overview;
  const byId = new Map(projects.map((p) => [p.id, p]));
  const enginePoor = !engine.enabled || engine.behind > 0 || !engine.running;
  return (
    <div className={s.alertsBlock}>
      {overview.firing.length > 0 ? (
        <section aria-labelledby="monitoring-home-firing">
          <h2 id="monitoring-home-firing" className={s.heading}>Firing</h2>
          <ul className={s.firingList}>
            {overview.firing.map((row) => <FiringRow key={`${row.rule_id}:${row.target_id}`} row={row} project={byId.get(row.project_id)} onOpen={onOpen} />)}
          </ul>
        </section>
      ) : (
        <p className={s.quiet}><i className={s.quietDot} aria-hidden="true" />{quietWords(counts.rules)}</p>
      )}
      {counts.cant_check > 0 && (
        <button type="button" className={s.warnLine} onClick={(e) => onOpen({ page: "alerts" }, e.ctrlKey || e.metaKey)}>{cantCheckWords(counts.cant_check)}</button>
      )}
      {enginePoor && engine.note && <p className={s.warnText} role="note">{engine.note}</p>}
      {stale && <p className={s.warnText} role="status">{stale}</p>}
    </div>
  );
}
