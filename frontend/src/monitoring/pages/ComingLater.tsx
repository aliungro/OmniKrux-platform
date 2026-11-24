import s from "../MonitoringApp.module.css";

/** A page whose content arrives in a later update (the cluster's monitoring tools, until they do). */
export function ComingLater() {
  return (
    <section className={s.gone}>
      <p className={s.goneText}>This page comes in a later update.</p>
    </section>
  );
}
