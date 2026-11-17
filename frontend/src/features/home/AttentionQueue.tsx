import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ResourceRow } from "../../api/types";
import type { TabNav } from "../shell/browserHistory";
import { kindView, type KubeView } from "../shell/workspace";
import { isFailing, NO_FILTER, rowKey, textColumn, type Territory } from "../territories/model";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import { connectionProblem } from "./incidentHealth";
import s from "./AttentionQueue.module.css";

export function AttentionQueue({ territories, nav, paneActive, searchRef, loading }: {
  territories: Territory[]; nav: TabNav<KubeView>; paneActive: boolean;
  searchRef: RefObject<HTMLInputElement | null>; loading: boolean;
}) {
  const saved = nav.view.page === "home" ? nav.view.attention : undefined;
  const [expanded, setExpanded] = useState(saved?.expanded ?? false);
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  const restored = useRef(false);
  const id = useId();
  const ready = territories.filter(t => t.state === "ready");
  const previews = ready.filter(t => t.failing > 0).map(t => {
    const rows: ResourceRow[] = [];
    for (const row of t.rows) {
      if (isFailing(row)) rows.push(row);
      if (rows.length === 5) break;
    }
    return { territory: t, rows };
  });
  const count = ready.reduce((n, t) => n + t.failing, 0);
  const unavailable = territories.filter(t => connectionProblem(t));
  const partial = ready.length !== territories.length;
  const returning = useRef(false);
  useLayoutEffect(() => {
    if (!paneActive) { restored.current = true; return; }
    const fallback = () => (heading.current ?? searchRef.current)?.focus();
    if (saved && !restored.current) {
      if (!returning.current) {
        returning.current = true;
        fallback();
      }
      const home = territories.find(t => t.cluster.id === saved.clusterId);
      const known = !loading && (!home || home.state === "ready" || connectionProblem(home) !== null);
      if (known) {
        restored.current = true;
        if (document.activeElement === heading.current || document.activeElement === searchRef.current) {
          const target = Array.from(section.current?.querySelectorAll<HTMLElement>("[data-attention-target]") ?? []).find(el => el.dataset.attentionTarget === saved.target);
          (target ?? heading.current ?? searchRef.current)?.focus();
        }
      }
    } else if (focused.current && !focused.current.isConnected && (document.activeElement === document.body || document.activeElement === null)) fallback();
  });
  const remember = (target: string, clusterId: string) => nav.navigate(v => v.page === "home" ? { ...v, attention: { expanded, target, clusterId } } : v, "replace");
  const openCluster = (t: Territory, failing = false) => {
    remember(`${failing ? "all" : "cluster"}:${t.cluster.id}`, t.cluster.id);
    nav.navigate(v => ({ ...kindView(v, "pods", [t.cluster.id]), filters: { ...NO_FILTER, status: failing ? "failing" : "all" } }), "push");
  };
  const openPod = (row: ResourceRow) => {
    remember(rowKey(row.cluster_id, row.uid), row.cluster_id);
    nav.navigate(v => ({ ...kindView(v, "pods", [row.cluster_id]), filters: { ...NO_FILTER, namespace: row.namespace }, selected: { clusterId: row.cluster_id, uid: row.uid }, open: true, fromAttention: { clusterId: row.cluster_id, uid: row.uid, namespace: row.namespace } }), "push");
  };
  if (!loading && !territories.length) return null;
  return <section ref={section} aria-labelledby={`${id}-heading`} className={s.queue} onFocusCapture={e => { focused.current = e.target as HTMLElement; }}>
    <h2 id={`${id}-heading`} ref={heading} tabIndex={-1}>Problems right now</h2>
    {unavailable.map(t => <button type="button" className={s.connection} key={t.cluster.id} data-attention-target={`cluster:${t.cluster.id}`} onClick={() => openCluster(t)}><ProviderBadge provider={knownProvider(t.cluster.provider)} /><b>{t.cluster.name}</b><span>{connectionProblem(t)}</span><span>Open cluster</span></button>)}
    {partial && ready.length > 0 && <p className={s.note}>Partial coverage: some clusters are updating or unavailable.</p>}
    {count > 0 ? <>
      <button type="button" className={s.disclosure} aria-expanded={expanded} aria-controls={`${id}-pods`} onClick={() => setExpanded(!expanded)}>{expanded ? "Hide" : "Show"} {count} failing Pods</button>
      {expanded && <div id={`${id}-pods`} className={s.pods}>{previews.map(({ territory: t, rows }) => <div key={t.cluster.id}>
        {rows.map(row => <button type="button" className={s.pod} key={row.uid} data-attention-target={rowKey(t.cluster.id, row.uid)} onClick={() => openPod(row)}><span aria-hidden="true" className={s.diamond}>◆</span><b>{row.name}</b><span>{row.namespace ?? "No namespace"}</span><span>{t.cluster.name}</span><span className={s.diamond}>{textColumn(row, "status") ?? "Failing"}</span></button>)}
        {t.failing > 5 && <button type="button" className={s.all} data-attention-target={`all:${t.cluster.id}`} aria-label={`View all ${t.failing} failing Pods in ${t.cluster.name}`} onClick={() => openCluster(t, true)}>View all {t.failing} failing Pods <span>in {t.cluster.name}</span></button>}
      </div>)}</div>}
    </> : <p className={s.note}>{!partial && !loading ? "No failing Pods" : !ready.length && unavailable.length === territories.length && !loading ? "Pod status unavailable" : "Waiting for live pod status"}</p>}
  </section>;
}
