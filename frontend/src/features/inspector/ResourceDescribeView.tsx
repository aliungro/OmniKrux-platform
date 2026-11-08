import type { Cell, Condition, Link, ResourceDescribe, Section } from "../../api/types";
import { LinkButton } from "../navigation/navigation";
import { formatAge } from "../territories/model";
import { Status } from "../territories/Status";
import { EventsTable } from "./EventsTable";
import { SecretValues } from "./SecretValues";
import d from "./DescribeView.module.css";
import s from "./ResourceDescribeView.module.css";

const UNKNOWN = "—";
/** A timestamp as the API writes it ("2026-11-07T10:00:00Z"): shown as an age, in full on hover. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

type OnLink = (link: Link) => void;

/** "PodScheduled" → "Pod scheduled". */
function conditionLabel(type: string): string {
  const words = type.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const MARK: Record<string, string> = { True: "✓", False: "✕" };

function Conditions({ conditions }: { conditions: Condition[] }) {
  return (
    <ul className={d.conds} aria-label="Conditions">
      {conditions.map((c) => {
        const why = [c.reason, c.message].filter(Boolean).join(": ");
        return (
          <li key={c.type} className={d.cond} data-status={c.status} title={why || `${c.type}: ${c.status}`}>
            <span className={d.mark} aria-hidden="true">{MARK[c.status] ?? "?"}</span>
            <span data-status={c.status}>{conditionLabel(c.type)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function When({ iso, now }: { iso: string; now: Date }) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return <>{iso}</>;
  return <span title={at.toLocaleString()}>{formatAge(iso, now)} ago</span>;
}

/** One cell of a section: a status, a link, a time or plain text; "—" when there is nothing. */
function CellView({ cell, now, onLink }: { cell: Cell; now: Date; onLink?: OnLink }) {
  if (cell.text === null || cell.text === "") return <span className={s.dim}>{UNKNOWN}</span>;
  if (cell.cls) return <Status label={cell.text} cls={cell.cls} />;
  if (cell.link && onLink) return <LinkButton link={cell.link} onLink={onLink}>{cell.text}</LinkButton>;
  if (ISO.test(cell.text)) return <When iso={cell.text} now={now} />;
  return <>{cell.text}</>;
}

function SectionView({ section, now, onLink }: { section: Section; now: Date; onLink?: OnLink }) {
  const { title, columns, rows, note } = section;
  return (
    <section className={s.section} aria-label={title}>
      <h6 className={s.title}>
        {title}
        {rows.length > 0 && <span className={s.count}>{rows.length}</span>}
      </h6>
      {rows.length > 0 && columns.length > 0 && (
        <div className={s.wrap}>
          <table className={s.t} aria-label={title}>
            <thead>
              <tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((cell, j) => (
                    <td key={j} className={j === 0 ? s.first : undefined}>
                      <CellView cell={cell} now={now} onLink={onLink} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note && <p className={s.note}>{note}</p>}
    </section>
  );
}

/**
 * The Describe tab for every kind but pods: the object's fields, conditions and labels; its
 * sections as compact tables (or a Secret's keys); and its events. Every link calls `onLink`.
 */
export function ResourceDescribeView({ data, clusterId, onLink }: { data: ResourceDescribe; clusterId: string; onLink?: OnLink }) {
  const now = new Date();
  const labels = Object.entries(data.labels);
  const annotations = Object.entries(data.annotations);
  const keys = data.secret_keys;
  const middle = keys !== null || data.sections.length > 0;
  return (
    <div className={`${d.desc} ${s.grid} ${middle ? s.three : s.two}`}>
      <section className={d.col} aria-label={data.kind}>
        <h5 className={d.h}>{data.kind}</h5>
        <dl className={`${d.kv} ${s.kv}`}>
          {data.fields.map((f, i) => (
            <div key={`${f.label}\u0000${i}`} className={s.pair}>
              <dt>{f.label}</dt>
              <dd title={f.value ?? undefined}>
                {f.link && onLink ? (
                  <LinkButton link={f.link} onLink={onLink}>{f.value ?? f.link.name}</LinkButton>
                ) : (
                  f.value ?? UNKNOWN
                )}
              </dd>
            </div>
          ))}
          <div className={s.pair}>
            <dt>Created</dt>
            <dd>{data.created_at ? <When iso={data.created_at} now={now} /> : UNKNOWN}</dd>
          </div>
        </dl>
        {data.conditions.length > 0 && <Conditions conditions={data.conditions} />}
        {labels.length > 0 && (
          <ul className={d.tags} aria-label="Labels">
            {labels.map(([k, v]) => <li key={k} className={d.tag} title={`${k}=${v}`}>{`${k}=${v}`}</li>)}
          </ul>
        )}
        {annotations.length > 0 && (
          <details className={d.more}>
            <summary>{annotations.length === 1 ? "1 annotation" : `${annotations.length} annotations`}</summary>
            <ul className={d.tags}>
              {annotations.map(([k, v]) => <li key={k} className={`${d.tag} ${d.long}`} title={`${k}=${v}`}>{`${k}=${v}`}</li>)}
            </ul>
          </details>
        )}
      </section>
      {middle && (
        <section className={d.col} aria-label="Contents">
          {keys !== null && (
            <section className={s.section} aria-label="Data">
              <h6 className={s.title}>
                Data
                {keys.length > 0 && <span className={s.count}>{keys.length}</span>}
              </h6>
              {/* Keyed on the version: a changed Secret drops whatever value was on screen. */}
              <SecretValues
                key={`${clusterId}\u0000${data.namespace ?? ""}\u0000${data.name}\u0000${data.resource_version}`}
                clusterId={clusterId}
                namespace={data.namespace ?? ""}
                name={data.name}
                keys={keys}
                canReveal={data.kind_key === "secrets" && data.namespace !== null}
              />
            </section>
          )}
          {data.sections.map((sec, i) => <SectionView key={`${sec.title}\u0000${i}`} section={sec} now={now} onLink={onLink} />)}
        </section>
      )}
      <section className={d.col} aria-label="Events">
        <h5 className={d.h}>Events</h5>
        <EventsTable events={data.events} error={data.events_error} />
      </section>
    </div>
  );
}
