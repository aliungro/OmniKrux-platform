import s from "../MonitoringApp.module.css";

export const EXPLORE_LATER =
  "Explore isn't here yet. It comes in a later update of Monitoring, after dashboards: query as you type, browse metrics and logs, and send a query to a dashboard.";
export const ALERTS_LATER =
  "Alerts aren't here yet. They come in a later update of Monitoring. Until then, nothing here evaluates rules or sends notifications.";

/** A page that arrives in a later update: its name and what to expect. */
export function ComingLater({ name, text }: { name: string; text?: string }) {
  return (
    <section className={s.later} aria-labelledby="monitoring-later-title">
      <h1 id="monitoring-later-title" className={s.pageTitle}>{name}</h1>
      <p className={s.laterNote}>{text ?? `${name} isn't here yet. It comes in a later update of Monitoring.`}</p>
    </section>
  );
}
