import { useQuery } from "@tanstack/react-query";
import { getJson } from "../../api/http";
import type { ContainerUsage, PodMetrics } from "../../api/types";
import { hiddenWhy, METRICS_POLL_MS, useJudged } from "../../api/useMetrics";
import { formatCpu, formatMemory, formatWindow, fraction, HOT_AT } from "../metrics/format";
import { Meter } from "../metrics/Meter";
import { formatAge } from "../territories/model";
import { podPath } from "./useDescribe";
import k from "./MetricsView.module.css";
import s from "./Inspector.module.css";

function usePodMetrics(clusterId: string, ns: string, name: string) {
  return useQuery({
    queryKey: ["pod-metrics", clusterId, ns, name],
    queryFn: () => getJson<PodMetrics>(`${podPath(clusterId, ns, name)}/metrics`),
    refetchInterval: METRICS_POLL_MS,
    retry: false,
  });
}

function pair(request: number | null, limit: number | null, fmt: (n: number) => string): string {
  const parts = [request ? `request ${fmt(request)}` : null, limit ? `limit ${fmt(limit)}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "no request or limit";
}

function ContainerRow({ c, stale, staleTitle }: { c: ContainerUsage; stale: boolean; staleTitle: string }) {
  const cpuBasis = c.cpu_limit_m ?? c.cpu_request_m;
  const memBasis = c.memory_limit_b ?? c.memory_request_b;
  const cpuFrac = fraction(c.cpu_m, cpuBasis);
  const memFrac = fraction(c.memory_b, memBasis);
  const bytes = (n: number) => formatMemory(n);
  return (
    <tr>
      <td className={k.name}>{c.name}</td>
      <td>
        <Meter
          text={formatCpu(c.cpu_m)}
          frac={cpuFrac}
          hot={c.cpu_limit_m !== null && cpuFrac !== null && cpuFrac >= HOT_AT}
          stale={stale}
          title={stale ? staleTitle : undefined}
        />
        <div className={k.ctx}>{pair(c.cpu_request_m, c.cpu_limit_m, formatCpu)}</div>
      </td>
      <td>
        <Meter
          text={formatMemory(c.memory_b, c.memory_limit_b)}
          frac={memFrac}
          hot={c.memory_limit_b !== null && memFrac !== null && memFrac >= HOT_AT}
          stale={stale}
          title={stale ? staleTitle : undefined}
        />
        <div className={k.ctx}>{pair(c.memory_request_b, c.memory_limit_b, bytes)}</div>
      </td>
    </tr>
  );
}

/** A pod's usage per container, against each container's request and limit; polls while it is open. */
export function MetricsView({ clusterId, ns, name }: { clusterId: string; ns: string; name: string }) {
  const q = usePodMetrics(clusterId, ns, name);
  const { snap, now } = useJudged(q, `${clusterId}/${ns}/${name}`);
  // A failed poll or an old answer hides the numbers: the query keeps the last good data around.
  const hidden = hiddenWhy(snap, now);
  if (hidden) return <div className={s.state} role="alert"><span className={s.err}>{hidden}</span></div>;
  const m = q.data;
  if (m === undefined || snap.awaiting) return <div className={s.state} role="status">Loading metrics…</div>;
  if (m.state !== "ok") {
    return <div className={s.state} role="status"><span>{m.message ?? "Metrics aren't available for this pod."}</span></div>;
  }
  const staleTitle = `Measured ${formatAge(m.at, new Date(now))} ago; metrics-server has nothing newer.`;
  return (
    <div className={k.mv}>
      <table className={k.t}>
        <thead>
          <tr><th scope="col">Container</th><th scope="col">CPU</th><th scope="col">Memory</th></tr>
        </thead>
        <tbody>
          {m.containers.map((c) => <ContainerRow key={c.name} c={c} stale={m.stale} staleTitle={staleTitle} />)}
        </tbody>
      </table>
      <div className={`${k.foot}${m.stale ? ` ${k.stale}` : ""}`} title={m.stale ? staleTitle : undefined}>
        Measured {formatAge(m.at, new Date(now))} ago over {formatWindow(m.window_s)}
        {m.stale && ". metrics-server has nothing newer."}
      </div>
    </div>
  );
}
