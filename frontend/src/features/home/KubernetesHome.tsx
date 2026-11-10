import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CLUSTERS_QUERY_KEY, useClusters } from "../../api/useClusters";
import { useKinds } from "../../api/useKinds";
import { useWatch } from "../../api/useWatch";
import { failure } from "../../api/http";
import { useNow } from "../../hooks/useNow";
import { pageKey } from "../chrome/shortcuts";
import { usePinnedKinds } from "../settings/pinnedKinds";
import { kindView, type ClosedTab, type KubeView } from "../shell/workspace";
import type { TabNav } from "../shell/browserHistory";
import { tabLabel } from "../shell/tabLabel";
import { bandLocation } from "../territories/ClusterBand";
import { buildTerritories, kindTitle, NO_FILTER } from "../territories/model";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import { ClusterCard } from "./ClusterCard";
import { searchHome, type HomeResult } from "./homeSearch";
import s from "./KubernetesHome.module.css";

function closedTime(at: number, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 2880) return "yesterday";
  return `${Math.floor(minutes / 1440)} days ago`;
}

function ResultLabel({ result: r }: { result: HomeResult }) {
  if (r.group === "Clusters") return <><ProviderBadge provider={knownProvider(r.cluster.provider)} /><b>{r.cluster.name}</b><span>{bandLocation(r.cluster)}</span></>;
  if (r.group === "Kinds") return <><b>{kindTitle(r.kind)}</b><span>{r.kind.key}</span></>;
  if (r.group === "Pods") return <><b>{r.row.name}</b><span>{r.row.namespace ?? "No namespace"} · {r.cluster.name}</span></>;
  return <>Find "{r.text}" in {kindTitle(r.kind)}</>;
}

export interface KubernetesHomeProps {
  nav: TabNav<KubeView>;
  closed: readonly ClosedTab<KubeView>[];
  onReopen: (index: number) => void;
  loadProblem: string | null;
  onDismissLoadProblem: () => void;
  onEditPinned: () => void;
}

export function KubernetesHome({ nav, closed, onReopen, loadProblem, onDismissLoadProblem, onEditPinned }: KubernetesHomeProps) {
  const clusters = useClusters();
  const kinds = useKinds();
  const pinned = usePinnedKinds();
  const client = useQueryClient();
  const knownClusterIds = useMemo(() => clusters.data ? new Set(clusters.data.map(c => c.id)) : undefined, [clusters.data]);
  const watch = useWatch("pods", {
    knownClusterIds,
    onUnknownCluster: () => void clusters.refetch(),
    onClusterRemoved: () => void client.invalidateQueries({ queryKey: CLUSTERS_QUERY_KEY }),
  });
  const now = useNow(60_000);
  const territories = useMemo(() => buildTerritories(clusters.data ?? [], watch, NO_FILTER, now), [clusters.data, watch, now]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = useMemo(() => searchHome(query, { clusters: clusters.data ?? [], kinds: kinds.data?.kinds ?? [], pods: territories, pinned: pinned.pinned }), [query, clusters.data, kinds.data, territories, pinned.pinned]);
  const selected = Math.min(active, Math.max(0, results.length - 1));
  const searching = query.trim() !== "";
  const catalogIncomplete = kinds.data === undefined || kinds.isError;
  useEffect(() => {
    if (searching && results.length) document.getElementById(`${listId}-${selected}`)?.scrollIntoView?.({ block: "nearest" });
  }, [searching, results, listId, selected]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.altKey || event.ctrlKey || event.metaKey || !pageKey(event)) return;
      event.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const open = (result: HomeResult) => {
    nav.navigate(from => {
      if (result.group === "Clusters") return kindView(from, "pods", [result.cluster.id]);
      if (result.group === "Kinds") return kindView(from, result.kind.key, null);
      const view = kindView(from, result.group === "Pods" ? "pods" : result.kind.key, result.group === "Pods" ? [result.cluster.id] : null);
      if (view.page !== "kind") return view;
      return result.group === "Pods" ? { ...view, selected: { clusterId: result.cluster.id, uid: result.row.uid }, open: true }
        : { ...view, filters: { ...view.filters, text: result.text } };
    }, "push");
  };

  return <div className={s.viewport}><div className={s.home}>
    {loadProblem && <div role="alert" className={s.notice}>{loadProblem} <button type="button" onClick={onDismissLoadProblem}>Dismiss</button></div>}
    {pinned.loadProblem && <div role="alert" className={s.notice}>{pinned.loadProblem} <button type="button" aria-label="Dismiss pinned kinds notice" onClick={pinned.dismissLoadProblem}>Dismiss</button></div>}
    <h1>Where do you want to look?</h1>
    <p className={s.lede}>Search every cluster at once, or open one to start a tab.</p>
    <div className={s.searchArea}>
      <div className={s.search}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
        <input ref={input} role="combobox" aria-label="Search Kubernetes" aria-autocomplete="list" aria-expanded={searching} aria-controls={searching ? listId : undefined} aria-activedescendant={searching && results.length ? `${listId}-${selected}` : undefined}
          placeholder="Search pods, deployments, nodes or a cluster" maxLength={500} value={query}
          onChange={event => { setQuery(event.target.value.slice(0, 500)); setActive(0); }}
          onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); setQuery(""); setActive(0); }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive(results.length ? (selected + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0); }
            if (event.key === "Enter" && results[selected]) { event.preventDefault(); open(results[selected]); }
          }}/>
        <kbd aria-hidden="true">/</kbd>
      </div>
      {searching && <div className={s.resultsPanel}>
        <div id={listId} role="listbox" aria-label="Search results" className={s.results}>
          {(["Clusters", "Kinds", "Pods", "Find"] as const).map(group => {
            const entries = results.map((result, index) => ({ result, index })).filter(entry => entry.result.group === group);
            return entries.length ? <div role="group" aria-label={group} key={group}><div className={s.group} aria-hidden="true">{group}</div>{entries.map(({ result, index }) => <div key={index} id={`${listId}-${index}`} role="option" aria-selected={selected === index} className={s.result} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => open(result)}><ResultLabel result={result}/></div>)}</div> : null;
          })}
        </div>
        {catalogIncomplete && (kinds.isError
          ? <div role="alert" className={s.catalog}><span>Can't load the list of kinds: {failure(kinds.error, "try kinds again")}. Search results are incomplete.</span> <button type="button" disabled={kinds.isFetching} onClick={() => void kinds.refetch()}>Try kinds again</button></div>
          : <p role="status" className={s.empty}>Loading the list of kinds… Search results are incomplete.</p>)}
        {results.length === 0 && !catalogIncomplete && <p role="status" className={s.empty}>Nothing matches "{query.trim()}".</p>}
        {results.some(r => r.group === "Find") && <button type="button" className={s.edit} onClick={onEditPinned}>Edit pinned kinds…</button>}
      </div>}
    </div>
    <section aria-labelledby="home-clusters-heading">
      <h2 id="home-clusters-heading">Clusters</h2>
      {clusters.data === undefined ? clusters.isError ? <div role="alert" className={s.note}>Can't load clusters: {clusters.error.message} <button type="button" onClick={() => void clusters.refetch()}>Try again</button></div> : <p role="status" className={s.note}>Loading clusters…</p>
        : clusters.data.length === 0 ? <p className={s.note}>No clusters yet. Mount your kubeconfig at /kube/config and restart the console.</p>
        : <div className={s.cards}>{territories.map(territory => <ClusterCard key={territory.cluster.id} territory={territory} onOpen={() => open({ group: "Clusters", cluster: territory.cluster })}/>)}</div>}
    </section>
    {closed.length > 0 && <section aria-labelledby="home-recent-heading"><h2 id="home-recent-heading">Recently closed</h2><div className={s.recent}>{closed.map((entry, index) => <button type="button" key={entry.tab.id} onClick={() => onReopen(index)}><span>{tabLabel(entry.tab.view, { kinds: kinds.data?.kinds, clusters: clusters.data })}</span><span className={s.when}>{closedTime(entry.closedAt, now)}</span></button>)}</div></section>}
  </div></div>;
}
