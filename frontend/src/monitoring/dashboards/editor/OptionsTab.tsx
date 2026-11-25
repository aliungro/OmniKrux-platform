// The Options tab: title, description, unit, decimals, min and max, thresholds and legend. Also
// the option rows the Chart tab uses. Number fields take only finite numbers: anything else says
// so and leaves the draft as it was.
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { pressed } from "../../../features/chrome/shortcuts";
import { MAX_THRESHOLDS, type PanelSpec, type Threshold, type ThresholdColor, type Unit } from "../schema";
import type { PanelUpdate } from "./SidePanel";
import s from "./SidePanel.module.css";

export const NUMBER_PROBLEM = "Use a number.";

const UNIT_LABELS: readonly [Unit, string][] = [
  ["none", "None"], ["short", "Number (short)"], ["percent", "Percent (0–100)"], ["percentunit", "Percent (0–1)"],
  ["s", "Seconds"], ["ms", "Milliseconds"], ["bytes", "Bytes"], ["Bps", "Bytes per second"], ["reqps", "Requests per second"],
  ["cores", "CPU cores"],
];
const COLOR_LABELS: readonly [ThresholdColor, string][] = [["ok", "Good"], ["warn", "Warning"], ["bad", "Bad"]];
const DECIMALS = [0, 1, 2, 3, 4, 5, 6];

// --- rows ---------------------------------------------------------------------------------------

/** One option: its name on the left, its control on the right, a problem under both. */
export function Row({ label, htmlFor, children, problem, problemId }: {
  label: string; htmlFor: string; children: ReactNode; problem?: string | null; problemId?: string;
}) {
  return (
    <div className={s.row}>
      <label className={s.rowLabel} htmlFor={htmlFor}>{label}</label>
      <div className={s.rowControl}>{children}</div>
      {problem && <p id={problemId} className={s.problem}>{problem}</p>}
    </div>
  );
}

export function SelectRow<T extends string>({ label, value, choices, onChange }: {
  label: string; value: T; choices: readonly (readonly [T, string])[]; onChange(value: T): void;
}) {
  const id = useId();
  return (
    <Row label={label} htmlFor={id}>
      <select id={id} className={s.select} value={value} title={choices.find(([v]) => v === value)?.[1]}
        onChange={(e) => onChange(e.target.value as T)}>
        {choices.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </Row>
  );
}

export function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange(checked: boolean): void }) {
  return (
    <div className={s.row}>
      <label className={s.check}>
        <input type="checkbox" className={s.box} checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
    </div>
  );
}

const shown = (n: number | null) => (n === null ? "" : String(n));

/**
 * A number in a text box (so what was typed stays visible while it isn't a number). Each finite
 * number goes into the draft as it is typed; anything else says `Use a number.` and changes nothing.
 * Empty means null where that is allowed (Auto).
 */
export function useNumberText(value: number | null, onValue: (n: number | null) => void, opts: {
  allowEmpty: boolean; whole?: readonly [number, number];
}) {
  const [text, setText] = useState(shown(value));
  const [problem, setProblem] = useState<string | null>(null);
  // The draft changed elsewhere (JSON, another row removed): show its value.
  const [was, setWas] = useState(value);
  if (was !== value) {
    setWas(value);
    const typed = text.trim() === "" ? null : Number(text.trim());
    if (typed !== value) { setText(shown(value)); setProblem(null); }
  }
  const onText = (next: string) => {
    setText(next);
    const t = next.trim();
    if (t === "") {
      if (opts.allowEmpty) { setProblem(null); onValue(null); } else setProblem(NUMBER_PROBLEM);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) { setProblem(NUMBER_PROBLEM); return; }
    if (opts.whole && (!Number.isInteger(n) || n < opts.whole[0] || n > opts.whole[1])) {
      setProblem(`Use a whole number from ${opts.whole[0]} to ${opts.whole[1]}.`);
      return;
    }
    setProblem(null);
    onValue(n === 0 ? 0 : n);
  };
  return { text, problem, onText };
}

export function NumberRow({ label, value, onValue, allowEmpty = false, placeholder, whole, onRunNow }: {
  label: string; value: number | null; onValue(n: number | null): void; allowEmpty?: boolean; placeholder?: string;
  whole?: readonly [number, number];
  /** Ctrl+Enter here runs the panel now (a field that is part of its request). */
  onRunNow?(): void;
}) {
  const id = useId();
  const field = useNumberText(value, onValue, { allowEmpty, whole });
  return (
    <Row label={label} htmlFor={id} problem={field.problem} problemId={`${id}-problem`}>
      <input id={id} type="text" inputMode="decimal" autoComplete="off" className={s.input} value={field.text}
        placeholder={placeholder} aria-invalid={field.problem ? true : undefined}
        aria-describedby={field.problem ? `${id}-problem` : undefined} onChange={(e) => field.onText(e.target.value)}
        aria-keyshortcuts={onRunNow ? "Control+Enter" : undefined}
        onKeyDown={onRunNow ? (e) => { if (pressed("queryRun", e)) { e.preventDefault(); onRunNow(); } } : undefined} />
    </Row>
  );
}

// --- the tab ------------------------------------------------------------------------------------

/** Typed access to the options every panel type except logs shares. */
type Common = { unit: Unit; decimals: number | null; thresholds: Threshold[] };
type Bounds = { min: number | null; max?: number | null };

const withOptions = (p: PanelSpec, patch: Record<string, unknown>): PanelSpec => ({ ...p, options: { ...p.options, ...patch } } as PanelSpec);

export function OptionsTab({ panel, update }: { panel: PanelSpec; update: PanelUpdate }) {
  const titleId = useId();
  const aboutId = useId();
  const set = (patch: Record<string, unknown>) => update((p) => withOptions(p, patch));
  const common = panel.type === "logs" ? null : (panel.options as Common);
  const bounds = panel.type === "timeseries" || panel.type === "gauge" || panel.type === "bar" ? (panel.options as Bounds) : null;
  const legend = panel.type === "timeseries" || panel.type === "bar" ? panel.options.legend : null;

  return (
    <div className={s.rows}>
      <div className={s.field}>
        <label className={s.fieldLabel} htmlFor={titleId}>Title</label>
        <input id={titleId} type="text" className={s.text} maxLength={120} value={panel.title}
          onChange={(e) => { const title = e.target.value; update((p) => ({ ...p, title })); }} />
      </div>
      <div className={s.field}>
        <label className={s.fieldLabel} htmlFor={aboutId}>Description</label>
        <textarea id={aboutId} className={s.text} rows={2} maxLength={2000} value={panel.description}
          onChange={(e) => { const description = e.target.value; update((p) => ({ ...p, description })); }} />
      </div>
      {common && (
        <>
          <SelectRow label="Unit" value={common.unit} choices={UNIT_LABELS} onChange={(unit) => set({ unit })} />
          <SelectRow label="Decimals" value={common.decimals === null ? "auto" : String(common.decimals)}
            choices={[["auto", "Auto"], ...DECIMALS.map((d) => [String(d), String(d)] as const)]}
            onChange={(v) => set({ decimals: v === "auto" ? null : Number(v) })} />
        </>
      )}
      {bounds && (
        <>
          <NumberRow label="Min" value={bounds.min} allowEmpty placeholder="Auto" onValue={(min) => set({ min })} />
          {"max" in bounds && (
            <NumberRow label="Max" value={bounds.max ?? null} allowEmpty placeholder="Auto" onValue={(max) => set({ max })} />
          )}
        </>
      )}
      {common && <Thresholds thresholds={common.thresholds} onChange={(thresholds) => set({ thresholds })} />}
      {legend !== null && (
        <SelectRow label="Legend" value={legend} choices={[["bottom", "Show below"], ["hidden", "Hide"]] as const}
          onChange={(v) => set({ legend: v })} />
      )}
    </div>
  );
}

// --- thresholds ---------------------------------------------------------------------------------

let rowSeq = 0;

function Thresholds({ thresholds, onChange }: { thresholds: Threshold[]; onChange(next: Threshold[]): void }) {
  // Rows keep their fields (and what was typed) while others are added or removed.
  const keys = useRef<number[]>([]);
  if (keys.current.length !== thresholds.length) keys.current = thresholds.map(() => ++rowSeq);
  const addButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** After the next render: a row index whose value field takes the keyboard, or the Add button. */
  const focusNext = useRef<number | "add" | null>(null);

  useLayoutEffect(() => {
    const want = focusNext.current;
    if (want === null) return;
    focusNext.current = null;
    if (want === "add") addButton.current?.focus();
    else list.current?.querySelectorAll<HTMLInputElement>("[data-threshold-value]")[want]?.focus();
  });

  const add = () => {
    const last = thresholds.at(-1);
    keys.current = [...keys.current, ++rowSeq];
    focusNext.current = thresholds.length;
    onChange([...thresholds, last ? { value: last.value + 10, color: "bad" } : { value: 80, color: "warn" }]);
  };
  const remove = (i: number) => {
    keys.current = keys.current.filter((_, j) => j !== i);
    const left = thresholds.length - 1;
    focusNext.current = left === 0 ? "add" : Math.min(i, left - 1);
    onChange(thresholds.filter((_, j) => j !== i));
  };
  const change = (i: number, patch: Partial<Threshold>) => onChange(thresholds.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  return (
    <div className={s.group}>
      <span className={s.fieldLabel}>Thresholds</span>
      <div ref={list} className={s.thresholds}>
        {thresholds.map((t, i) => (
          <ThresholdRow key={keys.current[i]} n={i + 1} threshold={t} onChange={(patch) => change(i, patch)} onRemove={() => remove(i)} />
        ))}
      </div>
      {thresholds.length < MAX_THRESHOLDS && (
        <button ref={addButton} type="button" className={s.add} onClick={add}>+ Add threshold</button>
      )}
    </div>
  );
}

function ThresholdRow({ n, threshold, onChange, onRemove }: {
  n: number; threshold: Threshold; onChange(patch: Partial<Threshold>): void; onRemove(): void;
}) {
  const id = useId();
  const field = useNumberText(threshold.value, (value) => { if (value !== null) onChange({ value }); }, { allowEmpty: false });
  return (
    <div className={s.threshold} data-color={threshold.color}>
      <span className={s.swatch} aria-hidden="true" />
      <input type="text" inputMode="decimal" autoComplete="off" className={s.input} data-threshold-value=""
        aria-label={`Threshold ${n} value`} value={field.text} aria-invalid={field.problem ? true : undefined}
        aria-describedby={field.problem ? `${id}-problem` : undefined} onChange={(e) => field.onText(e.target.value)} />
      <select className={s.select} aria-label={`Threshold ${n} colour`} value={threshold.color}
        title={COLOR_LABELS.find(([v]) => v === threshold.color)?.[1]}
        onChange={(e) => onChange({ color: e.target.value as ThresholdColor })}>
        {COLOR_LABELS.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
      <button type="button" className={s.remove} aria-label={`Remove threshold ${n}`} onClick={onRemove}>Remove</button>
      {field.problem && <p id={`${id}-problem`} className={s.problem}>{field.problem}</p>}
    </div>
  );
}
