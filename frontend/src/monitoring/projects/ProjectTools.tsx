// The project page's Monitoring tools section (Kubernetes projects): what OmniKrux installed in the
// project's cluster, read live, with the way to the cluster's Monitoring tools page. Honest state:
// a read that failed says so and shows nothing old as current.

import type { MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { installKeys, installStatus, type InstallStatusOut } from "../install/api";
import { componentState } from "../install/toolsModel";
import type { MonitoringPageProps } from "../MonitoringApp";
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
