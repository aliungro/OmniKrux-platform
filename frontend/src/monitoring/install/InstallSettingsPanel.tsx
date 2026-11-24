// The settings of an install review, inside the review dialog: a disclosure that reads as one line
// (namespace, how long data is kept, where) and opens into the fields. **Update review** (or Enter
// in a field) plans the install again with them; the dialog then shows the new plan. Each problem
// the plan has is said under its field, and a plan with problems opens the panel with the keyboard
// on the first of them. Edits not reviewed yet are kept (also when the review fails) and said so,
// so the one line never reads as including them.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { FactsOut, InstallSettingsIn, InstallSettingsOut, ResourcesOut, SettingProblemOut } from "./api";
import s from "./InstallSettingsPanel.module.css";

const COMPONENTS = [
  ["prometheus", "Prometheus"],
  ["alertmanager", "Alertmanager"],
  ["loki", "Loki"],
  ["alloy", "Grafana Alloy"],
] as const;
type ResourceKey = (typeof COMPONENTS)[number][0];

const COLUMNS = [
  ["cpu_request", "CPU request"],
  ["memory_request", "Memory request"],
  ["memory_limit", "Memory limit"],
] as const;

const STORAGE = [
  ["prometheus_storage", "Prometheus"],
  ["loki_storage", "Loki"],
  ["alertmanager_storage", "Alertmanager"],
] as const;
type StorageKey = (typeof STORAGE)[number][0];

/** Every field by its problem name, in the order they are shown (the first problem takes the keyboard). */
const FIELD_ORDER: string[] = [
  "namespace",
  "retention_days",
  ...STORAGE.map(([k]) => k),
  ...COMPONENTS.flatMap(([c]) => COLUMNS.map(([k]) => `${c}.${k}`)),
];

/** The backend's SETTING_RETENTION: said here too when the days aren't a whole number at all. */
const RETENTION = "Keep data for 1 to 90 days.";

interface Draft {
  namespace: string;
  days: string;
  persist: boolean;
  storage: Record<StorageKey, string>;
  resources: Record<ResourceKey, ResourcesOut>;
}

function toDraft(x: InstallSettingsOut): Draft {
  return {
    namespace: x.namespace,
    days: String(x.retention_days),
    persist: x.persist,
    storage: { prometheus_storage: x.prometheus_storage, loki_storage: x.loki_storage, alertmanager_storage: x.alertmanager_storage },
    resources: { prometheus: { ...x.prometheus }, alertmanager: { ...x.alertmanager }, loki: { ...x.loki }, alloy: { ...x.alloy } },
  };
}

const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/** The draft as the settings to plan with; null when the days aren't a whole number. */
function toSettings(d: Draft): InstallSettingsIn | null {
  const days = d.days.trim() === "" ? Number.NaN : Number(d.days);
  if (!Number.isInteger(days)) return null;
  return {
    namespace: d.namespace.trim(),
    retention_days: days,
    persist: d.persist,
    ...Object.fromEntries(STORAGE.map(([k]) => [k, d.storage[k].trim()])),
    ...Object.fromEntries(COMPONENTS.map(([c]) => [c, {
      cpu_request: d.resources[c].cpu_request.trim(),
      memory_request: d.resources[c].memory_request.trim(),
      memory_limit: d.resources[c].memory_limit.trim(),
    }])),
  };
}

export function settingsLine(x: InstallSettingsOut): string {
  const days = x.retention_days === 1 ? "1 day" : `${x.retention_days} days`;
  return `Namespace ${x.namespace} · keeps data ${days} · ${x.persist ? "on volumes" : "in memory only"}`;
}

export function InstallSettingsPanel({
  settings,
  problems,
  facts,
  busy,
  onUpdate,
}: {
  settings: InstallSettingsOut;
  problems: SettingProblemOut[];
  facts: FactsOut;
  busy: boolean;
  onUpdate(next: InstallSettingsIn): Promise<boolean>;
}) {
  const id = useId();
  const fieldId = (name: string) => `${id}-f-${name.replace(".", "-")}`;
  const [open, setOpen] = useState(problems.length > 0);
  const [draft, setDraft] = useState(() => toDraft(settings));
  const [updating, setUpdating] = useState(false);
  /** A problem found here before planning (days that aren't a number). */
  const [local, setLocal] = useState<SettingProblemOut | null>(null);
  const alive = useRef(true);
  /** Where the keyboard was when an update started: it goes back there after. */
  const restore = useRef<HTMLElement | null>(null);
  /** Set when the plan's problems are new: the first of them takes the keyboard. */
  const toProblem = useRef(problems.length > 0);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // A new plan: the fields show what it was made with, and its problems open the panel.
  const [seen, setSeen] = useState({ settings, problems });
  if (seen.settings !== settings || seen.problems !== problems) {
    setSeen({ settings, problems });
    if (seen.settings !== settings) setDraft(toDraft(settings));
    if (problems.length > 0) {
      setOpen(true);
      toProblem.current = true;
    }
  }

  const reviewed = toDraft(settings);
  const dirty = !sameDraft(draft, reviewed);
  const shownProblems = local ? [local] : problems;
  const problemOf = (name: string) => shownProblems.find((p) => p.field === name);
  const strays = shownProblems.filter((p) => !FIELD_ORDER.includes(p.field));
  const noStorageClass = facts.default_storage_class === null;
  const storageProblem = STORAGE.some(([k]) => problemOf(k));
  const showSizes = draft.persist || storageProblem;
  const disabled = busy || updating;

  // The keyboard after a plan or an update: the first problem's field, else where it was. A
  // timeout, so it lands after the dialog put its own first focus (the dialog opens after this).
  useEffect(() => {
    if (disabled) return;
    const timer = window.setTimeout(() => {
      if (toProblem.current) {
        toProblem.current = false;
        const first = FIELD_ORDER.find((f) => problemOf(f));
        const el = first ? document.getElementById(fieldId(first)) : null;
        if (el) {
          restore.current = null;
          el.focus();
          return;
        }
      }
      const back = restore.current;
      restore.current = null;
      const active = document.activeElement;
      const lost = active === null || active === document.body || !active.isConnected || active.getAttribute("role") === "dialog";
      if (back && lost && back.isConnected && !(back as HTMLButtonElement).disabled) back.focus();
    });
    return () => window.clearTimeout(timer);
  });

  const update = async () => {
    if (disabled) return;
    const next = toSettings(draft);
    const active = document.activeElement;
    restore.current = active instanceof HTMLElement && panelRef.current?.contains(active) ? active : null;
    if (next === null) {
      setLocal({ field: "retention_days", message: RETENTION });
      toProblem.current = true;
      return;
    }
    setLocal(null);
    setUpdating(true);
    try {
      await onUpdate(next);
    } finally {
      if (alive.current) setUpdating(false);
    }
  };

  // Enter in a field updates the review (plain Enter: Ctrl+Enter is the dialog's apply).
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (!e.repeat) void update();
    }
  };

  const edit = (change: (d: Draft) => Draft) => {
    setDraft((d) => change(d));
    if (local) setLocal(null);
  };

  const described = (name: string) => (problemOf(name) ? `${fieldId(name)}-p` : undefined);
  const problemLine = (name: string) => {
    const p = problemOf(name);
    return p ? <span id={`${fieldId(name)}-p`} className={s.problem}>{p.message}</span> : null;
  };
  const textField = (name: string, value: string, set: (v: string) => void, extra: { mono?: boolean; labelledBy?: string; inputMode?: "numeric" } = {}) => (
    <input
      id={fieldId(name)}
      className={`${s.input}${extra.mono ? ` ${s.mono}` : ""}`}
      value={value}
      onChange={(e) => set(e.target.value)}
      onKeyDown={onFieldKey}
      aria-invalid={problemOf(name) ? true : undefined}
      aria-describedby={described(name)}
      aria-labelledby={extra.labelledBy}
      inputMode={extra.inputMode}
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      disabled={disabled}
    />
  );

  return (
    <div ref={panelRef} className={s.panel} data-open={open || undefined}>
      <div className={s.head}>
        <button
          type="button"
          className={s.toggle}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className={s.chevron} aria-hidden="true" />
          Settings
        </button>
        <span className={s.line}>{settingsLine(settings)}</span>
      </div>
      {dirty && <p className={s.pending}>Not in this review yet. Update review to use them.</p>}
      <div id={`${id}-body`} className={s.body} hidden={!open}>
        {strays.length > 0 && (
          <ul className={s.strays}>
            {strays.map((p) => <li key={`${p.field}:${p.message}`}>{p.message}</li>)}
          </ul>
        )}
        <div className={s.rows}>
          <label className={s.label} htmlFor={fieldId("namespace")}>Namespace</label>
          <div className={s.cell}>
            {textField("namespace", draft.namespace, (v) => edit((d) => ({ ...d, namespace: v })), { mono: true })}
            {problemLine("namespace")}
          </div>

          <label className={s.label} htmlFor={fieldId("retention_days")}>Keep data for</label>
          <div className={s.cell}>
            <span className={s.days}>
              <input
                id={fieldId("retention_days")}
                type="number"
                min={1}
                max={90}
                step={1}
                className={`${s.input} ${s.number}`}
                value={draft.days}
                onChange={(e) => edit((d) => ({ ...d, days: e.target.value }))}
                onKeyDown={onFieldKey}
                aria-invalid={problemOf("retention_days") ? true : undefined}
                aria-describedby={described("retention_days")}
                disabled={disabled}
              />
              <span className={s.unit}>days</span>
            </span>
            {problemLine("retention_days")}
          </div>
        </div>

        <div className={s.storage}>
          <label className={s.check} title={noStorageClass ? "This cluster has no default storage class." : undefined}>
            <input
              type="checkbox"
              checked={draft.persist}
              onChange={(e) => edit((d) => ({ ...d, persist: e.target.checked }))}
              disabled={disabled || (noStorageClass && !draft.persist)}
              title={noStorageClass ? "This cluster has no default storage class." : undefined}
            />
            <span>Keep data on volumes</span>
          </label>
          {showSizes && (
            <div className={s.sizes}>
              {STORAGE.map(([key, label]) => (
                <div key={key} className={s.size}>
                  <label className={s.sizeLabel} htmlFor={fieldId(key)}>{label}</label>
                  {textField(key, draft.storage[key], (v) => edit((d) => ({ ...d, storage: { ...d.storage, [key]: v } })), { mono: true })}
                  {problemLine(key)}
                </div>
              ))}
            </div>
          )}
        </div>

        <table className={s.table}>
          <caption className={s.caption}>Resources</caption>
          <thead>
            <tr>
              <td />
              {COLUMNS.map(([key, label]) => (
                <th key={key} id={`${id}-c-${key}`} scope="col">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPONENTS.map(([c, label]) => (
              <tr key={c}>
                <th id={`${id}-r-${c}`} scope="row">{label}</th>
                {COLUMNS.map(([key]) => {
                  const name = `${c}.${key}`;
                  return (
                    <td key={key}>
                      {textField(name, draft.resources[c][key], (v) => edit((d) => ({
                        ...d, resources: { ...d.resources, [c]: { ...d.resources[c], [key]: v } },
                      })), { mono: true, labelledBy: `${id}-r-${c} ${id}-c-${key}` })}
                      {problemLine(name)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <div className={s.foot}>
          <button type="button" className={s.update} onClick={() => void update()} disabled={disabled}>
            {updating ? "Updating the review…" : "Update review"}
          </button>
        </div>
      </div>
    </div>
  );
}
