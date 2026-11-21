// Refresh now, and the auto-refresh interval.
import type { RefObject } from "react";
import type { RefreshSpec } from "../schema";
import { REFRESH_LABELS } from "../time";
import s from "./DashboardPage.module.css";

interface Props {
  value: RefreshSpec;
  onRefresh(): void;
  onChange(value: RefreshSpec): void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

export function RefreshControl({ value, onRefresh, onChange, buttonRef }: Props) {
  return (
    <div className={s.refresh} role="group" aria-label="Refresh">
      <button ref={buttonRef} type="button" className={s.refreshNow} aria-label="Refresh now" title="Refresh now (r)"
        aria-keyshortcuts="r" onClick={onRefresh}>
        <span aria-hidden="true">⟳</span>
      </button>
      <select className={s.refreshEvery} aria-label="Auto-refresh" value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : (e.target.value as RefreshSpec))}>
        {REFRESH_LABELS.map((r) => <option key={r.label} value={r.value ?? ""}>{r.label}</option>)}
      </select>
    </div>
  );
}
