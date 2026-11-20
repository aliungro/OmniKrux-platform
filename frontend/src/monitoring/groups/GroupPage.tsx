import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { deleteGroup, updateGroup } from "../api/client";
import { invalidateMonitoring, useGroups, useProjects } from "../api/hooks";
import type { GroupOut } from "../api/types";
import { DeleteReviewDialog } from "../DeleteReviewDialog";
import { EditableName } from "../EditableName";
import { escapeCloses } from "../focus";
import { projectDot } from "../home/ProjectCard";
import type { MonitoringPageProps } from "../MonitoringApp";
import { MONITORING_HOME, type MonitoringView } from "../shell/tabState";
import { ProjectPicker } from "./GroupForm";
import s from "./GroupPage.module.css";

/** The panel behind Edit projects: tick the projects the group combines, then Save. */
function EditProjects({ group, onDone }: { group: GroupOut; onDone(): void }) {
  const client = useQueryClient();
  const projects = useProjects();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(group.project_ids));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // The first project, or Cancel when there are none to tick: the button that opened this is gone.
  useEffect(() => { (first.current?.querySelector("input") ?? cancel.current)?.focus(); }, [projects.data?.length]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const project_ids = (projects.data ?? []).filter((p) => picked.has(p.id)).map((p) => p.id);
      await updateGroup(group.id, { project_ids });
      await invalidateMonitoring(client);
      onDone();
    } catch (err) {
      setError(failure(err, "try again"));
      setBusy(false);
    }
  };

  return (
    <div ref={first} className={s.panel} onKeyDown={escapeCloses(onDone, busy)}>
      {projects.isError && !projects.data && <p className={s.bad} role="alert">{failure(projects.error)}</p>}
      {projects.data && (
        <ProjectPicker projects={projects.data} picked={picked} legend="Projects"
          onToggle={(id, on) => setPicked((cur) => { const next = new Set(cur); if (on) next.add(id); else next.delete(id); return next; })} />
      )}
      {error && <p className={s.bad} role="alert">{error}</p>}
      <div className={s.actions}>
        <button type="button" className={s.primary} aria-disabled={busy || undefined} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        <button ref={cancel} type="button" className={s.secondary} aria-disabled={busy || undefined} onClick={() => { if (!busy) onDone(); }}>Cancel</button>
      </div>
    </div>
  );
}

export default function GroupPage({ view, nav, openInNewTab }: MonitoringPageProps) {
  const id = view.page === "group" ? view.id : "";
  const client = useQueryClient();
  const groups = useGroups();
  const projects = useProjects();
  const editButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing && wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const group = groups.data?.find((g) => g.id === id);
  if (!group) {
    if (groups.isError && !groups.data) {
      return (
        <section className={s.page}>
          <div className={s.note} role="alert">
            <p>{failure(groups.error, "try again")}</p>
            <button type="button" className={s.secondary} onClick={() => void groups.refetch()}>Try again</button>
          </div>
        </section>
      );
    }
    return <section className={s.page} aria-busy="true"><p className={s.note} role="status">Loading group…</p></section>;
  }

  const byId = new Map((projects.data ?? []).map((p) => [p.id, p]));
  const members = group.project_ids.flatMap((pid) => byId.get(pid) ?? []);

  const open = (target: MonitoringView, e: { ctrlKey: boolean; metaKey: boolean }) =>
    e.ctrlKey || e.metaKey ? openInNewTab(target) : nav.navigate(target, "push");

  const rename = async (name: string) => {
    await updateGroup(group.id, { name });
    await invalidateMonitoring(client);
  };

  const confirmDelete = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteGroup(group.id);
      nav.navigate(MONITORING_HOME, "replace");
      void invalidateMonitoring(client);
    } catch (err) {
      setBusy(false);
      setError(failure(err, "try again"));
    }
  };

  return (
    <section className={s.page} aria-labelledby="monitoring-group-title">
      <header className={s.head}>
        <EditableName key={group.id} name={group.name} titleId="monitoring-group-title" onRename={rename} />
        <p className={s.sub}>{members.length === 1 ? "1 project" : `${members.length} projects`}</p>
      </header>

      <section aria-labelledby="monitoring-group-projects" className={s.section}>
        <h2 id="monitoring-group-projects" className={s.heading}>Projects</h2>
        {members.length === 0 ? <p className={s.muted}>No projects in this group yet. Use Edit projects to add some.</p> : (
          <ul className={s.shortcuts} aria-label="Projects in this group">
            {members.map((p) => (
              <li key={p.id}>
                <button type="button" className={s.shortcut} onClick={(e) => open({ page: "project", id: p.id }, e)}>
                  <span aria-hidden="true">↗</span>
                  <i className={s.dot} style={{ background: projectDot(p) }} aria-hidden="true" />
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        {editing ? <EditProjects group={group} onDone={() => setEditing(false)} /> : (
          <button ref={editButton} type="button" className={s.secondary} onClick={() => setEditing(true)}>Edit projects</button>
        )}
      </section>

      <section aria-labelledby="monitoring-group-dashboards" className={s.section}>
        <h2 id="monitoring-group-dashboards" className={s.heading}>Dashboards</h2>
        <p className={s.later}>Group dashboards arrive in the next update.</p>
      </section>

      <footer className={s.foot}>
        <button ref={deleteButton} type="button" className={s.dangerQuiet} onClick={() => { setError(null); setAsking(true); }}>Delete group…</button>
      </footer>

      {asking && (
        <DeleteReviewDialog title={`Delete group ${group.name}?`} action="Delete group" busy={busy} error={error} restoreFocusTo={deleteButton}
          onCancel={() => { if (!busy) setAsking(false); }} onConfirm={() => void confirmDelete()}>
          <p>Its projects stay as they are.</p>
        </DeleteReviewDialog>
      )}
    </section>
  );
}
