// Under the Alerts bar: what the alert checks of OmniKrux are doing, in the engine's own words, and
// when it last checked. Late or turned off is said in the warn tone: rules checked by OmniKrux need
// it running. An overview that can't be read says so; it never reads as "all on time".

import { failure } from "../../../api/http";
import type { AlertRequestError, OverviewOut } from "../api";
import { clockTime } from "./words";
import s from "./AlertsPage.module.css";

export function EngineNote({ overview, error }: { overview: OverviewOut | undefined; error: AlertRequestError | null }) {
  if (!overview) {
    return (
      <p role="note" className={s.engineNote} data-tone={error ? "warn" : "muted"}>
        {error ? `The state of the alert checks couldn't be read. ${failure(error, "try again")}` : "Reading the state of the alert checks…"}
      </p>
    );
  }
  const engine = overview.engine;
  const warn = !engine.enabled || engine.behind > 0 || !engine.running;
  const last = engine.last_tick_at ? ` Last check ${clockTime(engine.last_tick_at)}.` : "";
  return (
    <p role="note" className={s.engineNote} data-tone={warn ? "warn" : "muted"}>
      <span className={s.engineMark} aria-hidden="true" />
      <span>{engine.note}{last}</span>
    </p>
  );
}
