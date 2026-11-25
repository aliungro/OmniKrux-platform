// The Add to dashboard dialog (X5): the query in the field becomes a new panel on a saved dashboard
// of the project or of a group that holds it, or on a new dashboard of the project. It asks only
// what it must: where, what to call the panel and how to draw it. The query text is the field's,
// untouched. A failure stays in the dialog, under the select, and takes the keyboard.

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { DialogShell } from "../../features/dock/ConfirmDialog";
import { useGroups } from "../api/hooks";
import type { LinkOut, ProjectOut } from "../api/types";
import { listDashboards, refreshAfterDashboardChange } from "../dashboards/api";
import { editSessions } from "../dashboards/editor/useDashboardEditor";
import { hasUnsavedWork } from "../dashboards/editor/editorState";
import { readDraft } from "../dashboards/drafts/draftStore";
import type { PanelType, Unit } from "../dashboards/schema";
import { nextPanelId } from "../dashboards/schema";
import {
  addPanelToDashboard, createDashboardWithPanel, dashboardTargets, explorePanel, freshTitle, type DashboardTarget,
} from "./addToDashboard";
import s from "./AddToDashboardDialog.module.css";

export const DRAFT_NOTE =
  "You have unsaved changes to this dashboard in this browser. The panel is saved now; saving your draft later asks you to review the differences.";
const LOAD_FAILED = "Couldn't read your dashboards. You can still make a new one.";
const LOADING = "Reading your dashboards…";
const NEW = "new";
const METRIC_CHARTS: readonly { type: PanelType; label: string }[] = [
  { type: "timeseries", label: "Time series" },
  { type: "stat", label: "Stat" },
  { type: "bar", label: "Bar" },
  { type: "table", label: "Table" },
];
const MAX_TITLE = 120;

/** Whether this browser holds changes to the dashboard that the save below doesn't carry. */
function holdsUnsavedWork(dashboardId: string): boolean {
  if (readDraft(dashboardId) !== null) return true;
  for (const state of editSessions.values()) {
    if (state.mode === "edit" && state.dashboardId === dashboardId && hasUnsavedWork(state)) return true;
  }
  return false;
}

export interface Added {
  /** The dashboard's id and title. */
  id: string;
  title: string;
}

interface Props {
  project: ProjectOut;
  source: LinkOut;
  expr: string;
  /** A log query is added as a Logs panel; anything else as a chart. */
  kind: "logs" | "metrics";
  /** The panel title the dialog starts with. */
  defaultTitle: string;
  unit: Unit;
  /** The button that opened the dialog: the keyboard goes back to it. */
  restoreFocusTo: RefObject<HTMLElement | null>;
  onAdded(added: Added): void;
  onCancel(): void;
}

export function AddToDashboard({ project, source, expr, kind, defaultTitle, unit, restoreFocusTo, onAdded, onCancel }: Props) {
  const id = useId();
  const client = useQueryClient();
  const select = useRef<HTMLSelectElement>(null);
  const errorBox = useRef<HTMLParagraphElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const dashboards = useQuery({ queryKey: ["monitoring", "dashboards", "all"], queryFn: () => listDashboards(), retry: false });
  const groups = useGroups();
  const targets = useMemo(
    () => (dashboards.data && groups.data ? dashboardTargets(project, groups.data, dashboards.data) : []),
    [dashboards.data, groups.data, project],
  );
  const loaded = dashboards.data !== undefined && groups.data !== undefined;
  const loadFailed = dashboards.isError || groups.isError;
  const mine = targets.filter((t) => t.ownerKind === "project");
  const heldGroups = useMemo(() => {
    const out: { name: string; targets: DashboardTarget[] }[] = [];
    for (const t of targets) {
      if (t.ownerKind !== "group") continue;
      const last = out[out.length - 1];
      if (last && last.name === t.ownerName) last.targets.push(t);
      else out.push({ name: t.ownerName, targets: [t] });
    }
    return out;
  }, [targets]);

  const [choice, setChoice] = useState<string>(NEW);
  const [newTitle, setNewTitle] = useState<string | null>(null);
  const [panelTitle, setPanelTitle] = useState(defaultTitle);
  const [chart, setChart] = useState<PanelType>(kind === "logs" ? "logs" : "timeseries");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = choice === NEW ? null : (targets.find((t) => t.id === choice) ?? null);
  const taken = (dashboards.data ?? []).filter((d) => d.owner_kind === "project" && d.owner_id === project.id).map((d) => d.title);
  const titleValue = newTitle ?? freshTitle(taken);
  const note = target !== null && holdsUnsavedWork(target.id) ? DRAFT_NOTE : null;

  // A failure takes the keyboard: it is read where the problem is.
  useEffect(() => { if (error !== null) errorBox.current?.focus(); }, [error]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const title = panelTitle.trim() === "" ? defaultTitle : panelTitle.trim();
    const make = (ownerKind: "project" | "group") => (spec: Parameters<typeof nextPanelId>[0]) =>
      explorePanel({ expr, source, title, panelType: chart, unit }, nextPanelId(spec), ownerKind);
    try {
      let added: Added;
      if (target === null) {
        const made = await createDashboardWithPanel({ kind: "project", id: project.id }, titleValue.trim() === "" ? freshTitle(taken) : titleValue.trim(), make("project"));
        added = { id: made.id, title: made.title };
      } else {
        const saved = await addPanelToDashboard(target, make(target.ownerKind));
        added = { id: target.id, title: saved.title };
      }
      // Every tab showing the dashboard, the lists and the audit log read the new version.
      void refreshAfterDashboardChange(client);
      if (alive.current) onAdded(added);
    } catch (err) {
      if (!alive.current) return;
      setBusy(false);
      setError(failure(err, "try again"));
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const charts = kind === "logs" ? [{ type: "logs" as PanelType, label: "Logs" }] : METRIC_CHARTS;

  return (
    <DialogShell provider="monitoring" role="dialog" busy={busy} onCancel={onCancel} onConfirm={() => void submit()} first={select}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} className={s.dialog}>
      <form onSubmit={onSubmit} noValidate>
        <h2 id={`${id}-t`} className={s.title}>Add to dashboard</h2>
        <code className={s.query} data-add-query="">{expr}</code>

        <label className={s.field}>
          <span className={s.label}>Dashboard</span>
          <select ref={select} className={s.control} value={choice} aria-describedby={error !== null ? `${id}-e` : undefined}
            onChange={(e) => { setChoice(e.target.value); setError(null); }}>
            <option value={NEW}>{`New dashboard in ${project.name}…`}</option>
            {mine.length > 0 && (
              <optgroup label={project.name}>
                {mine.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </optgroup>
            )}
            {heldGroups.map((g) => (
              <optgroup key={g.name} label={`${g.name} (group)`}>
                {g.targets.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        {!loaded && <p className={s.quiet}>{loadFailed ? LOAD_FAILED : LOADING}</p>}
        {error !== null && <p ref={errorBox} id={`${id}-e`} tabIndex={-1} role="alert" className={s.error}>{error}</p>}
        {note !== null && <p className={s.note} data-draft-note="">{note}</p>}

        {target === null && (
          <label className={s.field}>
            <span className={s.label}>Title</span>
            <input className={s.control} type="text" value={titleValue} maxLength={MAX_TITLE} onChange={(e) => setNewTitle(e.target.value)} />
          </label>
        )}
        <label className={s.field}>
          <span className={s.label}>Panel title</span>
          <input className={s.control} type="text" value={panelTitle} maxLength={MAX_TITLE} onChange={(e) => setPanelTitle(e.target.value)} />
        </label>
        <label className={s.field}>
          <span className={s.label}>Chart</span>
          <select className={s.control} value={chart} onChange={(e) => setChart(e.target.value as PanelType)}>
            {charts.map((c) => <option key={c.type} value={c.type}>{c.label}</option>)}
          </select>
        </label>

        <div className={s.actions}>
          <button type="button" className={s.secondary} aria-disabled={busy || undefined} onClick={() => { if (!busy) onCancel(); }}>Cancel</button>
          <button type="submit" className={s.primary} aria-disabled={busy || undefined}>Add panel</button>
        </div>
      </form>
    </DialogShell>
  );
}
