import { Fragment, useState } from "react";
import type { Condition, ContainerInfo, EnvVar, Link, OwnerRef, PodDescribe, Volume } from "../../api/types";
import { LinkButton } from "../navigation/navigation";
import { formatAge } from "../territories/model";
import { Status } from "../territories/Status";
import { EventsTable } from "./EventsTable";
import s from "./DescribeView.module.css";

const UNKNOWN = "—";

/** "Today at 14:02, 2h ago"; another day reads "Nov 6 at 14:02, 1d ago". Seconds on request. */
function formatWhen(iso: string | null, now: Date, seconds = false): string {
  if (!iso) return UNKNOWN;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined });
  const sameDay = at.toDateString() === now.toDateString();
  const day = sameDay ? "Today" : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} at ${time}, ${formatAge(iso, now)} ago`;
}

/** "PodScheduled" → "Pod scheduled", "ContainersReady" → "Containers ready". */
function conditionLabel(type: string): string {
  const words = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The backend writes terminated states as "Terminated: <reason> (exit <code>)", or without the
 * reason when Kubernetes gives none: "Terminated (exit <code>)". */
function failedTermination(state: string | null): boolean {
  if (!state?.startsWith("Terminated")) return false;
  const code = /\(exit (-?\d+)\)/.exec(state);
  return code !== null && Number(code[1]) !== 0;
}

const MARK: Record<string, string> = { True: "✓", False: "✕" };

function ConditionChip({ c }: { c: Condition }) {
  const why = [c.reason, c.message].filter(Boolean).join(": ");
  return (
    <li className={s.cond} data-status={c.status} title={why || `${c.type}: ${c.status}`}>
      <span className={s.mark} aria-hidden="true">{MARK[c.status] ?? "?"}</span>
      <span data-status={c.status}>{conditionLabel(c.type)}</span>
    </li>
  );
}

interface Actions {
  onNodeShell?: (node: string) => void;
  onOwnerLogs?: (owner: OwnerRef) => void;
  /** Jump to an object the pod points at; without it, names are plain text. */
  onLink?: (link: Link) => void;
}

/** `text` as a link to `link` when there is somewhere to go, else as plain text. */
function Linked({ text, link, onLink }: { text: string; link: Link | null | undefined; onLink?: (link: Link) => void }) {
  return link && onLink ? <LinkButton link={link} onLink={onLink}>{text}</LinkButton> : <span>{text}</span>;
}

function Volumes({ volumes, onLink }: { volumes: Volume[]; onLink?: (link: Link) => void }) {
  return (
    <div className={s.vols}>
      <h6 className={s.sub}>Volumes</h6>
      <ul className={s.volList} aria-label="Volumes">
        {volumes.map((v) => (
          <li key={v.name} className={s.vol} data-testid={`volume-${v.name}`}>
            <span className={s.volName}>{v.name}</span>
            <span className={s.volType}>{v.type}</span>
            {v.link && <Linked text={v.link.name} link={v.link} onLink={onLink} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PodSection({ data, now, onNodeShell, onOwnerLogs, onLink }: { data: PodDescribe; now: Date } & Actions) {
  const { pod } = data;
  const owner = pod.owner;
  const labels = Object.entries(data.labels);
  const annotations = Object.entries(data.annotations);
  return (
    <section className={s.col} aria-label="Pod">
      <h5 className={s.h}>Pod</h5>
      <dl className={s.kv}>
        <dt>Status</dt>
        <dd><Status label={pod.status} cls={pod.status_class} /></dd>
        <dt>Node</dt>
        <dd title={pod.node ?? undefined}>
          {pod.node ? <Linked text={pod.node} link={pod.node_link} onLink={onLink} /> : <span>{UNKNOWN}</span>}
          {pod.node && onNodeShell && (
            <button type="button" className={s.link} onClick={() => onNodeShell(pod.node!)}>Node shell</button>
          )}
        </dd>
        <dt>Pod IP</dt>
        <dd className={s.num}>{pod.pod_ip ?? UNKNOWN}</dd>
        <dt>Host IP</dt>
        <dd className={s.num}>{pod.host_ip ?? UNKNOWN}</dd>
        <dt>QoS class</dt>
        <dd>{pod.qos ?? UNKNOWN}</dd>
        <dt>Controlled by</dt>
        <dd title={owner ? `${owner.kind} ${owner.name}` : undefined}>
          {owner ? <Linked text={`${owner.kind} ${owner.name}`} link={owner.link} onLink={onLink} /> : <span>Nothing (a bare pod)</span>}
          {owner?.selector && onOwnerLogs && (
            <button type="button" className={s.link} title={`Logs of every pod matching ${owner.selector}`} onClick={() => onOwnerLogs(owner)}>
              All pods' logs
            </button>
          )}
        </dd>
        <dt>Service account</dt>
        <dd>{pod.service_account ? <Linked text={pod.service_account} link={pod.service_account_link} onLink={onLink} /> : UNKNOWN}</dd>
        <dt>Started</dt>
        <dd title={pod.started_at ?? undefined}>{pod.started_at ? formatWhen(pod.started_at, now) : "Not started"}</dd>
      </dl>
      {data.conditions.length > 0 && (
        <ul className={s.conds} aria-label="Conditions">
          {data.conditions.map((c) => <ConditionChip key={c.type} c={c} />)}
        </ul>
      )}
      {data.volumes.length > 0 && <Volumes volumes={data.volumes} onLink={onLink} />}
      {labels.length > 0 && (
        <ul className={s.tags} aria-label="Labels">
          {labels.map(([k, v]) => <li key={k} className={s.tag} title={`${k}=${v}`}>{`${k}=${v}`}</li>)}
        </ul>
      )}
      {annotations.length > 0 && (
        <details className={s.more}>
          <summary>{annotations.length === 1 ? "1 annotation" : `${annotations.length} annotations`}</summary>
          <ul className={s.tags}>
            {annotations.map(([k, v]) => <li key={k} className={`${s.tag} ${s.long}`} title={`${k}=${v}`}>{`${k}=${v}`}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}

const RESOURCE_LABEL: Record<string, string> = { cpu: "CPU req/lim", memory: "Mem req/lim" };

function resourceKeys(c: ContainerInfo): string[] {
  const rest = new Set([...Object.keys(c.requests), ...Object.keys(c.limits)]);
  rest.delete("cpu");
  rest.delete("memory");
  return ["cpu", "memory", ...[...rest].sort()];
}

function Resource({ c, k }: { c: ContainerInfo; k: string }) {
  const hit = c.limit_hit.includes(k);
  return (
    <>
      <dt>{RESOURCE_LABEL[k] ?? `${k} req/lim`}</dt>
      <dd className={s.num}>
        <span>{c.requests[k] ?? "none"}</span>
        {" / "}
        <span className={hit ? s.over : undefined} data-tone={hit ? "bad" : undefined} title={hit ? "This container ran into this limit" : undefined}>
          {c.limits[k] ?? "none"}
        </span>
      </dd>
    </>
  );
}

function Env({ e, onLink }: { e: EnvVar; onLink?: (link: Link) => void }) {
  return (
    <li className={s.env} data-testid={`env-${e.name}`}>
      <span className={s.envName}>{e.name}</span>
      {e.value !== null ? (
        <span className={s.envValue} data-testid="env-value" title={e.value}>{e.value === "" ? '""' : e.value}</span>
      ) : (
        // A reference: name where it comes from, never a value (Secrets never reach the browser).
        <span className={s.envSource}>
          from {e.source ? <Linked text={e.source} link={e.link} onLink={onLink} /> : "a reference the console can't name"}
        </span>
      )}
    </li>
  );
}

type ContainerKind = "init" | "ephemeral" | null;
const KIND_TAG: Record<Exclude<ContainerKind, null>, string> = { init: "Init", ephemeral: "Ephemeral" };

function ContainerCard({ c, kind, now, onLink }: { c: ContainerInfo; kind: ContainerKind; now: Date; onLink?: (link: Link) => void }) {
  // Healthy containers start folded to their header, as in the mockup; anything worth a look starts open.
  const troubled = c.state_class === "bad" || c.state_class === "warn" || c.restarts > 0 || c.limit_hit.length > 0;
  const [open, setOpen] = useState(troubled);
  const lastBad = failedTermination(c.last_state);
  const probes = Object.entries(c.probes);
  return (
    <article className={`${s.ctr}${open ? "" : ` ${s.mini}`}`} data-testid={`ctr-${c.name}`} aria-label={`Container ${c.name}`}>
      <button type="button" className={s.ctrHead} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <b className={s.ctrName}>{c.name}</b>
        {kind && <span className={s.kindTag}>{KIND_TAG[kind]}</span>}
        <span className={`${s.img} mono`} title={c.image}>{c.image}</span>
        <span className={s.ctrState}><Status label={c.state} cls={c.state_class} /></span>
      </button>
      {open && (
        <div className={s.ctrBody}>
          <dl className={`${s.kv} ${s.ctrKv}`}>
            <dt>Last state</dt>
            <dd title={c.last_state ?? undefined}>
              {c.last_state ? (
                <span className={lastBad ? s.over : undefined} data-tone={lastBad ? "bad" : undefined}>{c.last_state}</span>
              ) : "None"}
            </dd>
            {c.last_finished_at && (
              <>
                <dt>Finished</dt>
                <dd title={c.last_finished_at}>{formatWhen(c.last_finished_at, now, true)}</dd>
              </>
            )}
            <dt>Restarts</dt>
            <dd className={s.num}>{c.restarts}</dd>
            <dt>Ready</dt>
            <dd>{c.ready ? "Yes" : "No"}</dd>
            <dt>Ports</dt>
            <dd>{c.ports.length ? c.ports.join(", ") : "None"}</dd>
          </dl>
          <dl className={`${s.kv} ${s.ctrKv}`}>
            {resourceKeys(c).map((k) => <Resource key={k} c={c} k={k} />)}
            {probes.map(([kind, text]) => (
              <Fragment key={kind}>
                <dt>{kind.charAt(0).toUpperCase() + kind.slice(1)}</dt>
                <dd title={text}>{text}</dd>
              </Fragment>
            ))}
          </dl>
          {c.env.length > 0 && (
            <div className={s.wide}>
              <h6 className={s.sub}>Environment</h6>
              <ul className={s.envs}>{c.env.map((e, i) => <Env key={`${e.name}\u0000${i}`} e={e} onLink={onLink} />)}</ul>
            </div>
          )}
          {c.mounts.length > 0 && (
            <div className={s.wide}>
              <h6 className={s.sub}>Mounts</h6>
              <ul className={s.mounts}>{c.mounts.map((m) => <li key={m} title={m}>{m}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * The Describe tab: pod, containers and events side by side, as in the Territories mockup.
 * `onNodeShell` / `onOwnerLogs` add "Node shell" by the node and "All pods' logs" by the owner;
 * `onLink` makes the owner, node, service account, env sources and volumes links.
 */
export function DescribeView({ data, onNodeShell, onOwnerLogs, onLink }: { data: PodDescribe } & Actions) {
  const now = new Date();
  const containers: [ContainerInfo, ContainerKind][] = [
    ...data.init_containers.map((c): [ContainerInfo, ContainerKind] => [c, "init"]),
    ...data.containers.map((c): [ContainerInfo, ContainerKind] => [c, null]),
    ...data.ephemeral_containers.map((c): [ContainerInfo, ContainerKind] => [c, "ephemeral"]),
  ];
  return (
    <div className={s.desc}>
      <PodSection data={data} now={now} onNodeShell={onNodeShell} onOwnerLogs={onOwnerLogs} onLink={onLink} />
      <section className={s.col} aria-label="Containers">
        <h5 className={s.h}>Containers</h5>
        {containers.length === 0 ? (
          <p className={s.none}>No containers</p>
        ) : (
          containers.map(([c, kind]) => <ContainerCard key={`${kind ?? "main"}:${c.name}`} c={c} kind={kind} now={now} onLink={onLink} />)
        )}
      </section>
      <section className={s.col} aria-label="Events">
        <h5 className={s.h}>Events</h5>
        <EventsTable events={data.events} error={data.events_error} />
      </section>
    </div>
  );
}
