// The variables bar: on a group, Projects first; then each variable as a button with its
// selection, opening its values (radios, or checkboxes when several may be chosen).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { escapeCloses } from "../../focus";
import type { VarValue } from "../interpolate";
import { closesOnLeave, POPUP, useCloseOutside } from "./popover";
import type { ProjectRef, VariableErrorKind, VariableState } from "./useDashboardContext";
import s from "./DashboardPage.module.css";

const FILTER_FROM = 10;

/** `All`, the single value, or `{first} + {n}`. */
export function summary(value: VarValue, nameOf: (v: string) => string = (v) => v): string {
  if (value === "all") return "All";
  if (value.length === 0) return "None";
  if (value.length === 1) return nameOf(value[0]);
  return `${nameOf(value[0])} + ${value.length - 1}`;
}

interface PickerProps {
  label: string;
  /** Shown on the button while the values load (a single-value variable has no choice yet). */
  pending: boolean;
  values: { value: string; name: string }[];
  selected: VarValue;
  missing: string[];
  multi: boolean;
  includeAll: boolean;
  /** Projects: "All" also shows each project checked. */
  allChecksEach: boolean;
  loading: boolean;
  error: string | null;
  /** Only a failed read offers Try again; a selector or source problem says what to fix. */
  errorKind?: VariableErrorKind | null;
  /** The project whose page links the missing source. */
  fix?: ProjectRef | null;
  onRetry?(): void;
  onFix?(project: ProjectRef, e: MouseEvent<HTMLAnchorElement>): void;
  onChange(value: VarValue): void;
}

function Picker({
  label, pending, values, selected, missing, multi, includeAll, allChecksEach, loading, error, errorKind, fix, onRetry, onFix, onChange,
}: PickerProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const close = useCallback((restore: boolean) => {
    setOpen(false);
    if (restore) button.current?.focus();
  }, []);
  const closeQuietly = useCallback(() => close(false), [close]);
  useCloseOutside(open, root, closeQuietly);
  useEffect(() => {
    if (!open) return;
    setFilter("");
    // The filter (when there is one) first, else the chosen value. Never scrolls the page.
    const first = popup.current?.querySelector<HTMLElement>("[data-values-filter]")
      ?? popup.current?.querySelector<HTMLElement>("input:checked")
      ?? popup.current?.querySelector<HTMLElement>("input, button");
    first?.focus({ preventScroll: true });
    // Only when it opens.
  }, [open]);
  // Try again took the keyboard with it when its message went away (the values came): it goes
  // to the first choice, or the popup itself, never to <body>.
  const retried = useRef(false);
  useLayoutEffect(() => {
    if (!open || !retried.current) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    retried.current = false;
    (popup.current?.querySelector<HTMLElement>("input") ?? popup.current)?.focus();
  });

  const nameOf = useMemo(() => {
    const names = new Map(values.map((v) => [v.value, v.name]));
    return (v: string) => names.get(v) ?? v;
  }, [values]);
  const chosen = selected === "all" ? [] : selected;
  const isOn = (v: string) => (selected === "all" ? allChecksEach : chosen.includes(v));
  const shown = filter.trim() === "" ? values : values.filter((v) => v.name.toLowerCase().includes(filter.trim().toLowerCase()));

  const toggle = (v: string) => {
    if (!multi) {
      onChange([v]);
      close(true);
      return;
    }
    const current = selected === "all" ? (allChecksEach ? values.map((x) => x.value) : []) : chosen;
    const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
    // Never nothing: the last one stays (or, where allowed, it becomes All).
    if (next.length === 0) { if (includeAll) onChange("all"); return; }
    onChange(allChecksEach && next.length === values.length ? "all" : next);
  };
  const toggleAll = () => {
    if (selected !== "all") { onChange("all"); if (!multi) close(true); return; }
    // Unchecking All picks the first value: something is always chosen.
    if (multi && values.length > 0 && !allChecksEach) onChange([values[0].value]);
  };

  const type = multi ? "checkbox" : "radio";
  const groupName = `${id}-choice`;
  // Nothing chosen and nothing to choose from: say it failed, never "None".
  const text = pending ? "…" : error && selected !== "all" && selected.length === 0 ? "couldn't load" : summary(selected, nameOf);
  return (
    <div ref={root} className={s.popAnchor}>
      <button ref={button} type="button" className={s.varButton} aria-expanded={open} aria-controls={open ? `${id}-values` : undefined}
        onClick={() => (open ? close(true) : setOpen(true))}>
        <span className={s.varName}>{label}:</span> <b className={s.varValue}>{text}</b>
        {missing.length > 0 && <span className={s.varMissing} aria-hidden="true">!</span>}
        <span className={s.caret} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div {...POPUP} ref={popup} id={`${id}-values`} role="group" aria-label={label} tabIndex={-1} className={`${s.popup} ${s.values}`}
          onKeyDown={escapeCloses(() => close(true))} onBlur={closesOnLeave(closeQuietly)}>
          {loading && <p className={s.valuesNote} role="status">Loading values…</p>}
          {error && (
            <div className={s.valuesError} role="alert">
              <p className={s.valuesProblem}>Couldn't load values: {error}</p>
              {errorKind === "noSource" && fix && onFix && (
                <a href="#" className={s.fixLink} onClick={(e) => { e.preventDefault(); onFix(fix, e); }}>Link one on {fix.name}'s page</a>
              )}
              {errorKind === "fetch" && onRetry && (
                <button type="button" className={s.retry} onClick={() => { retried.current = true; onRetry(); }}>Try again</button>
              )}
            </div>
          )}
          {!loading && values.length > FILTER_FROM && (
            <input className={`${s.input} ${s.valuesFilter}`} aria-label="Filter values" placeholder="Filter values" value={filter}
              spellCheck={false} autoComplete="off" data-values-filter="" onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowDown") return;
                const next = popup.current?.querySelector<HTMLElement>("[data-choices] input:checked")
                  ?? popup.current?.querySelector<HTMLElement>("[data-choices] input");
                if (!next) return;
                e.preventDefault();
                next.focus({ preventScroll: true });
              }} />
          )}
          <div className={s.choices} data-choices="">
            {includeAll && (
              <label className={s.choice}>
                <input type={type} name={groupName} checked={selected === "all"} onChange={toggleAll} />
                <span>All</span>
              </label>
            )}
            {missing.map((v) => (
              <label key={`missing:${v}`} className={`${s.choice} ${s.choiceMissing}`}>
                <input type={type} name={groupName} checked onChange={() => toggle(v)} />
                <span>{v} (not found)</span>
              </label>
            ))}
            {shown.map((v) => (
              <label key={v.value} className={s.choice}>
                <input type={type} name={groupName} checked={isOn(v.value)} onChange={() => toggle(v.value)} />
                <span>{v.name}</span>
              </label>
            ))}
            {!loading && !error && values.length === 0 && missing.length === 0 && <p className={s.valuesNote}>No values in this time range.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

interface Props {
  projects: { all: ProjectRef[]; selected: VarValue } | null;
  /** Projects are still being read. */
  projectsLoading: boolean;
  variables: VariableState[];
  onVar(name: string, value: VarValue): void;
  onProjects(value: VarValue): void;
  onRetry(name: string): void;
  /** Opens a project's page (Ctrl: in a new tab), where a missing source is linked. */
  onOpenProject(project: ProjectRef, e: MouseEvent<HTMLAnchorElement>): void;
}

export function VariablesBar({ projects, projectsLoading, variables, onVar, onProjects, onRetry, onOpenProject }: Props) {
  const projectValues = useMemo(() => projects?.all.map((p) => ({ value: p.id, name: p.name })) ?? [], [projects]);
  if (!projects && variables.length === 0) return null;
  return (
    <div className={s.vars} role="group" aria-label="Variables">
      {projects && (
        <Picker label="Projects" pending={projectsLoading} values={projectValues} selected={projects.selected} missing={[]}
          multi includeAll allChecksEach loading={projectsLoading} error={null} onChange={onProjects} />
      )}
      {variables.map((v) => (
        <Picker key={v.spec.name} label={v.spec.label} pending={v.loading && !v.spec.multi && v.selected !== "all" && v.selected.length === 0}
          values={v.values.map((x) => ({ value: x, name: x }))} selected={v.selected} missing={v.missing}
          multi={v.spec.multi} includeAll={v.spec.includeAll} allChecksEach={false} loading={v.loading} error={v.error}
          errorKind={v.errorKind} fix={v.fix} onRetry={() => onRetry(v.spec.name)} onFix={onOpenProject}
          onChange={(value) => onVar(v.spec.name, value)} />
      ))}
    </div>
  );
}
