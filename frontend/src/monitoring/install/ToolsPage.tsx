// The Monitoring tools page: what OmniKrux installed in a cluster, read live (Helm's release
// records and the workloads), with the reviews to install, update and uninstall it.
//
// Honest state only. The page says when it read; a read that failed says so in words and shows no
// release, never the last good answer. It reads again every 3 s while a job runs and every 30 s
// otherwise (not while the window is hidden), and after the reviews it opened, but not after
// unrelated Monitoring changes: its query lives outside the "monitoring" keys on purpose.

import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { useClusters } from "../../api/useClusters";
import type { MonitoringPageProps } from "../MonitoringApp";
import { keyboardIsFree } from "../pages/Gone";
import { installStatus, type Component, type InstallOut, type InstallStatusOut, type ReleaseOut, type ToolType } from "./api";
import { InstallProgress } from "./InstallProgress";
import { componentState, COMPONENTS, isBusy, readAt, RELEASE_MISSING, type ComponentState } from "./toolsModel";
import { useInstallReviews } from "./useInstallReviews";
import s from "./ToolsPage.module.css";

export const POLL_RUNNING_MS = 3000;
export const POLL_IDLE_MS = 30_000;
/** A read this young is shown as it is when the page opens again. */
const STALE_MS = 10_000;

export const toolsKey = (clusterId: string) => ["install-live", clusterId] as const;

type Tone = "ok" | "bad" | "warn" | "plain";
type Click = (e: MouseEvent<HTMLElement>) => void;

const TOOL_WORDS: Record<ToolType, string> = { prometheus: "Prometheus", alertmanager: "Alertmanager", loki: "Loki" };
const COMPONENT_WORDS: Record<Component, string> = { metrics: "Metrics", logs: "Logs" };
const STATE_WORDS: Record<ComponentState, string> = { installed: "Installed", missing: "Not installed", failing: "Not healthy", busy: "Working" };
const STATE_TONE: Record<ComponentState, Tone> = { installed: "ok", missing: "plain", failing: "bad", busy: "warn" };

type Charts = InstallStatusOut["tools"]["charts"];
const WHAT: Record<Component, { what: string; versions(charts: Charts): string }> = {
  metrics: {
    what: "Prometheus, Alertmanager, node-exporter and kube-state-metrics",
    versions: (c) => {
      const v = c.find((x) => x.key === "kube-prometheus-stack")?.version;
      return v ? `kube-prometheus-stack ${v}` : "kube-prometheus-stack";
    },
  },
  logs: {
    what: "Loki and Grafana Alloy, which collects Pod logs",
    versions: (c) => {
      const loki = c.find((x) => x.key === "loki")?.app_version;
      const alloy = c.find((x) => x.key === "alloy")?.app_version;
      return `loki${loki ? ` ${loki}` : ""} · alloy${alloy ? ` ${alloy}` : ""}`;
    },
  },
};

const unavailableWords = (message: string | null) => `Installing isn't available here: ${message ?? "OmniKrux can't install tools in this cluster."}`;

function headline(install: InstallOut): string {
  switch (install.state) {
    case "installed": return `Installed by OmniKrux in ${install.namespace}`;
    case "installing": return "Installing…";
    case "failed": return "The last install failed";
    case "cancelled": return "The last install was cancelled";
    case "uninstalling": return "Uninstalling…";
  }
}

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={s.chip} data-tone={tone}>{children}</span>;
}

function helmTone(r: ReleaseOut): Tone {
  if (r.status === "deployed") return "ok";
  return r.status === RELEASE_MISSING || r.status === "failed" ? "bad" : "warn";
}

function ReleaseRows({ releases }: { releases: ReleaseOut[] }) {
  return (
    <table className={s.table} aria-label="Installed tools">
      <thead>
        <tr><th scope="col">Tool</th><th scope="col">Chart</th><th scope="col">Helm</th><th scope="col">Workloads</th></tr>
      </thead>
      <tbody>
        {releases.map((r) => (
          <tr key={r.release}>
            <th scope="row" className={s.tool}>{r.label}</th>
            <td className={s.mono}>{r.version ? `${r.chart} ${r.version}` : r.chart}</td>
            <td><Chip tone={helmTone(r)}>Helm: {r.status}</Chip></td>
            <td>
              <ul className={s.workloads}>
                {r.workloads.map((w) => (
                  <li key={`${w.kind}/${w.name}`}>
                    <span className={s.wname}>{w.label}</span>
                    <span className={s.ready} data-ok={w.desired > 0 && w.ready >= w.desired ? "" : undefined}>{w.ready} of {w.desired} ready</span>
                    {w.why && <span className={s.why}>{w.why}</span>}
                  </li>
                ))}
              </ul>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface Gate {
  /** Whether OmniKrux can install here at all. */
  available: boolean;
  /** Whether no job is running. */
  idle: boolean;
  /** The words for a disabled install button. */
  title: string | undefined;
}

function Action({ label, gate, kind, onClick }: { label: string; gate: Gate; kind: "primary" | "secondary" | "danger"; onClick: Click }) {
  return (
    <button type="button" className={s[kind]} disabled={!gate.available || !gate.idle} title={!gate.available ? gate.title : undefined} onClick={onClick}>
      {label}
    </button>
  );
}

export default function ToolsPage({ view, nav, openInNewTab }: MonitoringPageProps) {
  const clusterId = view.page === "tools" ? view.clusterId : "";
  const reviews = useInstallReviews();
  const clusters = useClusters().data;
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const query = useQuery<InstallStatusOut>({
    queryKey: toolsKey(clusterId),
    queryFn: () => installStatus(clusterId),
    staleTime: STALE_MS,
    retry: false,
    refetchInterval: (q) => {
      // A failed read still asks again, at the slow pace.
      const data = q.state.status === "error" ? undefined : q.state.data;
      return data && isBusy(data) ? POLL_RUNNING_MS : POLL_IDLE_MS;
    },
  });
  const refetch = query.refetch;
  const read = useCallback(() => { void refetch(); }, [refetch]);

  // The last answer counts only while it is the latest: a failed read shows no old tools.
  const status = query.isError ? undefined : query.data;
  const readError = query.isError ? failure(query.error, "try again") : null;
  const clusterName = status?.cluster_name ?? clusters?.find((c) => c.id === clusterId)?.name ?? "this cluster";

  // The heading takes the keyboard as the page opens, and again when what held it is gone.
  useEffect(() => {
    if (keyboardIsFree()) heading.current?.focus();
  }, [clusterId]);
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) heading.current?.focus();
  });

  const [closedJobs, setClosedJobs] = useState<string[]>([]);
  const ended = useRef<string | null>(null);

  const install = status?.install ?? null;
  const unavailable = status && !status.tools.available ? unavailableWords(status.tools.message) : null;
  const gate: Gate = { available: status?.tools.available === true, idle: status !== undefined && !isBusy(status), title: unavailable ?? undefined };

  /** Opens a review from a button, then reads the cluster again whatever came of it. */
  const review = (open: (from: HTMLElement) => Promise<unknown>): Click => (e) => {
    void open(e.currentTarget).finally(() => { if (alive.current) read(); });
  };
  const runInstall = (components: Component[]) => review((from) => reviews.install({ clusterId, components, focusAfter: from }));

  const openSource = (sourceId: string, newTab: boolean) => {
    const target = { page: "source", id: sourceId } as const;
    if (newTab) openInNewTab(target);
    else nav.navigate(target, "push");
  };

  const others = status && status.others.length > 0 && (
    <div className={s.others}>
      <ul className={s.otherList}>
        {status.others.map((t) => (
          <li key={`${t.type}:${t.namespace}/${t.service}`}>
            {status.cluster_name} already runs {TOOL_WORDS[t.type as ToolType] ?? t.type} at {t.namespace}/{t.service}. You can connect it instead of installing another.
          </li>
        ))}
      </ul>
      <button type="button" className={s.secondary} onClick={() => nav.navigate({ page: "setup", clusterId }, "push")}>Use it in a project</button>
    </div>
  );

  let body: ReactNode = null;
  if (status && !status.problem) {
    body = install === null
      ? <FreshInstall charts={status.tools.charts} gate={gate} onReview={runInstall} others={others} />
      : (
        <Installed status={status} install={install} others={others} gate={gate}
          closed={install.job_id !== null && closedJobs.includes(install.job_id)}
          onCloseProgress={() => {
            if (install.job_id) setClosedJobs((x) => [...x, install.job_id as string]);
            heading.current?.focus();
            read();
          }}
          onOutcome={() => {
            if (ended.current !== install.job_id) {
              ended.current = install.job_id;
              read();
            }
          }}
          onMissing={runInstall(COMPONENTS.filter((c) => componentState(status, c) === "missing"))}
          onAgain={runInstall(install.components)}
          onUninstall={review((from) => reviews.uninstall(clusterId, from))}
          onContacts={review((from) => reviews.contacts(clusterId, from))}
          onSource={openSource} />
      );
  }

  const problem = readError ?? status?.problem ?? null;
  const when = status ? readAt(status.checked_at) : null;
  return (
    <section className={s.page} aria-labelledby={`${id}-h`} aria-busy={query.isFetching || undefined}>
      <header className={s.head}>
        <h1 id={`${id}-h`} ref={heading} tabIndex={-1} className={s.title}>Monitoring tools in {clusterName}</h1>
        {status && (
          <div className={s.readLine}>
            {when && <span className={s.read}>Read {when}</span>}
            <button type="button" className={s.quiet} onClick={read}>Refresh</button>
          </div>
        )}
      </header>
      {query.isPending && <p className={s.note} role="status">Reading the tools in {clusterName}…</p>}
      {problem && (
        <div className={s.problem} role="alert">
          <p>{problem}</p>
          <button type="button" className={s.secondary} onClick={read}>Try again</button>
        </div>
      )}
      {unavailable && !problem && <p className={s.warn} role="status">{unavailable}</p>}
      {body}
    </section>
  );
}

// --- No install ------------------------------------------------------------------------------

function FreshInstall({ charts, gate, onReview, others }: {
  charts: Charts;
  gate: Gate;
  onReview(components: Component[]): Click;
  others: ReactNode;
}) {
  const [picked, setPicked] = useState<Component[]>([]);
  const pick = (c: Component, on: boolean) => setPicked((now) => COMPONENTS.filter((x) => (x === c ? on : now.includes(x))));
  return (
    <>
      <p className={s.lead}>OmniKrux hasn&apos;t installed anything in this cluster.</p>
      <div className={s.choices} role="group" aria-label="What to install">
        {COMPONENTS.map((c) => (
          <label key={c} className={s.choice} data-on={picked.includes(c) ? "" : undefined}>
            <input type="checkbox" className={s.box} checked={picked.includes(c)} onChange={(e) => pick(c, e.target.checked)} />
            <span className={s.choiceText}>
              <span className={s.choiceName}>{COMPONENT_WORDS[c]}</span>
              <span className={s.choiceWhat}>{WHAT[c].what}</span>
              <span className={s.mono}>{WHAT[c].versions(charts)}</span>
            </span>
          </label>
        ))}
      </div>
      <div className={s.actions}>
        <button type="button" className={s.primary} disabled={picked.length === 0 || !gate.available || !gate.idle}
          title={!gate.available ? gate.title : undefined} onClick={onReview(picked)}>
          Review install…
        </button>
      </div>
      {others}
    </>
  );
}

// --- With an install -------------------------------------------------------------------------

function Installed({ status, install, others, gate, closed, onCloseProgress, onOutcome, onMissing, onAgain, onUninstall, onContacts, onSource }: {
  status: InstallStatusOut;
  install: InstallOut;
  others: ReactNode;
  gate: Gate;
  closed: boolean;
  onCloseProgress(): void;
  onOutcome(): void;
  onMissing: Click;
  onAgain: Click;
  onUninstall: Click;
  onContacts: Click;
  onSource(id: string, newTab: boolean): void;
}) {
  const states = COMPONENTS.map((c) => [c, componentState(status, c)] as const);
  const missing = install.state === "installed" && states.some(([, st]) => st === "missing");
  const failedOrCancelled = install.state === "failed" || install.state === "cancelled";
  const running = install.state === "installing" || install.state === "uninstalling";
  const connected = (Object.keys(install.sources) as ToolType[]).filter((t) => install.sources[t] !== null);
  const contacts = install.contacts;
  return (
    <>
      <div className={s.summary}>
        <p className={s.state} data-state={install.state}>{headline(install)}</p>
        {install.message && <p className={s.message}>{install.message}</p>}
      </div>

      {running && install.job_id && !closed && (
        <div className={s.progress}>
          <InstallProgress key={install.job_id} jobId={install.job_id} action={install.state === "uninstalling" ? "uninstall" : "install"}
            onClose={onCloseProgress} onOutcome={onOutcome} />
        </div>
      )}

      {install.state === "installed" && (
        <ul className={s.states} aria-label="Components">
          {states.map(([c, st]) => (
            <li key={c}><span className={s.stateName}>{COMPONENT_WORDS[c]}</span><Chip tone={STATE_TONE[st]}>{STATE_WORDS[st]}</Chip></li>
          ))}
        </ul>
      )}

      {status.releases.length > 0 && <ReleaseRows releases={status.releases} />}

      {connected.length > 0 && (
        <div className={s.row}>
          <span className={s.rowLabel}>Sources</span>
          <ul className={s.sourceList}>
            {connected.map((t) => {
              const ref = install.sources[t];
              return ref && (
                <li key={t}>
                  <button type="button" className={s.link} onClick={(e) => onSource(ref.id, e.ctrlKey || e.metaKey)}>{ref.name}</button>
                  <span className={s.sourceType}>{TOOL_WORDS[t]}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className={s.row}>
        <span className={s.rowLabel}>Contact points</span>
        <span className={s.contactsText} data-state={contacts.state}>
          {contacts.state === "none" && "No alert rules here send to contact points yet."}
          {contacts.state === "in_sync" && `Up to date · ${contacts.contact_points} contact points for ${contacts.rules} rules`}
          {contacts.state === "needs_review" && "Changed since the last review"}
          {contacts.state === "failed" && `Couldn't be updated: ${contacts.message ?? "no reason was given."}`}
        </span>
        {contacts.state === "needs_review" && <button type="button" className={s.secondary} onClick={onContacts}>Review</button>}
        {contacts.state === "failed" && <button type="button" className={s.secondary} onClick={onContacts}>Try again</button>}
      </div>

      {!running && (
        <div className={s.actions}>
          {missing && <Action label="Install what's missing…" gate={gate} kind="primary" onClick={onMissing} />}
          {install.update_available && <Action label="Update to the shipped versions…" gate={gate} kind={missing ? "secondary" : "primary"} onClick={onAgain} />}
          {failedOrCancelled && <Action label="Install again…" gate={gate} kind="primary" onClick={onAgain} />}
          <Action label="Uninstall monitoring tools…" gate={gate} kind="danger" onClick={onUninstall} />
        </div>
      )}
      {others}
    </>
  );
}
