import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { failure } from "../../api/http";
import { useClusters } from "../../api/useClusters";
import { useMonitoringTree, useProjects, useSourceHealth, useSources } from "../api/hooks";
import type { HealthOut, SourceOut } from "../api/types";
import type { MonitoringPageProps } from "../MonitoringApp";
import { buildSearchIndex, searchMonitoring, type SearchEntry } from "../search/search";
import type { MonitoringView } from "../shell/tabState";
import { FirstUse } from "./FirstUse";
import { GroupCard } from "./GroupCard";
import { ProjectCard, summarize } from "./ProjectCard";
import { readRecent } from "./recent";
import s from "./MonitoringHome.module.css";

/** Counts of the sources by what is known of them; a source nobody has checked is `unknown`. */
export function healthSummary(sources: SourceOut[], health: Record<string, HealthOut>): { up: number; down: number; unknown: number } {
  return summarize(sources, health);
}

const KIND_LABEL: Record<SearchEntry["kind"], string> = { project: "Project", group: "Group", source: "Source", dashboard: "Dashboard" };

/** Whether Home may take the keyboard as it appears: only when nothing else has it. */
function keyboardIsFree(): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body || active.tagName === "MAIN") return true;
  return active.closest("[data-monitoring-page]") !== null;
}

function HomeSearch({ index, mayFocus, onOpen }: { index: SearchEntry[]; mayFocus(): boolean; onOpen(view: MonitoringView, newTab: boolean): void }) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const hits = useMemo(() => searchMonitoring(index, text), [index, text]);
  const showing = open && text.trim() !== "";
  const current = Math.min(active, Math.max(0, hits.length - 1));
  // Asked when the search appears (after the data is in), so a key the user pressed meanwhile keeps the keyboard.
  useEffect(() => { if (mayFocus()) input.current?.focus(); }, [mayFocus]);

  const choose = (hit: SearchEntry, newTab: boolean) => {
    setText("");
    setActive(0);
    onOpen(hit.view, newTab);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && text !== "") {
      e.preventDefault();
      setText("");
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && hits.length) {
      e.preventDefault();
      setActive((current + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
    } else if (e.key === "Enter" && hits[current]) {
      e.preventDefault();
      choose(hits[current], e.ctrlKey || e.metaKey);
    }
  };
  return (
    <div className={s.search}>
      <svg className={s.searchIcon} viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-label="Search Monitoring"
        aria-expanded={showing}
        aria-controls={`${id}-hits`}
        aria-autocomplete="list"
        aria-activedescendant={showing && hits.length ? `${id}-hit-${current}` : undefined}
        placeholder="Search projects, groups and sources"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => { setText(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <div className={s.hits} hidden={!showing}>
        <ul id={`${id}-hits`} role="listbox" aria-label="Search results">
          {hits.map((hit, i) => (
            <li key={`${hit.kind}:${hit.id}`} id={`${id}-hit-${i}`} role="option" aria-selected={i === current} className={s.hit}
              onMouseDown={(e) => e.preventDefault()} onClick={(e) => choose(hit, e.ctrlKey || e.metaKey)}>
              <span className={s.hitName}>{hit.name}</span>
              <span className={s.hitSub}>{KIND_LABEL[hit.kind]} · {hit.subtitle}</span>
            </li>
          ))}
        </ul>
        {hits.length === 0 && <p className={s.noHits} role="status">No project, group or source matches “{text.trim()}”.</p>}
      </div>
    </div>
  );
}

/** A clock that moves every 30 seconds, so a reading's age keeps up. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function MonitoringHome({ nav, openInNewTab, onOpenSettings }: MonitoringPageProps) {
  const projects = useProjects();
  const tree = useMonitoringTree();
  const sources = useSources();
  const healthQuery = useSourceHealth();
  const clusters = useClusters();
  const now = useNow();

  const health = healthQuery.data ?? {};
  const clusterNames = useMemo(() => Object.fromEntries((clusters.data ?? []).map((c) => [c.id, c.name])), [clusters.data]);
  const index = useMemo(
    () => (tree.data ? buildSearchIndex({ tree: tree.data, sources: sources.data ?? [], clusterNames }) : []),
    [tree.data, sources.data, clusterNames],
  );

  const open = (view: MonitoringView, newTab: boolean) => (newTab ? openInNewTab(view) : nav.navigate(view, "push"));
  const setup = (clusterId?: string) => nav.navigate(clusterId ? { page: "setup", clusterId } : { page: "setup" }, "push");

  const failed = (projects.isError && !projects.data) || (tree.isError && !tree.data);
  if (failed) {
    const error = projects.error ?? tree.error;
    return (
      <section className={s.home}>
        <h1 className={s.title}>Monitoring</h1>
        <div className={s.note} role="alert">
          <p>{failure(error, "try again")}</p>
          <div className={s.actions}>
            <button type="button" className={s.primary} onClick={() => { void projects.refetch(); void tree.refetch(); }}>Try again</button>
          </div>
        </div>
      </section>
    );
  }
  if (!projects.data || !tree.data) {
    return (
      <section className={s.home} aria-busy="true">
        <h1 className={s.title}>Monitoring</h1>
        <p className={s.note} role="status">Loading projects…</p>
      </section>
    );
  }
  if (projects.data.length === 0) {
    return <FirstUse clusters={clusters} mayFocus={keyboardIsFree} onSetup={setup} onOpenSettings={onOpenSettings} />;
  }

  const projectById = new Map(projects.data.map((p) => [p.id, p]));
  const clusterLoaded = clusters.data !== undefined;
  const recent = readRecent().flatMap((r) => {
    if (r.kind === "project") {
      const p = projectById.get(r.id);
      return p ? [{ key: `project:${r.id}`, name: p.name, what: "Project", view: { page: "project", id: p.id } as MonitoringView }] : [];
    }
    if (r.kind === "group") {
      const g = tree.data.groups.find((x) => x.id === r.id);
      return g ? [{ key: `group:${r.id}`, name: g.name, what: "Group", view: { page: "group", id: g.id } as MonitoringView }] : [];
    }
    // A dashboard opens itself, as long as its owner still lists it.
    const owner = tree.data.projects.find((x) => x.dashboards.some((d) => d.id === r.id))
      ?? tree.data.groups.find((x) => x.dashboards.some((d) => d.id === r.id));
    const title = owner?.dashboards.find((d) => d.id === r.id)?.title;
    return title ? [{ key: `dashboard:${r.id}`, name: title, what: "Dashboard", view: { page: "dashboard", id: r.id } as MonitoringView }] : [];
  });

  return (
    <section className={s.home} aria-labelledby="monitoring-home-title">
      <h1 id="monitoring-home-title" className={s.title}>Monitoring</h1>
      <HomeSearch index={index} mayFocus={keyboardIsFree} onOpen={open} />
      <p className={s.quiet}><i className={s.quietDot} aria-hidden="true" />All quiet · no alert rules yet</p>
      {healthQuery.isError && !healthQuery.data && <p className={s.note} role="status">Source health couldn't be read, so it shows as not checked.</p>}

      {tree.data.groups.length > 0 && (
        <section aria-labelledby="monitoring-home-groups">
          <h2 id="monitoring-home-groups" className={s.heading}>Groups</h2>
          <div className={s.cards}>
            {tree.data.groups.map((g) => {
              const ids = [...new Set(g.project_ids.flatMap((pid) => projectById.get(pid)?.links.map((l) => l.source_id) ?? []))];
              return <GroupCard key={g.id} name={g.name} projectCount={g.project_ids.length} sourceIds={ids} health={health} now={now}
                onOpen={(t) => open({ page: "group", id: g.id }, t)} />;
            })}
          </div>
        </section>
      )}

      <section aria-labelledby="monitoring-home-projects">
        <h2 id="monitoring-home-projects" className={s.heading}>Projects</h2>
        <div className={s.cards}>
          {projects.data.map((p) => {
            const gone = clusterLoaded && p.kind === "kubernetes" && p.cluster_id !== null && !clusters.data!.some((c) => c.id === p.cluster_id);
            const name = gone ? null : (p.cluster_name ?? (p.cluster_id ? (clusterNames[p.cluster_id] ?? null) : null));
            return <ProjectCard key={p.id} project={p} health={health} now={now} clusterName={name} clusterGone={gone}
              onOpen={(t) => open({ page: "project", id: p.id }, t)} />;
          })}
        </div>
      </section>

      {recent.length > 0 && (
        <section aria-labelledby="monitoring-home-recent">
          <h2 id="monitoring-home-recent" className={s.heading}>Recently opened</h2>
          <ul className={s.recent}>
            {recent.map((r) => (
              <li key={r.key}>
                <button type="button" className={s.recentItem} onClick={(e) => open(r.view, e.ctrlKey || e.metaKey)}>
                  <span className={s.recentName}>{r.name}</span>
                  <span className={s.recentWhat}>{r.what}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
