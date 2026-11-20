import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { createGroup } from "../api/client";
import { invalidateMonitoring, useProjects } from "../api/hooks";
import type { ProjectOut } from "../api/types";
import { projectDot } from "../home/ProjectCard";
import type { MonitoringPageProps } from "../MonitoringApp";
import s from "./GroupPage.module.css";

/** A checkbox per project, with its colour dot: the projects a group combines. */
export function ProjectPicker({ projects, picked, onToggle, legend }: {
  projects: ProjectOut[]; picked: ReadonlySet<string>; onToggle(id: string, on: boolean): void; legend: string;
}) {
  if (projects.length === 0) return <p className={s.muted}>No projects yet. Set one up first, then group it.</p>;
  return (
    <fieldset className={s.picker}>
      <legend className={s.fieldLabel}>{legend}</legend>
      <div className={s.pickGrid}>
        {projects.map((p) => (
          <label key={p.id} className={s.pickItem} data-on={picked.has(p.id) || undefined}>
            <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => onToggle(p.id, e.target.checked)} />
            <i className={s.dot} style={{ background: projectDot(p) }} aria-hidden="true" />
            {p.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** New group: a name and the projects it combines. Nothing moves; the projects stay where they are. */
export default function GroupForm({ nav }: MonitoringPageProps) {
  const client = useQueryClient();
  const ids = useId();
  const projects = useProjects();
  const name = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { name.current?.focus(); }, []);

  const submit = async () => {
    if (busy) return;
    if (text.trim() === "") {
      setError("Enter a name for the group.");
      name.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // In the order they are listed, not the order they were ticked.
      const project_ids = (projects.data ?? []).filter((p) => picked.has(p.id)).map((p) => p.id);
      const made = await createGroup({ name: text.trim(), project_ids });
      // Read the lists again first: the group page then opens on a list that names it.
      await invalidateMonitoring(client);
      nav.navigate({ page: "group", id: made.id }, "replace");
    } catch (err) {
      setError(failure(err, "try again"));
      setBusy(false);
    }
  };

  return (
    <section className={s.page} aria-labelledby={`${ids}-t`}>
      <h1 id={`${ids}-t`} className={s.title}>New group</h1>
      <p className={s.lead}>A group combines projects you pick. The projects stay where they are.</p>
      <form className={s.form} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className={s.nameField}>
          <label htmlFor={`${ids}-n`} className={s.fieldLabel}>Name</label>
          <input id={`${ids}-n`} ref={name} className={s.input} type="text" autoComplete="off" maxLength={80} value={text}
            aria-invalid={error && text.trim() === "" ? true : undefined} onChange={(e) => setText(e.target.value)} />
        </div>
        {projects.isError && !projects.data && <p className={s.bad} role="alert">{failure(projects.error)}</p>}
        {projects.data && (
          <ProjectPicker projects={projects.data} picked={picked} legend="Projects"
            onToggle={(id, on) => setPicked((cur) => { const next = new Set(cur); if (on) next.add(id); else next.delete(id); return next; })} />
        )}
        {error && <p className={s.bad} role="alert">{error}</p>}
        <div className={s.actions}>
          <button type="submit" className={s.primary} aria-disabled={busy || undefined}>{busy ? "Creating…" : "Create group"}</button>
        </div>
      </form>
    </section>
  );
}
