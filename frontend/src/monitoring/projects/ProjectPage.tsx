import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClusters } from "../../api/useClusters";
import { failure, HttpError } from "../../api/http";
import { deleteProject, linkSource, projectDeleteReview, renameProject, sourceFields, suggestFilter, unlinkSource } from "../api/client";
import { invalidateMonitoring, useGroups, useProject, useSourceHealth, useSources } from "../api/hooks";
import type { FilterOrigin, HealthOut, LinkOut, ProjectDeleteReviewOut, ProjectOut } from "../api/types";
import { takeHeadingFocus } from "../dashboards/create/arrival";
import { OwnerDashboards } from "../dashboards/OwnerDashboards";
import { EditableName } from "../EditableName";
import { escapeCloses } from "../focus";
import { ageNote, kindLine, projectDot, STATE_WORDS, stateOf } from "../home/ProjectCard";
import type { MonitoringPageProps } from "../MonitoringApp";
import { MONITORING_HOME, type MonitoringView } from "../shell/tabState";
import { SourceForm } from "../sources/SourceForm";
import { sourceTypeLabel, whereLabel } from "../sources/sourceLabels";
import { FilterField, validFilter } from "./FilterField";
import { ProjectDeleteReview } from "./ProjectDeleteReview";
import s from "./ProjectPage.module.css";

const UNKNOWN: HealthOut = { state: "unknown", message: null, version: null, checked_at: null };
const STALE_REVIEW = "Something changed since the review. Review it again.";

/** The project's dashboards, then its ready-made views (generated from its Prometheus). */
export function ProjectDashboardsSlot({ project, tabId, nav, openInNewTab }: {
  project: ProjectOut;
  tabId: string;
  nav: MonitoringPageProps["nav"];
  openInNewTab(view: MonitoringView): void;
}) {
  return (
    <OwnerDashboards owner={{ kind: "project", id: project.id, name: project.name }} tabId={tabId} nav={nav} openInNewTab={openInNewTab}
      prometheus={project.links.some((l) => l.source_type === "prometheus")} />
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The origin a saved filter carries: nothing typed is "none"; otherwise what the user or OmniKrux made of it. */
const originOf = (filter: string, origin: FilterOrigin): FilterOrigin => (filter.trim() === "" ? "none" : origin);

/** One source link: its health, its label filter (editable here), Check data and Unlink. */
function LinkRow({ project, link, health, onUnlinked }: {
  project: ProjectOut; link: LinkOut; health: HealthOut; onUnlinked(): void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [check, setCheck] = useState<"busy" | { ok: boolean; text: string } | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  // Which filter a Check data answer belongs to: editing or saving the filter starts a new one, and
  // an answer for an older one is dropped.
  const checkRound = useRef(0);
  const forgetCheck = () => { checkRound.current += 1; setCheck(null); };

  const value = draft ?? link.filter;
  const dirty = draft !== null && draft !== link.filter;
  const invalid = validFilter(value) !== null;
  const state = stateOf(health);
  const age = state === "unknown" ? null : ageNote(health.checked_at, Date.now());

  const save = async () => {
    if (!dirty || invalid || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await linkSource(project.id, link.source_id, value.trim(), originOf(value, "user"));
      await invalidateMonitoring(client);
      setDraft(null);
      setSaved(true);
      forgetCheck();
    } catch (err) {
      setProblem(failure(err, "save again"));
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    if (check === "busy") return;
    const round = checkRound.current;
    setCheck("busy");
    const answer = (next: { ok: boolean; text: string }) => { if (round === checkRound.current) setCheck(next); };
    try {
      const out = await sourceFields(link.source_id, project.id);
      const labels = plural(out.labels.length, "label", "labels");
      const text = link.source_type === "loki"
        ? `${labels} visible to this project`
        : `${plural(out.metrics.length, "metric", "metrics")} and ${labels} visible to this project`;
      answer({ ok: true, text });
    } catch (err) {
      answer({ ok: false, text: failure(err, "check again") });
    }
  };

  const unlink = async () => {
    if (unlinking) return;
    setUnlinking(true);
    setProblem(null);
    try {
      await unlinkSource(project.id, link.source_id);
      await invalidateMonitoring(client);
      onUnlinked();
    } catch (err) {
      setProblem(failure(err, "try again"));
      setUnlinking(false);
    }
  };

  return (
    <li className={s.row}>
      <div role="group" aria-label={link.source_name} className={s.rowBody}>
        <div className={s.rowHead}>
          <span className={s.name}>{link.source_name}</span>
          <span className={s.kind}>{sourceTypeLabel(link.source_type)}</span>
          <span className={s.health} data-state={state} title={state === "down" ? (health.message ?? undefined) : undefined}>
            <i className={s.pip} aria-hidden="true" />{STATE_WORDS[state]}{age ? ` · ${age}` : ""}
          </span>
        </div>
        <div className={s.filterLine}>
          <FilterField value={value} origin={draft === null ? link.filter_origin : "user"} reason={null} forName={link.source_name}
            onChange={(v) => { setDraft(v); setSaved(false); forgetCheck(); }} />
          <button type="button" className={s.secondary} aria-label={`Save filter for ${link.source_name}`}
            aria-disabled={!dirty || invalid || saving || undefined} onClick={() => void save()}>
            {saving ? "Saving…" : "Save filter"}
          </button>
        </div>
        <div className={s.rowActions}>
          <button type="button" className={s.quiet} aria-label={`Check data for ${link.source_name}`}
            aria-disabled={check === "busy" || undefined} onClick={() => void runCheck()}>
            {check === "busy" ? "Checking…" : "Check data"}
          </button>
          <button type="button" className={s.quiet} aria-label={`Unlink ${link.source_name}`}
            aria-disabled={unlinking || undefined} onClick={() => void unlink()}>Unlink</button>
        </div>
        {saved && !dirty && <p className={s.ok} role="status">Filter saved.</p>}
        {check && check !== "busy" && <p className={check.ok ? s.ok : s.bad} role={check.ok ? "status" : "alert"}>{check.text}</p>}
        {problem && <p className={s.bad} role="alert">{problem}</p>}
      </div>
    </li>
  );
}

/** Pick a saved source that is not linked yet and give it a filter (suggested where OmniKrux can tell). */
function ExistingPanel({ project, onClose, onLinked }: { project: ProjectOut; onClose(): void; onLinked(): void }) {
  const client = useQueryClient();
  const sources = useSources();
  const select = useRef<HTMLSelectElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const asked = useRef(0);
  const touched = useRef(false);
  const [sourceId, setSourceId] = useState("");
  const [filter, setFilter] = useState("");
  const [origin, setOrigin] = useState<FilterOrigin>("none");
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linked = new Set(project.links.map((l) => l.source_id));
  const choices = (sources.data ?? []).filter((x) => !linked.has(x.id));
  const invalid = validFilter(filter) !== null;

  // The keyboard goes to the choice, or to Cancel when there is nothing to choose: the button that opened this is gone.
  useEffect(() => { (select.current ?? cancel.current)?.focus(); }, [choices.length > 0]);

  const choose = (id: string) => {
    setSourceId(id);
    setFilter("");
    setOrigin("none");
    setReason(null);
    setError(null);
    touched.current = false;
    const mine = ++asked.current;
    if (!id) return;
    suggestFilter({ cluster_id: project.cluster_id, kind: project.kind, source_id: id }).then(
      (out) => {
        if (mine !== asked.current || touched.current) return;
        setFilter(out.filter);
        setOrigin(out.origin);
        setReason(out.reason);
      },
      (err) => { if (mine === asked.current && !touched.current) setReason(`Couldn't suggest a filter: ${failure(err)}`); },
    );
  };

  const link = async () => {
    if (busy || !sourceId || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await linkSource(project.id, sourceId, filter.trim(), originOf(filter, origin));
      await invalidateMonitoring(client);
      onLinked();
    } catch (err) {
      setError(failure(err, "try again"));
      setBusy(false);
    }
  };

  return (
    <div className={s.panel} onKeyDown={escapeCloses(onClose, busy)}>
      {sources.isError && !sources.data && <p className={s.bad} role="alert">{failure(sources.error)}</p>}
      {sources.data && choices.length === 0 && <p className={s.muted}>Every source is already linked to this project. Add one by hand instead.</p>}
      {choices.length > 0 && (
        <>
          <div className={s.pick}>
            <label htmlFor="project-existing-source" className={s.fieldLabel}>Source</label>
            <select id="project-existing-source" ref={select} className={s.select} value={sourceId} onChange={(e) => choose(e.target.value)}>
              <option value="">Choose a source…</option>
              {choices.map((x) => <option key={x.id} value={x.id}>{x.name} · {sourceTypeLabel(x.type)} · {whereLabel(x)}</option>)}
            </select>
          </div>
          {sourceId && (
            <FilterField value={filter} origin={origin} reason={reason} forName="the new link"
              onChange={(v, o) => { touched.current = true; setFilter(v); setOrigin(o); }} />
          )}
        </>
      )}
      {error && <p className={s.bad} role="alert">{error}</p>}
      <div className={s.panelActions}>
        {choices.length > 0 && (
          <button type="button" className={s.primary} aria-disabled={!sourceId || invalid || busy || undefined} onClick={() => void link()}>
            {busy ? "Linking…" : "Link source"}
          </button>
        )}
        <button ref={cancel} type="button" className={s.secondary} aria-disabled={busy || undefined} onClick={() => { if (!busy) onClose(); }}>Cancel</button>
      </div>
    </div>
  );
}

export default function ProjectPage({ view, tabId, nav, openInNewTab }: MonitoringPageProps) {
  const id = view.page === "project" ? view.id : "";
  const client = useQueryClient();
  const projectQuery = useProject(id);
  const groups = useGroups();
  const healthQuery = useSourceHealth();
  const clusters = useClusters();
  const sourcesHeading = useRef<HTMLHeadingElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const addExisting = useRef<HTMLButtonElement>(null);
  const addHand = useRef<HTMLButtonElement>(null);
  const backTo = useRef<"existing" | "hand" | null>(null);
  const [adding, setAdding] = useState<"existing" | "hand" | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [review, setReview] = useState<ProjectDeleteReviewOut | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // After a panel closes the keyboard returns to the button that opened it.
  useEffect(() => {
    if (adding === null && backTo.current) {
      (backTo.current === "existing" ? addExisting : addHand).current?.focus();
      backTo.current = null;
    }
  }, [adding]);
  const closePanel = useCallback(() => { backTo.current = adding; setAdding(null); }, [adding]);

  const project = projectQuery.data;
  // Back here after one of its dashboards was deleted: the keyboard goes to the project's name.
  const loaded = project !== undefined;
  useEffect(() => {
    if (loaded && takeHeadingFocus("project", id)) document.getElementById("monitoring-project-title")?.focus({ preventScroll: true });
  }, [loaded, id]);
  if (!project) {
    if (projectQuery.isError) {
      return (
        <section className={s.page}>
          <div className={s.note} role="alert">
            <p>{failure(projectQuery.error, "try again")}</p>
            <button type="button" className={s.secondary} onClick={() => void projectQuery.refetch()}>Try again</button>
          </div>
        </section>
      );
    }
    return <section className={s.page} aria-busy="true"><p className={s.note} role="status">Loading project…</p></section>;
  }

  const health = healthQuery.data ?? {};
  const clusterLoaded = clusters.data !== undefined;
  const clusterGone = clusterLoaded && project.kind === "kubernetes" && project.cluster_id !== null
    && !clusters.data!.some((c) => c.id === project.cluster_id);
  const clusterName = clusterGone ? null
    : (project.cluster_name ?? clusters.data?.find((c) => c.id === project.cluster_id)?.name ?? null);
  const inGroups = (groups.data ?? []).filter((g) => g.project_ids.includes(project.id));

  const rename = async (name: string) => {
    await renameProject(project.id, name);
    await invalidateMonitoring(client);
  };

  const askDelete = async () => {
    setPageError(null);
    setReviewError(null);
    try {
      setReview(await projectDeleteReview(project.id));
    } catch (err) {
      setPageError(failure(err));
    }
  };

  const confirmDelete = async () => {
    if (!review || reviewBusy) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      await deleteProject(project.id, review.token);
      // The tab shows Home in place of this project (MonitoringApp hands the keyboard to the workspace).
      nav.navigate(MONITORING_HOME, "replace");
      void invalidateMonitoring(client);
    } catch (err) {
      setReviewBusy(false);
      if (err instanceof HttpError && err.status === 409) {
        setReviewError(STALE_REVIEW);
        try {
          setReview(await projectDeleteReview(project.id));
        } catch (again) {
          setReviewError(`${STALE_REVIEW} ${failure(again, "try again")}`);
        }
      } else {
        setReviewError(failure(err, "try again"));
      }
    }
  };

  /** A source made by hand here is saved already; give it a link, with a suggested filter where one can be made. */
  const linkNew = async (sourceId: string) => {
    setPageError(null);
    let filter = "";
    let origin: FilterOrigin = "none";
    try {
      const out = await suggestFilter({ cluster_id: project.cluster_id, kind: project.kind, source_id: sourceId });
      filter = out.filter;
      origin = out.origin;
    } catch {
      // No suggestion: the link starts without a filter and can be edited in its row.
    }
    try {
      await linkSource(project.id, sourceId, filter, originOf(filter, origin));
      await invalidateMonitoring(client);
    } catch (err) {
      setPageError(`The source was saved but could not be linked to this project: ${failure(err)} Use an existing source to link it.`);
      void invalidateMonitoring(client);
    }
    closePanel();
  };

  const open = (target: MonitoringView, e: { ctrlKey: boolean; metaKey: boolean }) =>
    e.ctrlKey || e.metaKey ? openInNewTab(target) : nav.navigate(target, "push");

  return (
    <section className={s.page} aria-labelledby="monitoring-project-title">
      <header className={s.head}>
        <EditableName key={project.id} name={project.name} titleId="monitoring-project-title" dot={projectDot(project)} onRename={rename} />
        <p className={s.sub}>{kindLine(project, clusterName)}</p>
        {clusterGone && <p className={s.warn}>Cluster no longer connected</p>}
      </header>

      {pageError && <p className={s.bad} role="alert">{pageError}</p>}

      <section aria-labelledby="monitoring-project-sources" className={s.section}>
        <h2 id="monitoring-project-sources" ref={sourcesHeading} tabIndex={-1} className={s.heading}>Sources</h2>
        {project.links.length === 0 && <p className={s.muted}>No sources yet. Use an existing one or add one by hand.</p>}
        {project.links.length > 0 && (
          <ul className={s.list}>
            {project.links.map((l) => (
              <LinkRow key={l.source_id} project={project} link={l} health={health[l.source_id] ?? UNKNOWN}
                onUnlinked={() => sourcesHeading.current?.focus()} />
            ))}
          </ul>
        )}
        {adding === null ? (
          <div className={s.addRow}>
            <button ref={addExisting} type="button" className={s.secondary} onClick={() => setAdding("existing")}>Use an existing source</button>
            <button ref={addHand} type="button" className={s.secondary} onClick={() => setAdding("hand")}>Add a source by hand</button>
          </div>
        ) : adding === "existing" ? (
          <ExistingPanel project={project} onClose={closePanel} onLinked={closePanel} />
        ) : (
          <div className={s.panel}>
            <SourceForm mode="save" closeOnEscape onSaved={(saved) => linkNew(saved.id)} onCancel={closePanel} />
          </div>
        )}
      </section>

      <section aria-labelledby="monitoring-project-dashboards" className={s.section}>
        <h2 id="monitoring-project-dashboards" className={s.heading}>Dashboards</h2>
        <ProjectDashboardsSlot project={project} tabId={tabId} nav={nav} openInNewTab={openInNewTab} />
      </section>

      <section aria-labelledby="monitoring-project-groups" className={s.section}>
        <h2 id="monitoring-project-groups" className={s.heading}>Groups</h2>
        {inGroups.length === 0 ? <p className={s.muted}>Not in a group.</p> : (
          <ul className={s.chips}>
            {inGroups.map((g) => (
              <li key={g.id}>
                <button type="button" className={s.chip} onClick={(e) => open({ page: "group", id: g.id }, e)}>{g.name}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className={s.foot}>
        <button ref={deleteButton} type="button" className={s.dangerQuiet} onClick={() => void askDelete()}>Delete project…</button>
      </footer>

      {review && (
        <ProjectDeleteReview review={review} busy={reviewBusy} error={reviewError} restoreFocusTo={deleteButton}
          onCancel={() => { if (!reviewBusy) { setReview(null); setReviewError(null); } }} onConfirm={() => void confirmDelete()} />
      )}
    </section>
  );
}
