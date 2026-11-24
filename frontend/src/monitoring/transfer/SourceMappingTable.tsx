// Which source each data source of the imported dashboards reads here: the project's first source
// of its type, one of the sources the project links, or none (its panels are left out). Only
// sources the project links are offered; nothing is ever made from the file. In a group each
// project reads its own source, so a group has no table. Reused by setup and Update from source.
import { useId } from "react";
import type { ProjectOut } from "../api/types";
import type { OwnerKind } from "../dashboards/schema";
import { sourceTypeLabel } from "../sources/sourceLabels";
import type { MappingIn, SourceRefOut } from "./api";
import { GROUP_LINE } from "./importModel";
import s from "./ImportReview.module.css";

export interface SourceMappingTableProps {
  refs: SourceRefOut[];
  project: ProjectOut | null;
  ownerKind: OwnerKind | null;
  value: Record<string, MappingIn>;
  onChange(key: string, m: MappingIn): void;
  /** A refusal about one source, by its key, shown under its select. */
  errors?: Record<string, string>;
  /** Each select by its key, for the page to put the keyboard on. */
  selectRef?(key: string, el: HTMLSelectElement | null): void;
}

const LEAVE = "leave";
const FIRST = "first";

function valueOf(m: MappingIn | undefined): string {
  if (!m) return FIRST;
  if (m.leave_out) return LEAVE;
  return m.source_id ? `src:${m.source_id}` : FIRST;
}

function mappingOf(key: string, value: string): MappingIn {
  if (value === LEAVE) return { key, leave_out: true };
  if (value.startsWith("src:")) return { key, source_id: value.slice(4) };
  return { key, source_id: null };
}

export function SourceMappingTable({ refs, project, ownerKind, value, onChange, errors = {}, selectRef }: SourceMappingTableProps) {
  const ids = useId();
  if (ownerKind === "group") return <p className={s.line}>{GROUP_LINE}</p>;
  return (
    <table className={s.mapping}>
      <thead>
        <tr>
          <th scope="col">In the file</th>
          <th scope="col">Uses here</th>
        </tr>
      </thead>
      <tbody>
        {refs.map((r, i) => {
          const label = sourceTypeLabel(r.type);
          const linked = (project?.links ?? []).filter((l) => l.source_type === r.type);
          const current = valueOf(value[r.key]);
          const suggested = valueOf(r.leave_out ? { key: r.key, leave_out: true } : { key: r.key, source_id: r.suggestion });
          const stale = current.startsWith("src:") && !linked.some((l) => `src:${l.source_id}` === current);
          const error = errors[r.key];
          const hint = `${ids}-${i}`;
          return (
            <tr key={r.key}>
              <td>
                <span className={s.refName}>{r.name} ({label})</span>
                {r.type_guessed && <span className={s.refNote}>type guessed from its queries</span>}
                {r.detail && <span className={s.refDetail}>{r.detail}</span>}
              </td>
              <td>
                {project === null ? (
                  <span className={s.refNote}>{r.reason}</span>
                ) : (
                  <>
                    <select ref={(el) => selectRef?.(r.key, el)} className={s.select} aria-label={`Source for ${r.name}`}
                      aria-invalid={error ? true : undefined} aria-describedby={error || current === suggested ? hint : undefined}
                      value={current} onChange={(e) => onChange(r.key, mappingOf(r.key, e.target.value))}>
                      <option value={FIRST}>{linked.length > 0 ? `First ${label} source (${linked[0].source_name})` : `No ${label} source yet`}</option>
                      {linked.map((l) => <option key={l.source_id} value={`src:${l.source_id}`}>{l.source_name}</option>)}
                      {stale && <option value={current}>{current.slice(4)}</option>}
                      <option value={LEAVE}>Leave its panels out</option>
                    </select>
                    {error ? <span id={hint} className={s.fieldError}>{error}</span>
                      : current === suggested && <span id={hint} className={s.refNote}>{r.reason}</span>}
                  </>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
