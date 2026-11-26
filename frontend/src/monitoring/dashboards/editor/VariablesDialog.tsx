// The variables editor: one row per variable (name, label, where its values come from, which label,
// an optional selector, several values, All), then Add variable. Apply is one edit to the draft (one
// undo step); it is refused while a field is wrong, while a panel uses a variable this change removed or
// renamed (or breaks in some other way this change caused: problems the draft already had don't count),
// and while the JSON text doesn't apply. A changed variable keeps its starting value while its Several
// values and Offer All settings still allow it; a new one (or one that no longer allows it) starts at All
// when it offers All, else empty: starting values aren't edited here.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { DialogShell } from "../../../features/dock/ConfirmDialog";
import type { DashboardOwner } from "../runPanel";
import { MAX_VARIABLES, parseDashboardJson, type DashboardSpec, type OwnerKind, type VariableSpec } from "../schema";
import { sourceChoices } from "./QueryTab";
import s from "./VariablesDialog.module.css";

export const VARIABLES_EMPTY = "No variables yet. A variable adds a menu above the panels, filled with one label's values.";
export const PANELS_USE = (name: string) => `Panels use $${name}: change their queries before removing it.`;
export const PANELS_RENAME = (name: string) => `Panels use $${name}: change their queries before renaming it.`;

export interface VariableProblems {
  /** `"{index}.{field}"` (a problem on the row itself is `"{index}."`), first problem each. */
  fields: Map<string, string>;
  /** Problems about the list as a whole (too many variables). */
  list: string[];
  /** The variables a panel still uses but the list no longer has (or has after the panel). */
  panels: string[];
  /** Every problem found in a panel (`name` is the variable it names, if any). */
  panelIssues: { path: string; message: string; name: string | null }[];
}

const VARIABLE_PATH = /^variables\[(\d+)\](?:\.(\w+))?/;
const USES = /\$([A-Za-z_][A-Za-z0-9_]*)/;

/** What the dashboard would say about these variables, by running the same check as Save. */
export function variableProblems(draft: DashboardSpec, variables: VariableSpec[], ownerKind: OwnerKind): VariableProblems {
  const out: VariableProblems = { fields: new Map(), list: [], panels: [], panelIssues: [] };
  const checked = parseDashboardJson(JSON.stringify({ ...draft, variables }), ownerKind);
  if (checked.ok) return out;
  for (const p of checked.problems) {
    const row = VARIABLE_PATH.exec(p.path);
    if (row) {
      const key = `${row[1]}.${row[2] ?? ""}`;
      if (!out.fields.has(key)) out.fields.set(key, p.message);
    } else if (p.path === "variables") {
      out.list.push(p.message);
    } else if (p.path.startsWith("panels")) {
      const name = USES.exec(p.message)?.[1];
      out.panelIssues.push({ path: p.path, message: p.message, name: name ?? null });
      if (name !== undefined && !out.panels.includes(name)) out.panels.push(name);
    }
  }
  return out;
}

interface Row {
  key: number;
  /** The variable as it was when the dialog opened (its starting value is kept while it is unchanged). */
  was: VariableSpec | null;
  name: string;
  label: string;
  source: VariableSpec["source"];
  labelName: string;
  match: string;
  multi: boolean;
  includeAll: boolean;
}

const rowOf = (key: number, v: VariableSpec): Row => ({
  key, was: v, name: v.name, label: v.label, source: v.source, labelName: v.labelName, match: v.match, multi: v.multi, includeAll: v.includeAll,
});

const newRow = (key: number): Row => ({
  key, was: null, name: "", label: "", source: { type: "prometheus", id: null }, labelName: "", match: "", multi: false, includeAll: true,
});

function sameSource(a: VariableSpec["source"], b: VariableSpec["source"]) {
  return a.type === b.type && a.id === b.id;
}

/** The rows as variables: a blank label reads as the name; a variable keeps its starting value while its settings allow it, else (and when new) it starts at All or empty. */
function toVariables(rows: Row[]): VariableSpec[] {
  return rows.map((r) => {
    const w = r.was;
    // The starting value stays while the settings still allow it; a new variable, or one that no
    // longer allows it, starts at All (if it offers it) or empty.
    const keep = w !== null && !(w.default === "all" && !r.includeAll) && !(w.default !== "all" && w.default.length > 1 && !r.multi);
    return {
      name: r.name, label: r.label.trim() === "" ? r.name : r.label, type: "labelValues", source: r.source,
      labelName: r.labelName, match: r.match, multi: r.multi, includeAll: r.includeAll,
      default: keep ? w.default : r.includeAll ? "all" : [],
    };
  });
}

type Focus = { key: number; to: "up" | "down" | "name" } | "add" | null;

const TEXT_FIELDS = [["name", "Name"], ["label", "Label"], ["labelName", "Label name"], ["match", "Match"]] as const;

export function VariablesDialog({ draft, ownerKind, owner, onApply, onCancel, restoreFocusTo }: {
  draft: DashboardSpec;
  ownerKind: OwnerKind;
  /** Whose sources a variable may read from (null while a project is still loading). */
  owner: DashboardOwner | null;
  /** Makes the change; returns why it wasn't made (the JSON text doesn't apply), or null. */
  onApply(variables: VariableSpec[]): string | null;
  onCancel(): void;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const next = useRef(draft.variables.length);
  const [rows, setRows] = useState<Row[]>(() => draft.variables.map((v, i) => rowOf(i, v)));
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const [attempts, setAttempts] = useState(0);
  const [refused, setRefused] = useState<string | null>(null);
  const [focusAfter, setFocusAfter] = useState<Focus>(null);
  const body = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const problemsRef = useRef<HTMLDivElement>(null);

  const variables = useMemo(() => toVariables(rows), [rows]);
  const problems = useMemo(() => variableProblems(draft, variables, ownerKind), [draft, variables, ownerKind]);
  const shown = (index: number, field: string) => {
    const key = `${index}.${field}`;
    return attempts > 0 || touched.has(`${rows[index]?.key}.${field}`) ? problems.fields.get(key) : undefined;
  };
  const edit = (r: Row, field: string, patch: Partial<Row>) => {
    setTouched((t) => new Set(t).add(`${r.key}.${field}`));
    setRefused(null);
    setRows((all) => all.map((x) => (x.key === r.key ? { ...x, ...patch } : x)));
  };

  const add = () => {
    if (rows.length >= MAX_VARIABLES) return;
    const key = next.current++;
    setRows((all) => [...all, newRow(key)]);
    setFocusAfter({ key, to: "name" });
  };
  const remove = (i: number) => {
    const r = rows[i];
    const neighbour = rows[i + 1] ?? rows[i - 1];
    setRows((all) => all.filter((x) => x.key !== r.key));
    setRefused(null);
    setFocusAfter(neighbour ? { key: neighbour.key, to: "name" } : "add");
  };
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= rows.length) return;
    const r = rows[i];
    setRows((all) => {
      const copy = all.slice();
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
    setRefused(null);
    setFocusAfter({ key: r.key, to: by < 0 ? "up" : "down" });
  };

  // The keyboard follows what it was on: the moved row's button, the neighbour of a removed row, the new row's name.
  useLayoutEffect(() => {
    if (focusAfter === null) return;
    const root = body.current;
    setFocusAfter(null);
    if (!root) return;
    if (focusAfter === "add") return void root.querySelector<HTMLElement>("[data-add]")?.focus();
    const row = root.querySelector<HTMLElement>(`[data-row="${focusAfter.key}"]`);
    const target = focusAfter.to === "name" ? row?.querySelector<HTMLElement>("[data-field=name]")
      : row?.querySelector<HTMLElement>(`[data-act=${focusAfter.to}]`);
    (target ?? root.querySelector<HTMLElement>("[data-add]"))?.focus();
  }, [focusAfter]);

  // Only what this change brought about counts: a panel that already had a problem doesn't block it.
  const fresh = useMemo(() => {
    const had = new Set(variableProblems(draft, draft.variables, ownerKind).panelIssues.map((x) => `${x.path}|${x.message}`));
    const was = new Set(draft.variables.map((v) => v.name));
    const now = new Set(variables.map((v) => v.name));
    const renamed = new Set(rows.flatMap((r) => (r.was !== null && r.was.name !== r.name ? [r.was.name] : [])));
    const words = new Set<string>();
    for (const x of problems.panelIssues) {
      if (had.has(`${x.path}|${x.message}`)) continue;
      const gone = x.name !== null && was.has(x.name) && !now.has(x.name) && /isn't a variable/.test(x.message);
      words.add(gone ? (renamed.has(x.name!) ? PANELS_RENAME(x.name!) : PANELS_USE(x.name!)) : x.message);
    }
    return [...words];
  }, [draft, ownerKind, problems, rows, variables]);
  const broken = problems.fields.size > 0 || fresh.length > 0 || problems.list.length > 0;
  const apply = () => {
    if (broken) {
      setAttempts((n) => n + 1);
      return;
    }
    const why = onApply(variables);
    if (why !== null) setRefused(why);
  };
  // A refused Apply puts the keyboard on the first thing to fix.
  useEffect(() => {
    if (attempts === 0) return;
    (body.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? problemsRef.current)?.focus();
  }, [attempts]);

  const listProblems = attempts > 0 ? problems.list : [];

  return (
    <DialogShell provider="monitoring" role="dialog" busy={false} onCancel={onCancel} onConfirm={apply} first={first}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} className={s.dialog}>
      <h2 id={`${id}-t`} className={s.title}>Variables</h2>
      <div ref={body} className={s.body}>
        {(listProblems.length > 0 || fresh.length > 0) && (
          <div ref={problemsRef} tabIndex={-1} className={s.problems} role="alert">
            {listProblems.map((m) => <p key={m} className={s.problem}>{m}</p>)}
            {fresh.map((m) => <p key={m} className={s.problem}>{m}</p>)}
          </div>
        )}
        {rows.length === 0 && <p className={s.empty}>{VARIABLES_EMPTY}</p>}
        {rows.map((r, i) => {
          const choices = sourceChoices(owner, ownerKind, r.source);
          const value = choices.find((c) => sameSource(c.source, r.source))?.value ?? "";
          const rowMessage = shown(i, "");
          return (
            <div key={r.key} role="group" aria-label={`Variable ${i + 1}${r.name ? `: ${r.name}` : ""}`} data-row={r.key} className={s.row}>
              <div className={s.fields}>
                {TEXT_FIELDS.map(([field, label]) => {
                  const message = shown(i, field);
                  const fid = `${id}-${r.key}-${field}`;
                  return (
                    <div key={field} className={`${s.field} ${field === "match" ? s.wide : ""}`}>
                      <label htmlFor={fid} className={s.fieldLabel}>{label}</label>
                      <input id={fid} data-field={field} className={s.input} value={r[field]} spellCheck={false} autoComplete="off"
                        placeholder={field === "match"
                          ? (r.source.type === "loki" ? 'Optional, like {namespace="$namespace"}' : 'Optional, like kube_pod_info{namespace="$namespace"}')
                          : field === "label" ? r.name : undefined}
                        aria-invalid={message ? true : undefined} aria-describedby={message ? `${fid}-p` : undefined}
                        onChange={(e) => edit(r, field, { [field]: e.target.value })} />
                      {message && <p id={`${fid}-p`} className={s.problem}>{message}</p>}
                    </div>
                  );
                })}
                <div className={s.field}>
                  <label htmlFor={`${id}-${r.key}-source`} className={s.fieldLabel}>Source</label>
                  <select id={`${id}-${r.key}-source`} className={s.input} value={value} aria-invalid={shown(i, "source") ? true : undefined}
                    aria-describedby={shown(i, "source") ? `${id}-${r.key}-source-p` : undefined}
                    onChange={(e) => {
                      const c = choices.find((x) => x.value === e.target.value);
                      if (c) edit(r, "source", { source: c.source });
                    }}>
                    {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  {shown(i, "source") && <p id={`${id}-${r.key}-source-p`} className={s.problem}>{shown(i, "source")}</p>}
                </div>
              </div>
              {rowMessage && <p className={s.problem}>{rowMessage}</p>}
              <div className={s.rowActions}>
                <label className={s.check}>
                  <input type="checkbox" checked={r.multi} onChange={(e) => edit(r, "multi", { multi: e.target.checked })} />
                  <span>Several values</span>
                </label>
                <label className={s.check}>
                  <input type="checkbox" checked={r.includeAll} onChange={(e) => edit(r, "includeAll", { includeAll: e.target.checked })} />
                  <span>Offer All</span>
                </label>
                <span className={s.spacer} />
                <button type="button" data-act="up" className={s.small} aria-disabled={i === 0 || undefined} onClick={() => move(i, -1)}>Move up</button>
                <button type="button" data-act="down" className={s.small} aria-disabled={i === rows.length - 1 || undefined} onClick={() => move(i, 1)}>Move down</button>
                <button type="button" className={`${s.small} ${s.removeButton}`} onClick={() => remove(i)}>Remove</button>
              </div>
            </div>
          );
        })}
        <button ref={first} type="button" data-add="" className={s.add} aria-disabled={rows.length >= MAX_VARIABLES || undefined} onClick={add}>
          Add variable
        </button>
        {rows.length >= MAX_VARIABLES && <p className={s.note}>A dashboard has at most {MAX_VARIABLES} variables.</p>}
      </div>
      {refused && <p className={s.refused} role="alert">{refused}</p>}
      <div className={s.actions}>
        <button type="button" className={s.secondary} onClick={onCancel}>Cancel</button>
        <button type="button" className={s.primary} aria-disabled={(broken && attempts > 0) || undefined} onClick={apply}>Apply</button>
      </div>
    </DialogShell>
  );
}
