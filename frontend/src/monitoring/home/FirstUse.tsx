import { useEffect, useRef } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { Cluster } from "../../api/types";
import { DOT } from "../sidebar/Sidebar";
import s from "./MonitoringHome.module.css";

interface Props {
  clusters: UseQueryResult<Cluster[]>;
  /** Whether the keyboard is free for the first button as it appears. */
  mayFocus(): boolean;
  onSetup(clusterId?: string): void;
  onOpenSettings(): void;
}

/** No project yet: a way to make the first one, from a known cluster in one click. */
export function FirstUse({ clusters, mayFocus, onSetup, onOpenSettings }: Props) {
  const first = useRef<HTMLButtonElement>(null);
  const list = clusters.data;
  useEffect(() => { if (mayFocus()) first.current?.focus(); }, [mayFocus, list?.length]);

  return (
    <section className={s.first} aria-labelledby="monitoring-first-title">
      <h1 id="monitoring-first-title" className={s.title}>Set up your first project</h1>
      <p className={s.lede}>A project gathers the sources for one thing you run, like a cluster, and shows only its own data.</p>
      {clusters.isPending && <p className={s.note} role="status">Loading clusters…</p>}
      {clusters.isError && !list && (
        <div className={s.note} role="alert">
          <p>{clusters.error.message}</p>
          <div className={s.actions}>
            <button ref={first} type="button" className={s.secondary} onClick={() => void clusters.refetch()}>Try again</button>
            <button type="button" className={s.primary} onClick={() => onSetup()}>Set up a project</button>
          </div>
        </div>
      )}
      {list && list.length > 0 && (
        <div className={s.starts}>
          {list.map((c, i) => (
            <button key={c.id} ref={i === 0 ? first : undefined} type="button" className={s.start} onClick={() => onSetup(c.id)}>
              <i className={s.dot} style={{ background: c.provider in DOT ? DOT[c.provider] : DOT.custom }} aria-hidden="true" />
              <span className={s.startName}>{c.name}</span>
              <span className={s.startSub}>Kubernetes cluster</span>
            </button>
          ))}
          <button type="button" className={`${s.start} ${s.startOther}`} onClick={() => onSetup()}>Something else…</button>
        </div>
      )}
      {list && list.length === 0 && (
        <div className={s.note}>
          <p>No Kubernetes clusters are connected yet. Add one in Settings, or set up a project for anything else.</p>
          <div className={s.actions}>
            <button ref={first} type="button" className={s.secondary} onClick={onOpenSettings}>Open Settings</button>
            <button type="button" className={s.primary} onClick={() => onSetup()}>Set up a project</button>
          </div>
        </div>
      )}
    </section>
  );
}
