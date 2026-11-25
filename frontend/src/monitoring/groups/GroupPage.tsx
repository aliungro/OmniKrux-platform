import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure, HttpError } from "../../api/http";
import { OwnerRuleLines, waitsForClusterRules } from "../alerts/reviews/OwnerRuleLines";
import { deleteGroup, groupDeleteReview, updateGroup } from "../api/client";
import { invalidateMonitoring, useGroups, useProjects, useSourceHealth } from "../api/hooks";
import type { GroupDeleteReviewOut, GroupOut, HealthOut, ProjectOut } from "../api/types";
import { takeHeadingFocus } from "../dashboards/create/arrival";
import { OwnerDashboards } from "../dashboards/OwnerDashboards";
import { DeleteReviewDialog } from "../DeleteReviewDialog";
import { EditableName } from "../EditableName";
import { escapeCloses } from "../focus";
import { projectDot, stateOf } from "../home/ProjectCard";
import type { MonitoringPageProps } from "../MonitoringApp";
import { MONITORING_HOME, type MonitoringView } from "../shell/tabState";
import { ExportButton, ImportButton } from "../transfer/ExportButton";
import { ProjectPicker } from "./GroupForm";
import s from "./GroupPage.module.css";

/** A member's health: down when any of its sources is down, up when all are up, else unknown. */
function memberHealth(p: ProjectOut, health: Record<string, HealthOut> | undefined): "up" | "down" | "unknown" {
  const states = p.links.map((l) => stateOf(health?.[l.source_id]));
  if (states.includes("down")) return "down";
  return states.length > 0 && states.every((x) => x === "up") ? "up" : "unknown";
}

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
        <ProjectPicker projects={projects.data} picked={picked} legend="Pick the projects"
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

const STALE_REVIEW = "Something changed since the review. Review it again.";

export default function GroupPage({ view, tabId, nav, openInNewTab }: MonitoringPageProps) {
  const id = view.page === "group" ? view.id : "";
  const client = useQueryClient();
  const groups = useGroups();
  const projects = useProjects();
  const healthQuery = useSourceHealth();
  const editButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const [editing, setEditing] = useState(false);
  const [review, setReview] = useState<GroupDeleteReviewOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing && wasEditing.current) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const group = groups.data?.find((g) => g.id === id);
  // Back here after one of its dashboards was deleted: the keyboard goes to the group's name.
  const loaded = group !== undefined;
  useEffect(() => {
    if (loaded && takeHeadingFocus("group", id)) document.getElementById("monitoring-group-title")?.focus({ preventScroll: true });
  }, [loaded, id]);
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

  // What deleting it takes (its dashboards) is read first; the delete carries that review's token.
  const askDelete = async () => {
    setPageError(null);
    setError(null);
    try {
      setReview(await groupDeleteReview(group.id));
    } catch (err) {
      setPageError(failure(err));
    }
  };

  /** After a cluster rule's removal: the review is read again; a read that fails says so in the dialog. */
  const rereadReview = async () => {
    try {
      setReview(await groupDeleteReview(group.id));
      setError(null);
    } catch (err) {
      setError(`${STALE_REVIEW} ${failure(err, "try again")}`);
    }
  };

  const confirmDelete = async () => {
    if (busy || !review) return;
    setBusy(true);
    setError(null);
    try {
      await deleteGroup(group.id, review.token);
      nav.navigate(MONITORING_HOME, "replace");
      void invalidateMonitoring(client);
    } catch (err) {
      setBusy(false);
      if (err instanceof HttpError && err.status === 409) {
        setError(STALE_REVIEW);
        try {
          setReview(await groupDeleteReview(group.id));
        } catch (again) {
          setError(`${STALE_REVIEW} ${failure(again, "try again")}`);
        }
      } else {
        setError(failure(err, "try again"));
      }
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
                <button type="button" className={s.shortcut} data-health={memberHealth(p, healthQuery.data)}
                  aria-describedby={memberHealth(p, healthQuery.data) === "down" ? `member-${p.id}-trouble` : undefined}
                  onClick={(e) => open({ page: "project", id: p.id }, e)}>
                  <span aria-hidden="true">↗</span>
                  <i className={s.dot} style={{ background: projectDot(p) }} aria-hidden="true" />
                  {p.name}
                  <i className={s.healthDot} aria-hidden="true" />
                </button>
                {memberHealth(p, healthQuery.data) === "down" && <span id={`member-${p.id}-trouble`} hidden>A source of this project is down.</span>}
              </li>
            ))}
          </ul>
        )}
        {editing ? <EditProjects group={group} onDone={() => setEditing(false)} /> : (
          <button ref={editButton} type="button" className={s.secondary} onClick={() => setEditing(true)}>Edit projects</button>
        )}
      </section>

      <section aria-labelledby="monitoring-group-dashboards" className={s.section}>
        <div className={s.headRow}>
          <h2 id="monitoring-group-dashboards" className={s.heading}>Dashboards</h2>
          <ExportButton kind="group" id={group.id} label="Export group" name={group.name} />
          <ImportButton onOpen={(e) => open({ page: "import", target: { kind: "group", id: group.id } }, e)} />
        </div>
        <OwnerDashboards owner={{ kind: "group", id: group.id, name: group.name }} tabId={tabId} nav={nav} openInNewTab={openInNewTab} />
      </section>

      <footer className={s.foot}>
        {pageError && <p className={s.bad} role="alert">{pageError}</p>}
        <button ref={deleteButton} type="button" className={s.dangerQuiet} onClick={() => void askDelete()}>Delete group…</button>
      </footer>

      {review && (
        <DeleteReviewDialog title={`Delete group ${group.name}?`} action="Delete group" busy={busy} blocked={waitsForClusterRules(review)} error={error} restoreFocusTo={deleteButton}
          onCancel={() => { if (!busy) { setReview(null); setError(null); } }} onConfirm={() => void confirmDelete()}>
          <p>{group.project_ids.length === 0 ? "It has no projects." : "Its projects stay as they are."}</p>
          {review.dashboards.length > 0 && <p>Its dashboards go with it: {review.dashboards.map((d) => d.title).join(", ")}.</p>}
          <OwnerRuleLines alertRules={review.alert_rules} clusterRules={review.cluster_rules} owner={{ kind: "group", id: group.id }}
            clusterOf={(pid) => byId.get(pid)?.cluster_name ?? null} fallbackCluster="a cluster"
            onOpenRule={(rule) => nav.navigate({ page: "alerts", rule }, "replace")} onReviewed={rereadReview} />
        </DeleteReviewDialog>
      )}
    </section>
  );
}
