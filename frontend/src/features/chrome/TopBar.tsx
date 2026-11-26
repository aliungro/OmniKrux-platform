import type { ReactNode } from "react";
import type { Territory } from "../territories/model";
import { ProviderBadge } from "../territories/ProviderBadge";
import { capsOf } from "./shortcuts";
import k from "./key.module.css";
import s from "./TopBar.module.css";

/** What a scope token needs: the cluster plus its live state and failing count. */
export type ScopeCluster = Pick<Territory, "cluster" | "state" | "message" | "failing" | "discoveryFailed">;

function tokenStatus(c: ScopeCluster): string | undefined {
  if (c.state === "error") return c.message ?? "This cluster reported an error without details";
  if (c.state === "syncing" && c.message) return c.message;
  // Absent: the cluster lacks this kind, or (Ruling R36) couldn't read its API group.
  if (c.state === "absent") return c.discoveryFailed ?? c.message ?? undefined;
  if (c.state !== "ready") return "Connecting…";
  return undefined;
}

function tokenTitle(c: ScopeCluster): string | undefined {
  const account = c.cluster.source === "cloud" ? c.cluster.cloud?.account_name : undefined;
  return [account, tokenStatus(c)].filter(Boolean).join("\n") || undefined;
}

/** The box's name while it opens the command palette (a dialog); an app's own box names itself. */
const PALETTE_LABEL = "Commands and kinds";

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r="9" fill="none" stroke="var(--focus)" strokeWidth="2" />
      <path d="M11 1v20M2 11c4 3 14 3 18 0" fill="none" stroke="var(--focus)" strokeWidth="2" />
    </svg>
  );
}

export function TopBar({
  clusters,
  forwards,
  onAudit,
  auditOpen = false,
  onPalette, appName, nav,
  hint = "pods, deploy, svc, helm…", label = PALETTE_LABEL, prompt = capsOf("kinds")[0], keys = "Control+K :",
}: {
  clusters: ScopeCluster[];
  appName?: string;
  nav?: { back:()=>void; forward:()=>void; canBack:boolean; canForward:boolean };
  /** The port-forwards control, drawn while any forward exists. */
  forwards?: ReactNode;
  /** Opens the audit log view; without it there is no button. */
  onAudit?: () => void;
  auditOpen?: boolean;
  /** Opens the command palette (in Monitoring, its Find); without it the box is a quiet placeholder. */
  onPalette?: () => void;
  /** The box's words, its name, the key drawn before them and its aria-keyshortcuts (an app's own box). */
  hint?: string;
  label?: string;
  prompt?: string;
  keys?: string;
}) {
  return (
    <header className={s.top} data-page-keys>
      <div className={s.logo}>
        {appName ?? <><Logo /> OmniKrux</>}
      </div>
      {nav && <><button className={s.audit} aria-label="Back" title="Back (Alt ←)" disabled={!nav.canBack} onClick={nav.back}>←</button><button className={s.audit} aria-label="Forward" title="Forward (Alt →)" disabled={!nav.canForward} onClick={nav.forward}>→</button></>}
      {clusters.length > 0 && (
        <div className={s.scope}>
          <span className={s.lbl}>Showing</span>
          {clusters.slice(0,4).map((c) => (
            <span
              key={c.cluster.id}
              className={s.tok}
              data-testid="scope-token"
              data-state={c.state}
              title={tokenTitle(c)}
            >
              <ProviderBadge provider={c.cluster.provider} />
              <span className={s.name}>{c.cluster.name}</span>
              {c.failing > 0 && (
                <span className={s.cnt}>
                  {c.failing}
                  <span className={s.sr}> failing</span>
                </span>
              )}
            </span>
          ))}
          {clusters.length > 4 && <span className={s.tok} title={clusters.slice(4).map(c=>c.cluster.name).join(", ")}>+{clusters.length-4}</span>}
        </div>
      )}
      <div className={s.tools}>
        {forwards}
        {onAudit && (
          <button type="button" className={s.audit} aria-pressed={auditOpen} onClick={onAudit}>
            Audit log
          </button>
        )}
      </div>
      {onPalette ? (
        <button
          type="button"
          className={`${s.cmd} ${s.live}`}
          aria-label={label}
          aria-haspopup={label === PALETTE_LABEL ? "dialog" : undefined}
          aria-keyshortcuts={keys}
          onClick={onPalette}
        >
          <b className={s.prompt} aria-hidden="true">{prompt}</b>
          <span className={s.hint}>{hint}</span>
          <span className={`${k.k} ${s.cap}`} aria-hidden="true">{capsOf("palette")[0]}</span>
        </button>
      ) : (
        <div className={s.cmd} aria-hidden="true">
          {hint}
        </div>
      )}
    </header>
  );
}
