import { useId } from "react";
import type { FilterOrigin } from "../api/types";
import s from "./FilterField.module.css";

// The server's words for a filter it can't read (`parse_matchers` in `monitoring/query/filters.py`).
export const BAD_FILTER = 'Use label matchers like cluster="prod-east", separated by commas.';
export const NO_METRIC_NAME = "A filter can't select by metric name.";

const LABEL = /[A-Za-z_][A-Za-z0-9_]*/y;
const OPS = ["=~", "!~", "!=", "="] as const; // longest first, so "=~" is never read as "=" and "~"
const ESCAPES = new Set(["\\", '"', "n"]);

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

/** The index just past the double-quoted value at `text[i]`, or -1 when it isn't one. */
function pastValue(text: string, i: number): number {
  if (text[i] !== '"') return -1;
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === '"') return j + 1;
    if (text[j] === "\\") {
      if (!ESCAPES.has(text[j + 1])) return -1;
      j += 1;
    }
  }
  return -1;
}

/**
 * Whether the server will read this filter: `label op "value"` matchers separated by commas,
 * optionally inside `{ }`; empty means no filter. Returns the server's words for the problem, or
 * `null`. A port of `parse_matchers`; keep the two in step.
 */
export function validFilter(text: string): string | null {
  let body = text.trim();
  if (body.startsWith("{") && body.endsWith("}")) body = body.slice(1, -1);
  let i = skipSpace(body, 0);
  if (i === body.length) return null;
  for (;;) {
    LABEL.lastIndex = i;
    const label = LABEL.exec(body);
    if (label === null) return BAD_FILTER;
    if (label[0] === "__name__") return NO_METRIC_NAME;
    i = skipSpace(body, LABEL.lastIndex);
    const op = OPS.find((o) => body.startsWith(o, i));
    if (op === undefined) return BAD_FILTER;
    i = pastValue(body, skipSpace(body, i + op.length));
    if (i < 0) return BAD_FILTER;
    i = skipSpace(body, i);
    if (i === body.length) return null;
    if (body[i] !== ",") return BAD_FILTER;
    i = skipSpace(body, i + 1);
  }
}

export interface FilterFieldProps {
  value: string;
  origin: FilterOrigin;
  /** Why OmniKrux suggested this filter (or none), shown as help. */
  reason: string | null;
  onChange(value: string, origin: FilterOrigin): void;
  /** What the filter applies to, for the field's accessible name: "Filter for <forName>". */
  forName?: string;
}

/** A link's label filter: filled in by OmniKrux where it can tell, always editable. */
export function FilterField({ value, origin, reason, onChange, forName }: FilterFieldProps) {
  const id = useId();
  const problem = validFilter(value);
  const described = [problem ? `${id}-e` : null, reason ? `${id}-r` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={s.field} data-origin={origin}>
      <label htmlFor={id} className={s.label}>Filter</label>
      <input
        id={id}
        className={s.input}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder='No filter · label="value", …'
        aria-label={forName ? `Filter for ${forName}` : undefined}
        aria-invalid={problem ? true : undefined}
        aria-describedby={described}
        value={value}
        onChange={(e) => onChange(e.target.value, "user")}
      />
      {problem && <span id={`${id}-e`} className={s.error}>{problem}</span>}
      {reason && <span id={`${id}-r`} className={s.reason}>{reason}</span>}
    </div>
  );
}
