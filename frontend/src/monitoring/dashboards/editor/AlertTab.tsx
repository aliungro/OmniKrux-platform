// The Alert tab: panel alerts come with the Alerts page in a later plan; the document keeps
// `alert: null` until then.
import s from "./SidePanel.module.css";

export const ALERTS_LATER = "Alerts arrive in a later update, together with the Alerts page.";

export function AlertTab() {
  return <p className={s.later}>{ALERTS_LATER}</p>;
}
