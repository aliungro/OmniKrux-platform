// The silence form (A3): where it holds, which alerts it picks (matchers, checked as you type, and
// for OmniKrux a preview of what it silences now), how long, and why. Opened by New silence, or
// prefilled from a rule's Silence button. Ctrl+Enter silences; Esc and Cancel ask first when there
// is something typed; the keyboard starts on Matchers (on Comment when the matchers came prefilled).

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { pressed } from "../../../features/chrome/shortcuts";
import { useSources } from "../../api/hooks";
import { validFilter } from "../../projects/FilterField";
import {
  alertsKeys, previewSilence, useChannels, useCreateSilence,
  type AlertRequestError, type RuleOut, type SilenceIn, type SilencePreviewOut, type TargetOut,
} from "../api";
import { DiscardDialog, useLeaveGuard, type LeaveRef } from "../leave";
import s from "./Silences.module.css";

/** Where a silence holds; an Alertmanager's `source_id` null means "the rule's project's one". */
export type SilenceWhere = { kind: "omnikrux" } | { kind: "alertmanager"; source_id: string | null };

export interface SilencePrefill {
  where: SilenceWhere;
  matchers: string;
  /** For a tool's rule: the project whose Alertmanager holds the silence, and the tool's name. */
  projectId?: string;
  tool?: string;
}

export const DISCARD_SILENCE = "Discard this silence?";
export const MATCHERS_PLACEHOLDER = 'alertname="HighErrorRate", project="prod-east"';
export const NEEDS_MATCHERS = 'Add the matchers that pick the alerts, like alertname="HighErrorRate".';
export const NEEDS_COMMENT = "Add a comment so others know why.";
export const NEEDS_UNTIL = "Pick when the silence ends.";
export const UNTIL_PAST = "Pick a time in the future.";
export const noAlertmanager = (tool: string) => `This rule runs in ${tool}; link its Alertmanager to silence it from here.`;

const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The silence a rule's Silence button starts: OmniKrux's checks by name and project; a tool's by rule id. */
export function silencePrefill(rule: RuleOut, target: TargetOut): SilencePrefill {
  if (target.engine === "tool") {
    return {
      where: { kind: "alertmanager", source_id: null }, matchers: `omnikrux_rule=${quote(rule.id)}`,
      projectId: target.project_id, tool: target.tool === "loki_ruler" || rule.source_type === "loki" ? "Loki" : "Prometheus",
    };
  }
  return { where: { kind: "omnikrux" }, matchers: `alertname=${quote(rule.name)},project=${quote(target.project_name)}` };
}

const LASTS = [
  { id: "1h", label: "1 h", seconds: 3600 },
  { id: "2h", label: "2 h", seconds: 7200 },
  { id: "4h", label: "4 h", seconds: 14400 },
  { id: "1d", label: "1 day", seconds: 86400 },
  { id: "until", label: "Until…", seconds: 0 },
] as const;
type LastsId = (typeof LASTS)[number]["id"];

type Field = "where" | "matchers" | "ends_at" | "comment";
const FIELDS: readonly Field[] = ["where", "matchers", "ends_at", "comment"];

/** The preview waits for a pause in typing. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const plural = (n: number) => `${n} alert${n === 1 ? "" : "s"}`;
export const previewWords = (p: SilencePreviewOut) =>
  `Silences ${plural(p.affects)} now${p.rules.length > 0 ? `: ${p.rules.join(", ")}` : ""}.`;

export function SilenceForm({ prefill, onDone, leaveRef }: { prefill?: SilencePrefill; onDone(): void; leaveRef?: LeaveRef }) {
  const ids = useId();
  const sources = useSources();
  const create = useCreateSilence();
  const matchersRef = useRef<HTMLInputElement>(null);
  const commentRef = useRef<HTMLInputElement>(null);
  const endsRef = useRef<HTMLSelectElement>(null);
  const untilRef = useRef<HTMLInputElement>(null);
  const whereRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  const [picked, setPicked] = useState<string | null>(null);
  const [matchers, setMatchers] = useState(prefill?.matchers ?? "");
  const [lasts, setLasts] = useState<LastsId>("1h");
  const [until, setUntil] = useState("");
  const [comment, setComment] = useState("");
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [focusField, setFocusField] = useState<Field | null>(null);
  const [saving, setSaving] = useState(false);

  // A tool's rule: the project's Alertmanager, once the channels say which it is.
  const wantsProjectAm = prefill?.where.kind === "alertmanager" && prefill.where.source_id === null;
  const channels = useChannels(wantsProjectAm ? (prefill?.projectId ?? null) : null);
  const defaultWhere = !prefill || prefill.where.kind === "omnikrux" ? "omnikrux"
    : prefill.where.source_id ?? channels.data?.alertmanager?.id ?? null;
  const whereKey = picked ?? defaultWhere;
  const blocked = picked === null && wantsProjectAm && prefill?.tool !== undefined && channels.data !== undefined
    && channels.data.alertmanager === null;
  const waiting = picked === null && wantsProjectAm && whereKey === null && !blocked;

  const managers = (sources.data ?? []).filter((x) => x.type === "alertmanager");
  const places = [
    { key: "omnikrux", label: "OmniKrux", hint: "for rules checked by OmniKrux" },
    ...managers.map((m) => ({ key: m.id, label: m.name, hint: "for rules that run in Prometheus or Loki" })),
  ];

  const matcherProblem = matchers.trim() === "" ? null : validFilter(matchers);
  const debounced = useDebounced(matchers.trim(), 350);
  const previewOn = whereKey === "omnikrux" && debounced !== "" && validFilter(debounced) === null;
  const preview = useQuery<SilencePreviewOut, AlertRequestError>({
    queryKey: [...alertsKeys.silences, "preview", debounced], enabled: previewOn, retry: false, refetchOnWindowFocus: false,
    queryFn: () => previewSilence({ where: { kind: "omnikrux" }, matchers: debounced, ends_at: new Date(Date.now() + 3_600_000).toISOString(), comment: "preview" }),
  });
  // A pattern the server refuses shows under the field while it is typed.
  const previewProblem = previewOn && matchers.trim() === debounced && preview.error
    && preview.error.code === "invalid_silence" && (preview.error.field === null || preview.error.field === "matchers") ? preview.error.message : null;

  const changed = matchers !== (prefill?.matchers ?? "") || comment !== "" || lasts !== "1h" || until !== "" || picked !== null;
  const guard = useLeaveGuard(leaveRef, changed, saving);

  useLayoutEffect(() => { (prefill ? commentRef : matchersRef).current?.focus({ preventScroll: true }); }, [prefill]);
  useLayoutEffect(() => {
    if (focusField === null) return;
    setFocusField(null);
    const target = { where: whereRef, matchers: matchersRef, ends_at: lasts === "until" ? untilRef : endsRef, comment: commentRef }[focusField].current;
    (target ?? saveRef.current)?.focus();
  }, [focusField, lasts]);

  const fail = (field: Field, text: string) => {
    setErrors({ [field]: text });
    setFocusField(field);
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (saving || blocked || waiting) return;
    setFormError(null);
    setErrors({});
    if (matchers.trim() === "") return fail("matchers", NEEDS_MATCHERS);
    if (matcherProblem) return fail("matchers", matcherProblem);
    if (previewProblem) return fail("matchers", previewProblem);
    let ends: Date;
    if (lasts === "until") {
      ends = new Date(until);
      if (until === "" || Number.isNaN(ends.getTime())) return fail("ends_at", NEEDS_UNTIL);
      if (ends.getTime() <= Date.now()) return fail("ends_at", UNTIL_PAST);
    } else {
      ends = new Date(Date.now() + (LASTS.find((l) => l.id === lasts)?.seconds ?? 3600) * 1000);
    }
    if (comment.trim() === "") return fail("comment", NEEDS_COMMENT);
    if (whereKey === null) return fail("where", "Pick where the silence holds.");
    const body: SilenceIn = {
      where: whereKey === "omnikrux" ? { kind: "omnikrux" } : { kind: "alertmanager", source_id: whereKey },
      matchers: matchers.trim(), ends_at: ends.toISOString(), comment: comment.trim(),
    };
    setSaving(true);
    try {
      await create.mutateAsync(body);
      setSaving(false);
      onDone();
    } catch (err) {
      setSaving(false);
      const refused = err as AlertRequestError;
      const field = FIELDS.find((f) => f === refused.field) ?? (refused.code === "invalid_silence" && /pattern/i.test(refused.message) ? "matchers" : null);
      if (refused.code === "invalid_silence" && field) fail(field, refused.message);
      else setFormError(failure(err, "try again"));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (pressed("confirmReview", e)) {
      e.preventDefault();
      if (!e.repeat) void submit();
      return;
    }
    if (e.key === "Escape" && !e.defaultPrevented && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      guard.request(onDone);
    }
  };

  const err = (f: Field) => errors[f] ?? null;
  const matchersError = err("matchers") ?? matcherProblem ?? previewProblem;
  return (
    <form className={s.form} aria-label="New silence" noValidate onSubmit={(e) => void submit(e)} onKeyDown={onKeyDown} data-silence-form="">
      <h2 className={s.formTitle}>New silence</h2>

      <fieldset className={s.field} aria-describedby={err("where") ? `${ids}-where-e` : undefined}>
        <legend className={s.label}>Where</legend>
        <div className={s.places}>
          {places.map((p, i) => (
            <label key={p.key} className={s.place}>
              <input ref={i === 0 ? whereRef : undefined} type="radio" name={`${ids}-where`} checked={whereKey === p.key}
                onChange={() => { setPicked(p.key); setErrors({}); }} />
              <span><strong>{p.label}</strong> <span className={s.hint}>— {p.hint}</span></span>
            </label>
          ))}
        </div>
        {err("where") && <p id={`${ids}-where-e`} className={s.fieldError}>{err("where")}</p>}
        {blocked && prefill?.tool && <p className={s.blocked} role="status" data-tone="warn">{noAlertmanager(prefill.tool)}</p>}
      </fieldset>

      <div className={s.field}>
        <label className={s.label} htmlFor={`${ids}-matchers`}>Matchers</label>
        <input id={`${ids}-matchers`} ref={matchersRef} className={s.input} type="text" autoComplete="off" spellCheck={false}
          placeholder={MATCHERS_PLACEHOLDER} value={matchers} aria-invalid={matchersError ? true : undefined}
          aria-describedby={matchersError ? `${ids}-matchers-e` : undefined}
          onChange={(e) => { setMatchers(e.target.value); if (errors.matchers) setErrors({}); }} />
        {matchersError && <p id={`${ids}-matchers-e`} className={s.fieldError}>{matchersError}</p>}
      </div>

      <div className={s.pair}>
        <div className={s.field}>
          <label className={s.label} htmlFor={`${ids}-lasts`}>Lasts</label>
          <select id={`${ids}-lasts`} ref={endsRef} className={s.input} value={lasts} aria-invalid={err("ends_at") && lasts !== "until" ? true : undefined}
            onChange={(e) => { setLasts(e.target.value as LastsId); setErrors({}); }}>
            {LASTS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
        {lasts === "until" && (
          <div className={s.field}>
            <label className={s.label} htmlFor={`${ids}-until`}>Ends at</label>
            <input id={`${ids}-until`} ref={untilRef} className={s.input} type="datetime-local" value={until}
              aria-invalid={err("ends_at") ? true : undefined} aria-describedby={err("ends_at") ? `${ids}-until-e` : undefined}
              onChange={(e) => { setUntil(e.target.value); setErrors({}); }} />
          </div>
        )}
      </div>
      {err("ends_at") && <p id={`${ids}-until-e`} className={s.fieldError}>{err("ends_at")}</p>}

      <div className={s.field}>
        <label className={s.label} htmlFor={`${ids}-comment`}>Comment</label>
        <input id={`${ids}-comment`} ref={commentRef} className={s.input} type="text" autoComplete="off" value={comment}
          aria-invalid={err("comment") ? true : undefined} aria-describedby={err("comment") ? `${ids}-comment-e` : undefined}
          onChange={(e) => { setComment(e.target.value); if (errors.comment) setErrors({}); }} />
        {err("comment") && <p id={`${ids}-comment-e`} className={s.fieldError}>{err("comment")}</p>}
      </div>

      <div aria-live="polite" className={s.preview}>
        {previewOn && preview.data && matchers.trim() === debounced && !previewProblem && <p>{previewWords(preview.data)}</p>}
      </div>

      {formError && <p className={s.formError} role="alert">{formError}</p>}
      <div className={s.actions}>
        <span className={s.keyHint} aria-hidden="true">Ctrl+Enter silences</span>
        <button type="button" className={s.secondary} aria-disabled={saving || undefined} onClick={() => guard.request(onDone)}>Cancel</button>
        <button ref={saveRef} type="submit" className={s.primary} aria-keyshortcuts="Control+Enter" aria-disabled={saving || blocked || waiting || undefined}>
          {saving ? "Silencing…" : "Silence"}
        </button>
      </div>
      {guard.asking && <DiscardDialog title={DISCARD_SILENCE} onKeep={guard.keep} onDiscard={guard.discard} />}
    </form>
  );
}
