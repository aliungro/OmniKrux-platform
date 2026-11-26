// How often the rule as written would have fired over the last 6 hours, in a line under its
// sentence. Asked once typing stops; while a newer version waits for its answer the line says it is
// checking, never an older answer. A group's projects that couldn't be read are named with why, and
// then nothing is advised: a calmer threshold read from part of the data could be wrong.

import { useEffect, useRef } from "react";
import { failure } from "../../../api/http";
import type { DryRunIn, DryRunOut, Op } from "../api";
import { dryRunSentence, durationWords, numberText } from "../format";
import { parseDuration } from "../limits";
import { useRuleDryRun } from "./useRuleDryRun";
import s from "./RuleForm.module.css";

export const CHECKING = "Checking the last 6 hours…";
export const couldntCheckWords = (message: string) => `Couldn't check the last 6 hours: ${message}`;

/** A threshold in a few digits, as the advice says it (0.30000000000000004 reads 0.3). */
export const thresholdText = (n: number): string => numberText(Number(n.toPrecision(6)));

/**
 * The calmer threshold the dry run found: among its candidates that fired at most once, the one
 * closest to the current `threshold` on the calmer side (above: higher, below: lower). Without
 * `threshold`, every candidate counts as calmer (the server only suggests calmer ones). Never asks
 * the server itself.
 */
/** What the calmer threshold would have done: "wouldn't have fired" or "would have fired once". */
export const calmerWords = (fired: number) => (fired === 0 ? "wouldn't have fired" : "would have fired once");

export function calmerThreshold(out: DryRunOut, op: Op, threshold?: number): { threshold: number; fired: number } | null {
  const calm = out.candidates.filter((c) =>
    c.fired <= 1 && Number.isFinite(c.threshold) && (threshold === undefined || (op === "above" ? c.threshold > threshold : c.threshold < threshold)));
  if (calm.length === 0) return null;
  return calm.reduce((best, c) => ((op === "above" ? c.threshold < best.threshold : c.threshold > best.threshold) ? c : best));
}

/** The advice for `out`, when it fired often over complete data and a calmer threshold is quiet. */
export function adviceFor(out: DryRunOut, op: Op, threshold: number): { threshold: number; fired: number } | null {
  if (out.fired < 3 || out.projects.some((p) => p.error !== null)) return null;
  return calmerThreshold(out, op, threshold);
}

/** Said when the condition holds at the last point but its `for` hasn't passed: it isn't firing yet. */
export const holdsWords = (forText: string) => `Its condition holds now; it fires after ${durationWords(parseDuration(forText) ?? 0)}.`;

/** The line's words for a finished run. */
export function dryRunWords(out: DryRunOut, body: DryRunIn, now: number): string {
  const words = body.scope.kind !== "group" ? dryRunSentence(out, now)
    : dryRunSentence(out, now, undefined, out.projects.filter((p) => p.error === null).length);
  return out.holding_now && !out.firing_now ? `${words} ${holdsWords(body.for)}` : words;
}

export interface DryRunLineProps {
  body: DryRunIn | null;
  onAdvice?(threshold: number): void;
  /** The current answer, or null while there is none (checking, failed, nothing to check). */
  onResult?(out: DryRunOut | null): void;
  /** Show the calmer-threshold advice here (default); the Alert tab shows it in its bar instead. */
  advice?: boolean;
}

export function DryRunLine({ body, onAdvice, onResult, advice = true }: DryRunLineProps) {
  const state = useRuleDryRun(body);
  const out = state.kind === "done" ? state.out : null;
  const told = useRef<DryRunOut | null | undefined>(undefined);
  const report = useRef(onResult);
  report.current = onResult;
  useEffect(() => {
    if (told.current === out) return;
    told.current = out;
    report.current?.(out);
  }, [out]);

  if (body === null || state.kind === "idle") return null;
  let words: string;
  let tone: "warn" | undefined;
  if (state.kind === "checking") words = CHECKING;
  else if (state.kind === "failed") {
    words = couldntCheckWords(failure(state.error, "try again"));
    tone = "warn";
  } else words = dryRunWords(state.out, body, Date.now() / 1000);
  const failed = out?.projects.filter((p) => p.error !== null) ?? [];
  const tip = out && advice && body.suggest ? adviceFor(out, body.op, body.threshold) : null;

  return (
    <div className={s.dryRun} data-tone={tone}>
      <div role="status" aria-live="polite" className={s.dryRunText}>
        <p className={s.dryRunLine} data-checking={state.kind === "checking" || undefined}>{words}</p>
        {failed.length > 0 && (
          <ul className={s.dryRunProblems}>
            {failed.map((p) => <li key={p.project_id}>{p.project_name}: {p.error!.message}</li>)}
          </ul>
        )}
      </div>
      {tip && (
        <p className={s.advice}>
          <span>That's often. At {thresholdText(tip.threshold)} it {calmerWords(tip.fired)}.</span>
          {onAdvice && (
            <button type="button" className={s.adviceButton} onClick={() => onAdvice(tip.threshold)}>Use {thresholdText(tip.threshold)}</button>
          )}
        </p>
      )}
    </div>
  );
}
