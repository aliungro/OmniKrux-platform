// The project page's Monitoring tools section (Kubernetes projects): what OmniKrux installed in the
// project's cluster, read live, with the way to the cluster's Monitoring tools page. Honest state:
// a read that failed says so and shows nothing old as current.

import { useCallback, useRef, useState, type MouseEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { createSource, linkSource, listSources } from "../api/client";
import { invalidateMonitoring } from "../api/hooks";
import type { ProjectOut, SourceOut } from "../api/types";
import { GenerateTools, type AnsweredTools } from "../install/GenerateTools";
import { installKeys, installStatus, type InstallStatusOut } from "../install/api";
import { componentState } from "../install/toolsModel";
import type { MonitoringPageProps } from "../MonitoringApp";
import { answeredLabel, answeredSource } from "../setup/setupModel";
import s from "./ProjectPage.module.css";

/** How the install stands, in words. */
export function toolsStateWords(status: InstallStatusOut): string {
  const install = status.install;
  if (install === null) return "";
  switch (install.state) {
    case "installing": return "Installing…";
    case "uninstalling": return "Uninstalling…";
    case "failed": return "The last install failed";
    case "cancelled": return "The last install was cancelled";
    case "installed": {
      const states = install.components.map((c) => componentState(status, c));
      if (states.includes("failing")) return "Not healthy";
      if (states.includes("missing")) return "Something is missing";
      return "Running";
    }
  }
}

/** The pip's tone beside those words. */
function toolsTone(status: InstallStatusOut): "ok" | "bad" | "warn" | "plain" {
  const state = status.install?.state;
  if (state === "installing" || state === "uninstalling") return "warn";
  if (state === "failed") return "bad";
  if (state !== "installed") return "plain";
  const words = toolsStateWords(status);
  return words === "Running" ? "ok" : words === "Not healthy" ? "bad" : "warn";
}

export function ProjectTools({ clusterId, clusterName, nav, openInNewTab }: {
  clusterId: string;
  clusterName: string;
  nav: MonitoringPageProps["nav"];
  openInNewTab: MonitoringPageProps["openInNewTab"];
}) {
  const query = useQuery({ queryKey: installKeys.status(clusterId), queryFn: () => installStatus(clusterId), retry: false });
  const status = query.isError ? undefined : query.data;
  const openTools = (e: MouseEvent<HTMLButtonElement>) => {
    const target = { page: "tools", clusterId } as const;
    if (e.ctrlKey || e.metaKey) openInNewTab(target);
    else nav.navigate(target, "push");
  };

  return (
    <section aria-labelledby="monitoring-project-tools" className={s.section}>
      <h2 id="monitoring-project-tools" className={s.heading}>Monitoring tools</h2>
      {query.isPending && <p className={s.muted} role="status">Reading the tools in {clusterName}…</p>}
      {query.isError && (
        <div className={s.toolsLine}>
          <p className={s.toolsText}>Couldn&apos;t read the monitoring tools: {failure(query.error, "try again")}</p>
          <button type="button" className={s.quiet} onClick={() => void query.refetch()}>Try again</button>
        </div>
      )}
      {status?.problem && (
        <div className={s.toolsLine}>
          <p className={s.toolsText}>{status.problem}</p>
          <button type="button" className={s.secondary} onClick={openTools}>Open Monitoring tools</button>
        </div>
      )}
      {status && !status.problem && status.install === null && (
        <div className={s.toolsLine}>
          <p className={s.toolsText}>OmniKrux hasn&apos;t installed anything in {clusterName}.</p>
          <button type="button" className={s.secondary} onClick={openTools}>Install what&apos;s missing…</button>
        </div>
      )}
      {status && !status.problem && status.install !== null && (
        <div className={s.toolsLine}>
          <p className={s.toolsText} data-tone={toolsTone(status)}>
            <i className={s.pip} aria-hidden="true" />
            {`Installed by OmniKrux in ${status.install.namespace} · ${toolsStateWords(status)}`}
          </p>
          <button type="button" className={s.secondary} onClick={openTools}>Open Monitoring tools</button>
        </div>
      )}
    </section>
  );
}

/** Whether a source already reaches this tool at this address (no sign-in): it is reused, not made again. */
const reaches = (x: SourceOut, t: AnsweredTools[number]): boolean => x.reach === "url" && x.type === t.type && x.url === t.url && x.auth.type === "none";

type Connection = { state: "idle" | "pending" | "done" | "failed"; connected: number; failed: { name: string; why: string }[] };

/**
 * A Docker or servers project's Monitoring tools: the generator, and once the tools answer each one
 * becomes a source of this project (filter empty). A source that already reaches the address is
 * reused, never made twice; one tool failing doesn't stop the others, and what failed is named.
 */
export function ProjectGenerate({ project }: { project: ProjectOut }) {
  const client = useQueryClient();
  const kind = project.kind === "servers" ? "servers" : "docker";
  const [conn, setConn] = useState<Connection>({ state: "idle", connected: 0, failed: [] });
  const tools = useRef<AnsweredTools>([]);
  const linked = useRef(new Set<string>());
  linked.current = new Set(project.links.map((l) => l.source_id));
  const running = useRef(false);
  const projectId = project.id;

  const connect = useCallback(async (answered: AnsweredTools) => {
    if (running.current) return;
    running.current = true;
    tools.current = answered;
    setConn({ state: "pending", connected: 0, failed: [] });
    let connected = 0;
    const failed: Connection["failed"] = [];
    let known: SourceOut[] | null = null;
    for (const t of answered) {
      try {
        known ??= await listSources();
        let source = known.find((x) => reaches(x, t));
        if (!source) {
          source = await createSource(answeredSource(t));
          known.push(source);
        }
        if (!linked.current.has(source.id)) await linkSource(projectId, source.id, "", "none");
        connected += 1;
      } catch (err) {
        failed.push({ name: answeredLabel(t), why: failure(err, "try again") });
      }
    }
    try { await invalidateMonitoring(client); } catch { /* the lists refresh on their own */ }
    running.current = false;
    setConn({ state: failed.length === 0 ? "done" : "failed", connected, failed });
  }, [client, projectId]);

  const said = conn.state === "done" || conn.state === "failed"
    ? (conn.connected > 0 ? `Connected ${conn.connected} ${conn.connected === 1 ? "source" : "sources"} to ${project.name}.` : "")
    : "";
  return (
    <section aria-labelledby="monitoring-project-tools" className={s.section}>
      <h2 id="monitoring-project-tools" className={s.heading}>Monitoring tools</h2>
      <GenerateTools kind={kind} onAnswered={(t) => void connect(t)} connected={conn.state === "idle" ? "done" : conn.state === "pending" ? "pending" : conn.state} />
      <p className={s.ok} role="status">{said}</p>
      {conn.state === "failed" && (
        <div className={s.toolsLine} role="alert">
          <div>
            {conn.failed.map((f) => <p key={f.name} className={s.toolsText}>{`Couldn't connect ${f.name}: ${f.why}`}</p>)}
          </div>
          <button type="button" className={s.secondary} onClick={() => void connect(tools.current)}>Try again</button>
        </div>
      )}
    </section>
  );
}
