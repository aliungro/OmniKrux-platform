import type { Territory } from "../territories/model";
import { ProviderBadge } from "../territories/ProviderBadge";
import k from "./key.module.css";
import s from "./TopBar.module.css";

/** What a scope token needs: the cluster plus its live state and failing count. */
export type ScopeCluster = Pick<Territory, "cluster" | "state" | "message" | "failing">;

function tokenTitle(c: ScopeCluster): string | undefined {
  if (c.state === "error") return c.message ?? "This cluster reported an error without details";
  if (c.state === "syncing" && c.message) return c.message;
  if (c.state !== "ready") return "Connecting…";
  return undefined;
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r="9" fill="none" stroke="var(--focus)" strokeWidth="2" />
      <path d="M11 1v20M2 11c4 3 14 3 18 0" fill="none" stroke="var(--focus)" strokeWidth="2" />
    </svg>
  );
}

export function TopBar({ clusters }: { clusters: ScopeCluster[] }) {
  return (
    <header className={s.top}>
      <div className={s.logo}>
        <Logo />
        Omnikrux
      </div>
      {clusters.length > 0 && (
        <div className={s.scope}>
          <span className={s.lbl}>Showing</span>
          {clusters.map((c) => (
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
        </div>
      )}
      {/* Placeholder for the command palette (Plan 3): not interactive yet. */}
      <div className={s.cmd} aria-hidden="true">
        <b>:</b>pods, deploy, svc, helm…<span className={`${k.k} ${s.cmdKey}`}>Ctrl K</span>
      </div>
    </header>
  );
}
