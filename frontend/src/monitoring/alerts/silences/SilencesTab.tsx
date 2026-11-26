// The Silences view (A3): every silence, OmniKrux's and the linked Alertmanagers', with New silence
// and Expire…; the ones that ended are folded apart under Expired, where OmniKrux's own can be
// removed. An Alertmanager that couldn't be read is said so above the rows and never hides the
// others. A silence asked for from a rule (or Home) opens the form prefilled. Rows are read again
// every 30 seconds.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { DeleteReviewDialog } from "../../DeleteReviewDialog";
import {
  alertsKeys, listSilences, refreshAlerts, expireSilence, removeExpiredSilence, type AlertRequestError, type SilenceOut, type SilencesOut,
} from "../api";
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

const isOver = (x: SilenceOut, now: number) => x.state === "expired" || Date.parse(x.ends_at) <= now;

export function stateWords(x: SilenceOut, now: number): string {
  if (isOver(x, now)) return "Expired";
  return x.state === "pending" ? `Starts ${whenShort(x.starts_at, now)}` : "Active";
}

/** Where it holds: `In OmniKrux`, or the Alertmanager by its name (`In Alertmanager` without one). */
export const whereWords = (x: SilenceOut) =>
  x.where.kind === "omnikrux" ? "In OmniKrux" : `In ${x.where.source_name ?? "Alertmanager"}`;

interface RowProps {
  x: SilenceOut;
  now: number;
  onExpire(x: SilenceOut, button: HTMLButtonElement): void;
  onRemove(x: SilenceOut): void;
  /** Being removed now, or why it couldn't be. */
  removing?: { busy: boolean; error: string | null };
}

function SilenceRow({ x, now, onExpire, onRemove, removing }: RowProps) {
  const state = stateWords(x, now);
  const over = state === "Expired";
  const left = (Date.parse(x.ends_at) - now) / 1000;
  return (
    <li className={s.item} data-state={over ? "expired" : x.state}>
      <div className={s.chips}>
        {splitMatchers(x.matchers).map((m, i) => <span key={`${i}:${m}`} className={s.chip}>{m}</span>)}
      </div>
      <p className={s.when}>
        {over
          ? <><strong>Expired</strong> at {whenShort(x.ends_at, now)}</>
          : <><strong>{state}</strong> until {whenShort(x.ends_at, now)}</>}
        {!over && Number.isFinite(left) && <> ({durationWords(left)} left)</>}
      </p>
      {x.comment && <p className={s.comment}>{x.comment}</p>}
      <p className={s.meta}>
        {whereWords(x)}
        {x.affects !== null && !over && <> · Silences {plural(x.affects)} now</>}
      </p>
      {!over && (
        <div className={s.side}>
          <button type="button" className={s.small} aria-label={`Expire… ${x.matchers}`}
            onClick={(e) => onExpire(x, e.currentTarget)}>
            Expire…
          </button>
        </div>
      )}
      {/* An Alertmanager keeps (and drops) its own expired silences. */}
      {over && x.where.kind === "omnikrux" && (
        <div className={s.side}>
          <button type="button" className={s.small} aria-label={`Remove ${x.matchers}`} aria-disabled={removing?.busy || undefined}
            onClick={() => onRemove(x)}>
            {removing?.busy ? "Removing…" : "Remove"}
          </button>
        </div>
      )}
      {removing?.error && <p className={s.rowError} role="alert">{removing.error}</p>}
    </li>
  );
}

export interface SilencesTabProps {
  ask: SilenceAsk | null;
  onAskTaken(): void;
  leaveRef: LeaveRef;
  tabId?: string;
  /** Said above the list: an alert asked about (from Home) that stopped firing. */
  note?: string | null;
}

export function SilencesTab({ ask, onAskTaken, leaveRef, tabId, note = null }: SilencesTabProps) {
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

  // The form: opened by New silence, or by a rule's Silence (prefilled, once per ask). An ask that
  // arrives while the view is shown opens it too, unless a form is open (what is typed there stays).
  const keyCount = useRef(ask ? 1 : 0);
  const [form, setForm] = useState<{ key: number; prefill?: SilencePrefill } | null>(() => (ask ? { key: 1, prefill: ask.prefill } : null));
  const taken = useRef(ask);
  useEffect(() => {
    if (!ask) return;
    if (taken.current !== ask) {
      taken.current = ask;
      setForm((f) => {
        if (f) return f;
        keyCount.current += 1;
        return { key: keyCount.current, prefill: ask.prefill };
      });
    }
    onAskTaken();
  }, [ask, onAskTaken]);
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

  // Remove (an expired OmniKrux silence): at once, as it no longer mutes anything. The keyboard goes
  // to the Expired fold, or to New silence when the fold went with it.
  const [removing, setRemoving] = useState<{ id: string; busy: boolean; error: string | null } | null>(null);
  const foldRef = useRef<HTMLElement>(null);
  const wantFold = useRef(false);
  useLayoutEffect(() => {
    if (!wantFold.current) return;
    wantFold.current = false;
    (foldRef.current ?? newRef.current)?.focus();
  });
  const remove = async (x: SilenceOut) => {
    if (removing?.busy) return;
    setRemoving({ id: x.id, busy: true, error: null });
    try {
      await removeExpiredSilence(x.id);
    } catch (err) {
      if ((err as AlertRequestError).code !== "not_found") {
        setRemoving({ id: x.id, busy: false, error: failure(err, "try again") });
        return;
      }
    }
    // Gone at once; the list is read again too.
    client.setQueryData<SilencesOut>(alertsKeys.silences, (old) =>
      old && { ...old, silences: old.silences.filter((y) => !(y.where.kind === "omnikrux" && y.id === x.id)) });
    wantFold.current = true;
    setRemoving(null);
    await refreshAlerts(client);
  };

  const data = query.data;
  const stale = query.isError && data !== undefined;
  const current = data ? data.silences.filter((x) => !isOver(x, now)) : [];
  const past = data ? data.silences.filter((x) => isOver(x, now)) : [];
  const row = (x: SilenceOut) => (
    <SilenceRow key={`${x.where.kind}:${x.id}`} x={x} now={now} onExpire={askExpire} onRemove={(y) => void remove(y)}
      removing={removing?.id === x.id ? removing : undefined} />
  );
  let body;
  if (!data) {
    body = query.isError ? (
      <div className={s.note} role="alert">
        <p>The silences couldn't be read. {failure(query.error, "try again")}</p>
        <div><button type="button" className={s.small} onClick={() => void query.refetch()}>Try again</button></div>
      </div>
    ) : <p className={s.empty} role="status">Loading…</p>;
  } else {
    body = (
      <>
        {current.length > 0
          ? <ul className={s.list} aria-label="Silences">{current.map(row)}</ul>
          : past.length === 0 && <p className={s.empty}>{NO_SILENCES}</p>}
        {past.length > 0 && (
          <details className={s.fold}>
            <summary ref={foldRef} className={s.foldTitle}>Expired ({past.length})</summary>
            <ul className={s.list} aria-label="Expired silences">{past.map(row)}</ul>
          </details>
        )}
      </>
    );
  }

  return (
    <section className={s.view} aria-label="Silences">
      <div className={s.head}>
        <h2 className={s.headTitle}>Silences</h2>
        <span className={s.spacer} />
        <button ref={newRef} type="button" className={s.secondary} onClick={openNew} aria-disabled={form !== null || undefined}>New silence</button>
      </div>
      {note && <p className={s.notice} role="status">{note}</p>}
      {form && <SilenceForm key={form.key} prefill={form.prefill} onDone={closeForm} leaveRef={leaveRef} tabId={tabId} problems={data?.problems} />}
      {data && data.problems.length > 0 && (
        <ul className={s.problems} aria-label="Problems" data-tone="warn">
          {data.problems.map((p) => <li key={`${p.source_id}:${p.source_name}`} className={s.problem}>{p.source_name}: {p.message}</li>)}
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
