// The condition of a rule as one sentence with its blanks filled in place: "Alert when [any route]
// is [above] [0.3] s for [5 min]", and under it "Checked every [1 min]". The group is named by the
// whole sentence, so a screen reader hears what the rule says before its parts. The Alerts page's
// rule form and a panel's Alert tab both use it.

import { useEffect, useId, useState, type KeyboardEvent, type Ref } from "react";
import type { PanelAlert, Unit } from "../../dashboards/schema";
import { durationWords, sentence, unitSuffix } from "../format";
import { parseDuration } from "../limits";
import s from "./RuleForm.module.css";

export type SentenceValue = Pick<PanelAlert, "of" | "op" | "threshold" | "for" | "every">;

export const FOR_CHOICES: readonly (readonly [string, string])[] = [
  ["0s", "right away"], ["1m", "1 min"], ["2m", "2 min"], ["5m", "5 min"], ["10m", "10 min"], ["15m", "15 min"], ["30m", "30 min"], ["1h", "1 h"],
];
export const EVERY_CHOICES: readonly (readonly [PanelAlert["every"], string])[] = [["30s", "30 s"], ["1m", "1 min"], ["5m", "5 min"]];
export const USE_A_NUMBER = "Use a number.";

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** The number typed, or null when it isn't a finite one. */
export function parseThreshold(text: string): number | null {
  const t = text.trim();
  if (!NUMBER.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The series word of a query: its first `by (label)`, else `series`. */
export function seriesWordOf(expr: string): string {
  return /\bby\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(expr)?.[1] ?? "series";
}

export interface RuleSentenceProps {
  value: SentenceValue;
  seriesWord: string;
  unit: Unit;
  onChange(next: SentenceValue): void;
  idPrefix: string;
  /** A refusal from the server about the threshold or the wait, shown under the sentence. */
  errors?: { threshold?: string | null; for?: string | null };
  thresholdRef?: Ref<HTMLInputElement>;
  forRef?: Ref<HTMLSelectElement>;
  /** Whether the threshold as typed is a number (the value keeps the last one that was). */
  onValidity?(ok: boolean): void;
}

export function RuleSentence({ value, seriesWord, unit, onChange, idPrefix, errors, thresholdRef, forRef, onValidity }: RuleSentenceProps) {
  const local = useId();
  const id = `${idPrefix}${local}`;
  const [text, setText] = useState(() => String(value.threshold));
  const [bad, setBadState] = useState(false);
  const setBad = (next: boolean) => {
    setBadState(next);
    onValidity?.(!next);
  };
  // A threshold set from outside (Use 0.5) replaces what was typed; what was typed stays otherwise.
  useEffect(() => {
    if (parseThreshold(text) !== value.threshold) {
      setText(String(value.threshold));
      setBad(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.threshold]);

  const set = (patch: Partial<SentenceValue>) => onChange({ ...value, ...patch });
  const typed = (next: string) => {
    setText(next);
    const n = parseThreshold(next);
    setBad(n === null);
    if (n !== null && n !== value.threshold) set({ threshold: n });
  };

  const opKeys = (e: KeyboardEvent<HTMLElement>) => {
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowUp"
      ? (value.op === "above" ? "below" : "above")
      : e.key === "Home" ? "above" : e.key === "End" ? "below" : null;
    if (next === null) return;
    e.preventDefault();
    set({ op: next });
    (e.currentTarget.querySelector(`[data-op="${next}"]`) as HTMLElement | null)?.focus();
  };

  const forSeconds = parseDuration(value.for);
  const forChoice = FOR_CHOICES.find(([v]) => parseDuration(v) === forSeconds);
  const forValue = forChoice ? forChoice[0] : value.for;
  const extraFor = forChoice ? null : [value.for, forSeconds === null ? value.for : durationWords(forSeconds)] as const;
  const suffix = unitSuffix(unit).trim();
  const thresholdError = bad ? USE_A_NUMBER : errors?.threshold ?? null;
  const forError = errors?.for ?? null;

  return (
    <div className={s.sentence} role="group" aria-label={`${sentence(value, { seriesWord, unit })}, checked every ${EVERY_CHOICES.find(([v]) => v === value.every)?.[1] ?? value.every}`}>
      <p className={s.sentenceLine}>
        <span className={s.sentenceWord}>Alert when</span>
        <select className={s.blank} aria-label="Which series" value={value.of} onChange={(e) => set({ of: e.target.value as SentenceValue["of"] })}>
          <option value="each">any {seriesWord}</option>
          <option value="total">the total</option>
        </select>
        <span className={s.sentenceWord}>is</span>
        <span role="radiogroup" aria-label="Above or below" className={s.toggle} onKeyDown={opKeys}>
          {(["above", "below"] as const).map((op) => (
            <button key={op} type="button" role="radio" aria-checked={value.op === op} tabIndex={value.op === op ? 0 : -1}
              data-op={op} className={s.toggleOption} onClick={() => set({ op })}>
              {op}
            </button>
          ))}
        </span>
        <span className={s.thresholdBox} data-invalid={thresholdError ? true : undefined}>
          <input ref={thresholdRef} className={s.thresholdInput} type="text" inputMode="decimal" autoComplete="off" spellCheck={false}
            aria-label="Threshold" aria-invalid={thresholdError ? true : undefined}
            aria-describedby={thresholdError ? `${id}-threshold` : undefined}
            size={Math.max(3, Math.min(14, text.length + 1))} value={text} onChange={(e) => typed(e.target.value)}
            onBlur={() => { if (!bad) setText(String(value.threshold)); }} />
          {suffix && <span className={s.unit} aria-hidden="true">{suffix}</span>}
        </span>
        {forValue !== "0s" && <span className={s.sentenceWord}>for</span>}
        <select ref={forRef} className={s.blank} aria-label="For how long" value={forValue}
          aria-invalid={forError ? true : undefined} aria-describedby={forError ? `${id}-for` : undefined}
          onChange={(e) => set({ for: e.target.value })}>
          {FOR_CHOICES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          {extraFor && <option value={extraFor[0]}>{extraFor[1]}</option>}
        </select>
      </p>
      <p className={s.sentenceLine}>
        <span className={s.sentenceWord}>Checked every</span>
        <select className={s.blank} aria-label="How often to check" value={value.every}
          onChange={(e) => set({ every: e.target.value as SentenceValue["every"] })}>
          {EVERY_CHOICES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </p>
      {thresholdError && <p id={`${id}-threshold`} className={s.fieldError}>{thresholdError}</p>}
      {forError && <p id={`${id}-for`} className={s.fieldError}>{forError}</p>}
    </div>
  );
}
