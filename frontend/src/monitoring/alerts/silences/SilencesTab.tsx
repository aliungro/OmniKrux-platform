// The Silences view (A3): every silence, OmniKrux's and the linked Alertmanagers', with New silence
// and Expire…. An Alertmanager that couldn't be read is said so above the rows and never hides the
// others. A silence asked for from a rule opens the form prefilled. Rows are read again every 30 seconds.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { DeleteReviewDialog } from "../../DeleteReviewDialog";
import { alertsKeys, listSilences, refreshAlerts, expireSilence, type AlertRequestError, type SilenceOut, type SilencesOut } from "../api";
import { durationWords } from "../format";
import type { LeaveRef } from "../leave";
import { SilenceForm, plural, type SilencePrefill } from "./SilenceForm";
import { splitMatchers, whenShort } from "./when";
import s from "./Silences.module.css";

export const NO_SILENCES = "No silences.";
export const EXPIRE_TITLE = "Expire this silence?";
export const EXPIRE_BODY = "Its alerts notify again at their next check.";
const REFETCH_MS = 30_000;

/** A silence asked for from a rule: a new number each time, so the same rule can ask again. */
export interface SilenceAsk {
  n: number;
  prefill: SilencePrefill;
}

export function stateWords(x: SilenceOut, now: number): string {
  const ended = x.state === "expired" || Date.parse(x.ends_at) <= now;
  if (ended) return "Expired";
  return x.state === "pending" ? `Starts ${whenShort(x.starts_at, now)}` : "Active";
}

export const whereWords = (x: SilenceOut) =>
  x.where.kind === "omnikrux" ? "In OmniKrux" : `In Alertmanager${x.where.source_name ? ` · ${x.where.source_name}` : ""}`;

function SilenceRow({ x, now, onExpire }: { x: SilenceOut; now: number; onExpire(x: SilenceOut, button: HTMLButtonElement): void }) {
  const state = stateWords(x, now);
  const ended = state === "Expired";
  const left = (Date.parse(x.ends_at) - now) / 1000;
  return (
    <li className={s.item} data-state={ended ? "expired" : x.state}>
      <div className={s.chips}>
        {splitMatchers(x.matchers).map((m, i) => <span key={`${i}:${m}`} className={s.chip}>{m}</span>)}
      </div>
      <p className={s.when}>
        <strong>{state}</strong> until {whenShort(x.ends_at, now)}
        {!ended && Number.isFinite(left) && <> ({durationWords(left)} left)</>}
      </p>
      {x.comment && <p className={s.comment}>{x.comment}</p>}
      <p className={s.meta}>
        {whereWords(x)}
        {x.affects !== null && !ended && <> · Silences {plural(x.affects)} now</>}
      </p>
      {!ended && (
        <div className={s.side}>
          <button type="button" className={s.small} aria-label={`Expire… ${x.matchers}`}
            onClick={(e) => onExpire(x, e.currentTarget)}>
            Expire…
          </button>
        </div>
      )}
    </li>
  );
}

export function SilencesTab({ ask, onAskTaken, leaveRef, tabId }: { ask: SilenceAsk | null; onAskTaken(): void; leaveRef: LeaveRef; tabId?: string }) {
  const client = useQueryClient();
  const query = useQuery<SilencesOut, AlertRequestError>({
    queryKey: alertsKeys.silences, queryFn: ({ signal }) => listSilences(signal), refetchInterval: REFETCH_MS, retry: false,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [query.dataUpdatedAt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), REFETCH_MS);
    return () => clearInterval(timer);
  }, []);

  // The form: opened by New silence, or by a rule's Silence (prefilled, once per ask).
  const [form, setForm] = useState<{ key: number; prefill?: SilencePrefill } | null>(() => (ask ? { key: ask.n, prefill: ask.prefill } : null));
  useEffect(() => { if (ask) onAskTaken(); }, [ask, onAskTaken]);
  const keyCount = useRef(ask?.n ?? 0);
  const newRef = useRef<HTMLButtonElement>(null);
  const wantNew = useRef(false);
  const closeForm = () => {
    wantNew.current = true;
    setForm(null);
  };
  useLayoutEffect(() => {
    if (wantNew.current && form === null) {
      wantNew.current = false;
      newRef.current?.focus();
    }
  });
  const openNew = () => {
    // An open form keeps what was typed in it: New silence does nothing until it is closed.
    if (form) return;
    keyCount.current += 1;
    setForm({ key: keyCount.current });
  };

  // Expire…: asked first; the keyboard comes back to New silence after.
  const [expiring, setExpiring] = useState<SilenceOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = useRef<HTMLElement | null>(null);
  const askExpire = (x: SilenceOut, button: HTMLButtonElement) => {
    restore.current = button;
    setError(null);
    setExpiring(x);
  };
  const expire = async () => {
    if (!expiring || busy) return;
    setBusy(true);
    setError(null);
    try {
      await expireSilence(expiring.where.kind, expiring.id, expiring.where.source_id);
    } catch (err) {
      if ((err as AlertRequestError).code !== "not_found") {
        setError(failure(err, "try again"));
        setBusy(false);
        return;
      }
    }
    restore.current = newRef.current;
    setExpiring(null);
    setBusy(false);
    await refreshAlerts(client);
  };

  const data = query.data;
  const stale = query.isError && data !== undefined;
  let body;
  if (!data) {
    body = query.isError ? (
      <div className={s.note} role="alert">
        <p>The silences couldn't be read. {failure(query.error, "try again")}</p>
        <div><button type="button" className={s.small} onClick={() => void query.refetch()}>Try again</button></div>
      </div>
    ) : <p className={s.empty} role="status">Loading…</p>;
  } else if (data.silences.length === 0) {
    body = <p className={s.empty}>{NO_SILENCES}</p>;
  } else {
    body = (
      <ul className={s.list} aria-label="Silences">
        {data.silences.map((x) => <SilenceRow key={`${x.where.kind}:${x.id}`} x={x} now={now} onExpire={askExpire} />)}
      </ul>
    );
  }

  return (
    <section className={s.view} aria-label="Silences">
      <div className={s.head}>
        <h2 className={s.headTitle}>Silences</h2>
        <span className={s.spacer} />
        <button ref={newRef} type="button" className={s.secondary} onClick={openNew} aria-disabled={form !== null || undefined}>New silence</button>
      </div>
      {form && <SilenceForm key={form.key} prefill={form.prefill} onDone={closeForm} leaveRef={leaveRef} tabId={tabId} />}
      {data && data.problems.length > 0 && (
        <ul className={s.problems} aria-label="Problems" data-tone="warn">
          {data.problems.map((p) => <li key={p.source_name} className={s.problem}>{p.source_name}: {p.message}</li>)}
        </ul>
      )}
      {stale && (
        <p className={s.problem} role="status">
          Couldn't refresh the silences. {failure(query.error, "try again")}
        </p>
      )}
      {body}
      {expiring && (
        <DeleteReviewDialog title={EXPIRE_TITLE} action="Expire silence" busy={busy} error={error} restoreFocusTo={restore}
          onCancel={() => setExpiring(null)} onConfirm={() => void expire()}>
          <p>{EXPIRE_BODY}</p>
        </DeleteReviewDialog>
      )}
    </section>
  );
}
