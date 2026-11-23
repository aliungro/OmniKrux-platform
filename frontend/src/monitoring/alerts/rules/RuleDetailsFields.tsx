// A rule's details: its name, how serious it is, who hears about it and what they read. Rules that
// OmniKrux checks notify contact points; rules that run in the tool go wherever its Alertmanager
// routes them, so they pick a channel (a route) instead.

import { useId, type Ref } from "react";
import type { ChannelsOut, ContactPointOut, Engine, Severity } from "../api";
import s from "./RuleForm.module.css";

export interface DetailsValue {
  name: string;
  severity: Severity;
  message: string;
  notify: string[];
  engine: Engine;
  channel: { receiver: string; labels: Record<string, string> } | null;
}

export const SEVERITY_CHOICES: readonly (readonly [Severity, string])[] = [["critical", "Critical"], ["warning", "Warning"], ["info", "Info"]];
export const MESSAGE_PLACEHOLDER = "p95 latency for {{route}} is {{value}}";
export const MESSAGE_HELP = "Use {{label}} for a label's value and {{value}} for the number.";
export const NO_CONTACT_POINTS = "No contact points yet.";
export const ANYWHERE = "Wherever its Alertmanager sends it";

/** A channel's labels as `team=ops, env=prod`. */
export const labelsWords = (labels: Record<string, string>) => Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(", ");
const channelKey = (c: { receiver: string; labels: Record<string, string> }) => JSON.stringify([c.receiver, Object.entries(c.labels).sort()]);

export interface FieldRefs {
  name?: Ref<HTMLInputElement>;
  message?: Ref<HTMLInputElement>;
  notify?: Ref<HTMLInputElement>;
  channel?: Ref<HTMLSelectElement>;
}

export interface RuleDetailsFieldsProps {
  value: DetailsValue;
  contactPoints: ContactPointOut[];
  channels: ChannelsOut | null;
  onChange(next: DetailsValue): void;
  /** The way to the Contact points tab, for "Add one on the Contact points tab". */
  onAddContactPoint?(): void;
  /** A refusal from the server, by field (`name`, `message`, `contact_point_ids`, `channel`). */
  errors?: Partial<Record<"name" | "message" | "contact_point_ids" | "channel", string | null>>;
  refs?: FieldRefs;
  /** Said under Notify while the contact points can't be listed (being read, or failed). */
  notifyNote?: string | null;
}

export function RuleDetailsFields({ value, contactPoints, channels, onChange, onAddContactPoint, errors = {}, refs = {}, notifyNote }: RuleDetailsFieldsProps) {
  const id = useId();
  const set = (patch: Partial<DetailsValue>) => onChange({ ...value, ...patch });
  const toggle = (cp: string, on: boolean) => set({ notify: on ? [...value.notify, cp] : value.notify.filter((x) => x !== cp) });
  const err = (field: keyof NonNullable<RuleDetailsFieldsProps["errors"]>) => errors[field] ?? null;
  const described = (field: keyof NonNullable<RuleDetailsFieldsProps["errors"]>, help?: string) =>
    [err(field) ? `${id}-${field}-e` : null, help ?? null].filter(Boolean).join(" ") || undefined;

  const usable = channels?.channels ?? [];
  const chosen = value.channel ? channelKey(value.channel) : "";
  // A channel saved earlier that the Alertmanager no longer lists stays choosable, as it was.
  const known = usable.some((c) => channelKey(c) === chosen);

  return (
    <div className={s.fields}>
      <div className={s.field}>
        <label htmlFor={`${id}-name`} className={s.label}>Name</label>
        <input ref={refs.name} id={`${id}-name`} className={s.input} type="text" autoComplete="off" value={value.name}
          aria-invalid={err("name") ? true : undefined} aria-describedby={described("name")}
          onChange={(e) => set({ name: e.target.value })} />
        {err("name") && <p id={`${id}-name-e`} className={s.fieldError}>{err("name")}</p>}
      </div>

      <fieldset className={s.field}>
        <legend className={s.label}>Severity</legend>
        <div className={s.segmented}>
          {SEVERITY_CHOICES.map(([v, label]) => (
            <label key={v} className={s.segment} data-severity={v} data-checked={value.severity === v || undefined}>
              <input type="radio" name={`${id}-severity`} value={v} checked={value.severity === v} onChange={() => set({ severity: v })} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {value.engine !== "tool" ? (
        <fieldset className={s.field} aria-describedby={described("contact_point_ids")}>
          <legend className={s.label}>Notify</legend>
          {notifyNote ? <p className={s.help}>{notifyNote}</p>
            : contactPoints.length === 0 ? (
              <p className={s.help}>
                {NO_CONTACT_POINTS}{" "}
                {onAddContactPoint
                  ? <button type="button" className={s.link} onClick={onAddContactPoint}>Add one on the Contact points tab</button>
                  : "Add one on the Contact points tab"}
              </p>
            ) : (
              <ul className={s.checks}>
                {contactPoints.map((cp, i) => (
                  <li key={cp.id}>
                    <label className={s.check}>
                      <input ref={i === 0 ? refs.notify : undefined} type="checkbox" checked={value.notify.includes(cp.id)}
                        onChange={(e) => toggle(cp.id, e.target.checked)} />
                      <span className={s.checkName}>{cp.name}</span>
                      <span className={s.checkSummary}>{cp.summary}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          {err("contact_point_ids") && <p id={`${id}-contact_point_ids-e`} className={s.fieldError}>{err("contact_point_ids")}</p>}
        </fieldset>
      ) : (
        <div className={s.field}>
          <label htmlFor={`${id}-channel`} className={s.label}>Channel</label>
          <select ref={refs.channel} id={`${id}-channel`} className={s.input} value={chosen}
            aria-invalid={err("channel") ? true : undefined}
            aria-describedby={described("channel", channels?.message && !channels.alertmanager ? `${id}-channel-m` : undefined)}
            onChange={(e) => {
              const picked = usable.find((c) => channelKey(c) === e.target.value);
              set({ channel: picked ? { receiver: picked.receiver, labels: { ...picked.labels } } : e.target.value === chosen ? value.channel : null });
            }}>
            <option value="">{ANYWHERE}</option>
            {usable.map((c) => {
              const labels = labelsWords(c.labels);
              const text = c.usable ? `${c.receiver}${labels ? ` · ${labels}` : ""}` : `${c.receiver}: ${c.reason ?? "can't be used"}`;
              return <option key={channelKey(c)} value={channelKey(c)} disabled={!c.usable}>{text}</option>;
            })}
            {value.channel && !known && <option value={chosen}>{value.channel.receiver}</option>}
          </select>
          {channels?.message && !channels.alertmanager && <p id={`${id}-channel-m`} className={s.help}>{channels.message}</p>}
          {err("channel") && <p id={`${id}-channel-e`} className={s.fieldError}>{err("channel")}</p>}
        </div>
      )}

      <div className={s.field}>
        <label htmlFor={`${id}-message`} className={s.label}>Message</label>
        <input ref={refs.message} id={`${id}-message`} className={s.input} type="text" autoComplete="off" spellCheck={false}
          placeholder={MESSAGE_PLACEHOLDER} value={value.message}
          aria-invalid={err("message") ? true : undefined} aria-describedby={described("message", `${id}-message-h`)}
          onChange={(e) => set({ message: e.target.value })} />
        <p id={`${id}-message-h`} className={s.help}>{MESSAGE_HELP}</p>
        {err("message") && <p id={`${id}-message-e`} className={s.fieldError}>{err("message")}</p>}
      </div>
    </div>
  );
}
