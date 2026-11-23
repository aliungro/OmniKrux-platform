// Recent: what happened to a rule, newest first (up to 20 entries). Read again every 15 seconds
// while shown; a read that fails says so rather than passing the last list off as current.

import { useQuery } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { alertsKeys, ruleHistory, type AlertRequestError, type HistoryKind, type HistoryOut, type RuleOut } from "../api";
import { hourMinute, labelsText } from "./words";
import s from "./AlertsPage.module.css";

const SHOWN = 20;
const REFETCH_MS = 15_000;

export const HISTORY_WORDS: Record<HistoryKind, string> = {
  firing: "Started firing",
  resolved: "Resolved",
  cant_check: "Can't check",
  checking_again: "Checking again",
  error: "Query error",
  applied: "Applied",
  apply_failed: "Couldn't apply",
  removed: "Removed",
};

const TONE: Record<HistoryKind, "bad" | "ok" | "warn" | "muted"> = {
  firing: "bad", resolved: "ok", cant_check: "warn", checking_again: "muted", error: "warn", applied: "ok", apply_failed: "warn", removed: "muted",
};

export function RuleHistory({ rule }: { rule: RuleOut }) {
  const history = useQuery<HistoryOut[], AlertRequestError>({
    queryKey: alertsKeys.history(rule.id),
    queryFn: ({ signal }) => ruleHistory(rule.id, 50, signal),
    refetchInterval: REFETCH_MS,
    retry: false,
  });
  const group = rule.scope.kind === "group";
  let body;
  if (history.isError) {
    body = (
      <p className={s.quiet} data-tone="warn">
        The rule's history couldn't be read. {failure(history.error, "try again")}{" "}
        <button type="button" className={s.linkButton} onClick={() => void history.refetch()}>Try again</button>
      </p>
    );
  } else if (!history.data) body = <p className={s.quiet} role="status">Loading…</p>;
  else if (history.data.length === 0) body = <p className={s.quiet}>Nothing has happened yet.</p>;
  else {
    body = (
      <ol className={s.history}>
        {history.data.slice(0, SHOWN).map((h, i) => {
          const parts = [HISTORY_WORDS[h.kind], group ? h.project_name : "", labelsText(h.labels), h.message ?? ""].filter((p) => p !== "");
          return (
            <li key={`${h.at}:${h.kind}:${i}`} className={s.historyRow}>
              <time className={s.historyTime} dateTime={h.at}>{hourMinute(h.at)}</time>
              <span className={s.historyMark} data-tone={TONE[h.kind]} aria-hidden="true" />
              <span className={s.historyText}>{parts.join(" · ")}</span>
            </li>
          );
        })}
      </ol>
    );
  }
  return (
    <section className={s.recent} aria-labelledby={`recent-${rule.id}`}>
      <h3 id={`recent-${rule.id}`} className={s.subhead}>Recent</h3>
      {body}
    </section>
  );
}
