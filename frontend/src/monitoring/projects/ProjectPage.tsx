import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClusters } from "../../api/useClusters";
import { failure, HttpError } from "../../api/http";
import { deleteProject, linkSource, projectDeleteReview, renameProject, sourceFields, suggestFilter, unlinkSource } from "../api/client";
import { invalidateMonitoring, useGroups, useProject, useSourceHealth, useSources } from "../api/hooks";
import type { FilterOrigin, HealthOut, LinkOut, ProjectDeleteReviewOut, ProjectOut, SourceOut } from "../api/types";
import { takeHeadingFocus } from "../dashboards/create/arrival";
import { OwnerDashboards } from "../dashboards/OwnerDashboards";
import { readyAddedBy, readyViewsPhrase } from "../dashboards/readyViews";
import { EditableName } from "../EditableName";
import { escapeCloses } from "../focus";
import { mayMixClusters, mixedLinkWords } from "../alerts/rules/clusterWarning";
import { ageNote, kindLine, projectDot, stateOf } from "../home/ProjectCard";
import type { MonitoringPageProps } from "../MonitoringApp";
import { MONITORING_HOME, type MonitoringView } from "../shell/tabState";
import { clearImportFailure, importFailedWords, importFailure } from "../setup/importNotice";
import { SourceForm } from "../sources/SourceForm";
import { isQueryable, sortLinks, sourceTypeLabel, stateWords, whereLabel } from "../sources/sourceLabels";
import { FilterField, validFilter } from "./FilterField";
import { ProjectDeleteReview } from "./ProjectDeleteReview";
import { ExportButton, ImportButton } from "../transfer/ExportButton";
import { ProjectGenerate, ProjectTools } from "./ProjectTools";
import s from "./ProjectPage.module.css";

const UNKNOWN: HealthOut = { state: "unknown", message: null, version: null, checked_at: null };
const STALE_REVIEW = "Something changed since the review. Review it again.";

/** The project's dashboards, then its ready-made views (generated from its Prometheus and Loki). */
export function ProjectDashboardsSlot({ project, tabId, nav, openInNewTab, clusterDown = false }: {
  project: ProjectOut;
  /** Every failing source is down for one cluster, which the page says once: views don't repeat why. */
  clusterDown?: boolean;
  tabId: string;
  nav: MonitoringPageProps["nav"];
  openInNewTab(view: MonitoringView): void;
}) {
  return (
    <OwnerDashboards owner={{ kind: "project", id: project.id, name: project.name }} tabId={tabId} nav={nav} openInNewTab={openInNewTab}
      readyMade={project.links.some((l) => l.source_type === "prometheus" || l.source_type === "loki")} clusterDown={clusterDown}
      manyPrometheus={project.links.filter((l) => l.source_type === "prometheus").length >= 2} />
  );
}

/** What linking a source of this type brings: "It adds the ready-made view Logs overview." or nothing. */
const addsLine = (project: ProjectOut, type: string | undefined): string | null => {
  const titles = type === "prometheus" || type === "loki" ? readyAddedBy(project, type) : [];
  return titles.length > 0 ? `adds ${readyViewsPhrase(titles)}.` : null;
};

export const nothingVisibleWords = (source: string) => `Nothing in ${source} is visible to this project. Check the filter.`;
const UNDO_AFTER_MS = 10_000;
const SAVED_FOR_MS = 5_000;

/**
 * The cluster every failing source fails for, when each says it can't reach that very cluster
 * (the server's words, `Can't reach {cluster}, so …`); any other reason keeps its own line.
 */
export function unreachableCluster(links: LinkOut[], health: Record<string, HealthOut>, nameOf: (id: string) => string | null): string | null {
  const failing = links.filter((l) => stateOf(health[l.source_id]) === "down");
  // One link that answers (or has not been checked) is enough to keep each link's own reason.
  if (failing.length === 0 || failing.length < links.length) return null;
  const ids = new Set(failing.map((l) => l.source_cluster_id ?? null));
  const id = ids.size === 1 ? [...ids][0] : null;
  const name = id === null ? null : nameOf(id);
  if (name === null) return null;
  return failing.every((l) => (health[l.source_id]?.message ?? "").startsWith(`Can't reach ${name}, so `)) ? name : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The origin a saved filter carries: nothing typed is "none"; otherwise what the user or OmniKrux made of it. */
const originOf = (filter: string, origin: FilterOrigin): FilterOrigin => (filter.trim() === "" ? "none" : origin);

/** One source link: its health, its label filter (editable here), Check data and Unlink. */
function LinkRow({ project, link, health, onUnlinked, onAct }: {
  project: ProjectOut; link: LinkOut; health: HealthOut; onUnlinked(link: LinkOut): void; onAct(): void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [check, setCheck] = useState<"busy" | { ok: boolean; text: string; warn?: boolean } | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  // Which filter a Check data answer belongs to: editing or saving the filter starts a new one, and
  // an answer for an older one is dropped.
  const checkRound = useRef(0);
  const forgetCheck = () => { checkRound.current += 1; setCheck(null); };
  // "Filter saved." goes after a while.
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), SAVED_FOR_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const value = draft ?? link.filter;
  const dirty = draft !== null && draft !== link.filter;
  const invalid = validFilter(value) !== null;
  const state = stateOf(health);
  const age = state === "unknown" ? null : ageNote(health.checked_at, Date.now());

  const save = async () => {
    if (!dirty || invalid || saving) return;
    onAct();
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
    onAct();
    const round = checkRound.current;
    setCheck("busy");
    const answer = (next: { ok: boolean; text: string; warn?: boolean }) => { if (round === checkRound.current) setCheck(next); };
    try {
      const out = await sourceFields(link.source_id, project.id);
      const labels = plural(out.labels.length, "label", "labels");
      const text = link.source_type === "loki"
        ? `${labels} visible to this project`
        : `${plural(out.metrics.length, "metric", "metrics")} and ${labels} visible to this project`;
      // Nothing visible is a warning, not a green answer: the project's filter may select nothing.
      const nothing = link.source_type === "loki" ? out.labels.length === 0 : out.metrics.length === 0 && out.labels.length === 0;
      answer(nothing ? { ok: true, warn: true, text: nothingVisibleWords(link.source_name) } : { ok: true, text });
    } catch (err) {
      answer({ ok: false, text: failure(err, "check again") });
    }
  };

  const unlink = async () => {
    if (unlinking) return;
    onAct();
    setUnlinking(true);
    setProblem(null);
    try {
      await unlinkSource(project.id, link.source_id);
      await invalidateMonitoring(client);
      onUnlinked(link);
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
            <i className={s.pip} aria-hidden="true" />{stateWords(health, link.source_type)}{age ? ` · ${age}` : ""}
          </span>
        </div>
        <div className={s.filterLine}>
          <FilterField value={value} origin={draft === null ? link.filter_origin : "user"} reason={null} forName={link.source_name}
            check={isQueryable(link.source_type) ? { sourceId: link.source_id, sourceName: link.source_name } : undefined}
            onChange={(v) => { setDraft(v); setSaved(false); forgetCheck(); }} />
          <button type="button" className={s.secondary} aria-label={`Save filter for ${link.source_name}`}
            aria-disabled={!dirty || invalid || saving || undefined} onClick={() => void save()}>
            {saving ? "Saving…" : "Save filter"}
          </button>
        </div>
        {mayMixClusters(project, link) && <p className={s.warn}>{mixedLinkWords(link.source_name)}</p>}
        <div className={s.rowActions}>
          {isQueryable(link.source_type) && (
            <button type="button" className={s.quiet} aria-label={`Check data for ${link.source_name}`}
              aria-disabled={check === "busy" || undefined} onClick={() => void runCheck()}>
              {check === "busy" ? "Checking…" : "Check data"}
            </button>
          )}
          <button type="button" className={s.quiet} aria-label={`Unlink ${link.source_name}`}
            aria-disabled={unlinking || undefined} onClick={() => void unlink()}>Unlink</button>
        </div>
        {saved && !dirty && <p className={s.ok} role="status">Filter saved.</p>}
        {check && check !== "busy" && <p className={check.warn ? s.warn : check.ok ? s.ok : s.bad} role={check.ok ? "status" : "alert"}>{check.text}</p>}
        {problem && <p className={s.bad} role="alert">{problem}</p>}
      </div>
    </li>
  );
}

function hostOf(url: string | null): string {
  try { return new URL(url ?? "").hostname; } catch { return ""; }
}
/** Whether a source's name already says where it is reached. */
function holdsWhere(x: SourceOut): boolean {
  const name = x.name.toLowerCase();
  const where = whereLabel(x).toLowerCase();
  if (where === "" || name.includes(where)) return true;
  const part = (x.reach === "cluster" ? x.service ?? "" : hostOf(x.url)).toLowerCase();
  return part !== "" && name.includes(part);
}
/** An option of the source picker: the name, and where the source is only when the name doesn't say. */
const optionWords = (x: SourceOut) => (holdsWhere(x) ? x.name : `${x.name} · ${whereLabel(x)}`);

/** Pick a saved source that is not linked yet and give it a filter (suggested where OmniKrux can tell). */
function ExistingPanel({ project, onClose, onLinked, onAct }: { project: ProjectOut; onClose(): void; onLinked(): void; onAct(): void }) {
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
  const chosen = choices.find((x) => x.id === sourceId);
  const adds = sourceId ? addsLine(project, chosen?.type) : null;
  // A Kubernetes project lists sources inside another cluster apart.
  const other = (x: SourceOut) => project.kind === "kubernetes" && project.cluster_id !== null && x.reach === "cluster" && x.cluster_id !== project.cluster_id;
  const here = choices.filter((x) => !other(x));
  const elsewhere = choices.filter(other);

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
    onAct();
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
              {here.map((x) => <option key={x.id} value={x.id}>{optionWords(x)}</option>)}
              {elsewhere.length > 0 && (
                <optgroup label="Other clusters">
                  {elsewhere.map((x) => <option key={x.id} value={x.id}>{optionWords(x)}</option>)}
                </optgroup>
              )}
            </select>
          </div>
          {sourceId && (
            <FilterField value={filter} origin={origin} reason={reason} forName="the new link"
              check={chosen && isQueryable(chosen.type) ? { sourceId: chosen.id, sourceName: chosen.name } : undefined}
              onChange={(v, o) => { touched.current = true; setFilter(v); setOrigin(o); }} />
          )}
          {adds && <p className={s.muted}>{`Linking it ${adds}`}</p>}
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

export default function ProjectPage({ view, tabId, nav, openInNewTab, leaveDeleted }: MonitoringPageProps) {
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
  const [linkedNote, setLinkedNote] = useState<{ projectId: string; sourceId: string; text: string } | null>(null);
  // The link just removed, kept for a while so Undo can put it back with the same filter and origin.
  const [unlinked, setUnlinked] = useState<{ projectId: string; link: LinkOut } | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (unlinked === null) return;
    const timer = window.setTimeout(() => {
      // The keyboard never falls onto <body> with the button.
      if (document.activeElement === undoButton.current) sourcesHeading.current?.focus();
      setUnlinked(null);
    }, UNDO_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [unlinked]);
  const settle = () => { setLinkedNote(null); setUnlinked(null); };
  const [review, setReview] = useState<ProjectDeleteReviewOut | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  // Setup created this project but couldn't import its dashboards: said once, as the page opens.
  const [importFailed] = useState(() => ({ id, message: importFailure(id) }));
  useEffect(() => { if (importFailed.message !== null) clearImportFailure(importFailed.id); }, [importFailed]);

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
  // Every failing source is reached through the one cluster, which can't be reached: said once here.
  const downCluster = unreachableCluster(project.links, health, (id) =>
    clusters.data?.find((c) => c.id === id)?.name ?? (project.cluster_id === id ? project.cluster_name : null));
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

  /** After a cluster rule's removal: the review is read again; a read that fails says so in the dialog. */
  const rereadReview = async () => {
    try {
      setReview(await projectDeleteReview(project.id));
      setReviewError(null);
    } catch (err) {
      setReviewError(`${STALE_REVIEW} ${failure(err, "try again")}`);
    }
  };

  const confirmDelete = async () => {
    if (!review || reviewBusy) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      await deleteProject(project.id, review.token);
      // The tab shows Home in place of this project, or closes onto the Home tab open already
      // (MonitoringApp hands the keyboard to the workspace).
      if (leaveDeleted) leaveDeleted();
      else nav.navigate(MONITORING_HOME, "replace");
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
  const linkNew = async (saved: SourceOut, info?: { failedTest: boolean }) => {
    const sourceId = saved.id;
    const adds = addsLine(project, saved.type);
    setPageError(null);
    setLinkedNote(null);
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
      setLinkedNote({ projectId: project.id, sourceId, text: `Linked ${saved.name}.${adds ? ` It ${adds}` : ""}${info?.failedTest ? " It didn't answer the last test, so its panels say so until it does." : ""}` });
    } catch (err) {
      setPageError(`The source was saved but could not be linked to this project: ${failure(err)} Use an existing source to link it.`);
      void invalidateMonitoring(client);
    }
    closePanel();
  };

  const undoUnlink = async () => {
    if (!unlinked) return;
    const { link } = unlinked;
    setUnlinked(null);
    sourcesHeading.current?.focus();
    try {
      await linkSource(project.id, link.source_id, link.filter, link.filter_origin);
    } catch (err) {
      setPageError(`Couldn't link ${link.source_name} again: ${failure(err, "link it again from Use an existing source")}`);
    }
    await invalidateMonitoring(client);
  };
  const unlinkedName = unlinked && unlinked.projectId === project.id && !project.links.some((l) => l.source_id === unlinked.link.source_id)
    ? unlinked.link.source_name : null;

  const linkedText = linkedNote && linkedNote.projectId === project.id && project.links.some((l) => l.source_id === linkedNote.sourceId)
    ? linkedNote.text : "";

  const open = (target: MonitoringView, e: { ctrlKey: boolean; metaKey: boolean }) =>
    e.ctrlKey || e.metaKey ? openInNewTab(target) : nav.navigate(target, "push");

  return (
    <section className={s.page} aria-labelledby="monitoring-project-title">
      <header className={s.head}>
        <EditableName key={project.id} name={project.name} titleId="monitoring-project-title" dot={projectDot(project)} onRename={rename} />
        <p className={s.sub}>{kindLine(project, clusterName)}</p>
        {clusterGone && <p className={s.warn}>Cluster no longer connected</p>}
      </header>

      {downCluster !== null && (
        <p className={s.bad} role="status">{`${downCluster} can't be reached, so this project's data can't be read now.`}</p>
      )}

      {pageError && <p className={s.bad} role="alert">{pageError}</p>}
      {/* Always mounted, so filling it is announced; shown only for this project while its source is still linked. */}
      <p className={s.live} role="status">{linkedText}</p>
      {importFailed.id === project.id && importFailed.message !== null && (
        <div className={s.importFailed} role="alert">
          <p>{importFailedWords(importFailed.message)}</p>
          <button type="button" className={s.secondary} onClick={(e) => open({ page: "import", target: { kind: "project", id: project.id } }, e)}>
            Import dashboards…
          </button>
        </div>
      )}

      <section aria-labelledby="monitoring-project-sources" className={s.section}>
        <h2 id="monitoring-project-sources" ref={sourcesHeading} tabIndex={-1} className={s.heading}>Sources</h2>
        {project.links.length === 0 && <p className={s.muted}>No sources yet. Use an existing one or add one by hand.</p>}
        {project.links.length > 0 && (
          <ul className={s.list}>
            {sortLinks(project.links).map((l) => (
              <LinkRow key={l.source_id} project={project} link={l} health={health[l.source_id] ?? UNKNOWN}
                onAct={settle}
                onUnlinked={(gone) => { setLinkedNote(null); setUnlinked({ projectId: project.id, link: gone }); sourcesHeading.current?.focus(); }} />
            ))}
          </ul>
        )}
        {unlinkedName !== null && (
          <p className={s.undo} role="status">
            Unlinked {unlinkedName}.{" "}
            <button ref={undoButton} type="button" className={s.quiet} onClick={() => void undoUnlink()}>Undo</button>
          </p>
        )}
        {adding === null ? (
          <div className={s.addRow}>
            <button ref={addExisting} type="button" className={s.secondary} onClick={() => { settle(); setAdding("existing"); }}>Use an existing source</button>
            <button ref={addHand} type="button" className={s.secondary} onClick={() => { settle(); setAdding("hand"); }}>Add a source by hand</button>
          </div>
        ) : adding === "existing" ? (
          <ExistingPanel project={project} onClose={closePanel} onLinked={closePanel} onAct={settle} />
        ) : (
          <div className={s.panel}>
            <SourceForm mode="save" closeOnEscape tabId={tabId} page="project" pageId={id} onSaved={(saved, info) => linkNew(saved, info)} onCancel={closePanel} />
          </div>
        )}
      </section>

      {project.kind === "kubernetes" && project.cluster_id !== null && !clusterGone && (
        <ProjectTools clusterId={project.cluster_id} clusterName={clusterName ?? project.cluster_id} nav={nav} openInNewTab={openInNewTab} />
      )}

      {(project.kind === "docker" || project.kind === "servers") && <ProjectGenerate project={project} />}

      <section aria-labelledby="monitoring-project-dashboards" className={s.section}>
        <div className={s.headRow}>
          <h2 id="monitoring-project-dashboards" className={s.heading}>Dashboards</h2>
          <ExportButton kind="project" id={project.id} label="Export project" name={project.name} />
          <ImportButton onOpen={(e) => open({ page: "import", target: { kind: "project", id: project.id } }, e)} />
        </div>
        <ProjectDashboardsSlot project={project} tabId={tabId} nav={nav} openInNewTab={openInNewTab} clusterDown={downCluster !== null} />
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
        <ProjectDeleteReview review={review} busy={reviewBusy} error={reviewError} clusterName={clusterName} restoreFocusTo={deleteButton}
          onOpenRule={(rule) => nav.navigate({ page: "alerts", rule }, "replace")}
          onReviewed={rereadReview}
          onCancel={() => { if (!reviewBusy) { setReview(null); setReviewError(null); } }} onConfirm={() => void confirmDelete()} />
      )}
    </section>
  );
}
