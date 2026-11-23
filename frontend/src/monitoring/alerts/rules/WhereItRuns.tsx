// Where a rule runs: checked by OmniKrux (needs it running, works with any source), or in the tool
// that holds the data (Prometheus through a PrometheusRule, Loki through its ruler), which keeps
// firing when OmniKrux is off. Each project says what it can do; a project whose tool can't take
// the rule is checked by OmniKrux instead, and says why.

import { useId } from "react";
import type { CapabilityOut, Engine } from "../api";
import s from "./RuleForm.module.css";

export const OMNIKRUX_HELP = "Needs OmniKrux running. Works with any source.";

/** One project's line under "In the tool". */
export function capabilityWords(c: CapabilityOut): string {
  if (c.tool === "prometheus_rule") return `In Prometheus (${c.project_name}), fires even when OmniKrux is off`;
  if (c.tool === "loki_ruler") return `In Loki (${c.project_name}), fires even when OmniKrux is off`;
  return `${c.project_name}: checked by OmniKrux instead.${c.reason ? ` ${c.reason}` : ""}`;
}

export interface WhereItRunsProps {
  engine: Engine;
  capabilities: CapabilityOut[];
  onChange(engine: Engine): void;
  /** Said under "In the tool" while what the projects can do isn't known (being read, or failed). */
  waiting?: string | null;
}

export function WhereItRuns({ engine, capabilities, onChange, waiting }: WhereItRunsProps) {
  const id = useId();
  const able = capabilities.some((c) => c.tool !== null);
  const firstReason = capabilities.find((c) => c.reason)?.reason ?? null;
  const toolOff = !able;
  const name = `${id}-engine`;
  return (
    <fieldset className={s.where} role="radiogroup" aria-label="Where it runs">
      <legend className={s.sectionLabel}>Where it runs</legend>
      <div className={s.whereChoice} data-checked={engine === "omnikrux" || undefined}>
        <input id={`${id}-o`} type="radio" name={name} value="omnikrux" checked={engine === "omnikrux"} aria-describedby={`${id}-omnikrux`}
          onChange={() => onChange("omnikrux")} />
        <span className={s.whereText}>
          <label htmlFor={`${id}-o`} className={s.whereTitle}>Checked by OmniKrux</label>
          <span id={`${id}-omnikrux`} className={s.help}>{OMNIKRUX_HELP}</span>
        </span>
      </div>
      <div className={s.whereChoice} data-checked={engine === "tool" || undefined} data-disabled={toolOff || undefined}>
        <input id={`${id}-t`} type="radio" name={name} value="tool" checked={engine === "tool"} disabled={toolOff} aria-describedby={`${id}-tool`}
          onChange={() => onChange("tool")} />
        <span className={s.whereText}>
          <label htmlFor={`${id}-t`} className={s.whereTitle}>In the tool</label>
          <span id={`${id}-tool`} className={s.whereLines}>
            {waiting ? <span className={s.help}>{waiting}</span>
              : toolOff ? (firstReason && <span className={s.help}>{firstReason}</span>)
              : capabilities.map((c) => (
                <span key={c.project_id} className={c.tool ? s.whereChip : s.help}>{capabilityWords(c)}</span>
              ))}
          </span>
        </span>
      </div>
    </fieldset>
  );
}
