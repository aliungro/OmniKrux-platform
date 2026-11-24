// A stand-in for the Import page until it is built (it replaces this file). Lazy, like Explore.
import { useEffect, useRef } from "react";
import s from "../MonitoringApp.module.css";
import { keyboardIsFree } from "../pages/Gone";
import type { MonitoringPageProps } from "../MonitoringApp";

export default function ImportPage({ nav }: MonitoringPageProps) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (keyboardIsFree()) button.current?.focus(); }, []);
  return (
    <section className={s.gone} data-monitoring-page>
      <p className={s.goneText}>Importing dashboards isn't ready yet.</p>
      <button ref={button} type="button" className={s.primary} onClick={() => nav.navigate({ page: "home" }, "push")}>Go to Home</button>
    </section>
  );
}
