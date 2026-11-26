// Refresh now, and the auto-refresh interval.
import type { RefObject } from "react";
import type { RefreshSpec } from "../schema";
import { REFRESH_LABELS } from "../time";
import s from "./DashboardPage.module.css";

export const FIXED_RANGE_WORDS = "A fixed time range doesn't change. Pick a range that ends now to refresh it.";

interface Props {
  value: RefreshSpec;
  /** The range doesn't end at now: auto-refresh is off, and says why. */
  fixed?: boolean;
  onRefresh(): void;
  onChange(value: RefreshSpec): void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

export function RefreshControl({ value, fixed = false, onRefresh, onChange, buttonRef }: Props) {
  return (
    <div className={s.refresh} role="group" aria-label="Refresh" title={fixed ? FIXED_RANGE_WORDS : undefined}>
      <button ref={buttonRef} type="button" className={s.refreshNow} aria-label="Refresh now" title="Refresh now (r)"
        aria-keyshortcuts="r" onClick={onRefresh}>
        <span aria-hidden="true">⟳</span>
      </button>
      <select className={s.refreshEvery} aria-label="Auto-refresh" value={fixed ? "" : (value ?? "")}
        disabled={fixed} title={fixed ? FIXED_RANGE_WORDS : ""}
        onChange={(e) => onChange(e.target.value === "" ? null : (e.target.value as RefreshSpec))}>
        {REFRESH_LABELS.map((r) => <option key={r.label} value={r.value ?? ""}>{r.label}</option>)}
      </select>
    </div>
  );
}
