// The contact point form (A4): its type (fixed once saved), a name, then the settings and secrets
// of the type. Secrets are write-only: password inputs that show empty, with "Saved. Leave empty to
// keep it." when one is stored; an empty field keeps it, "Remove the saved …" clears an optional
// one. The calls that carry a secret are plain (never a TanStack mutation, which would keep the
// body in its cache); every secret input is emptied once the save went through, and nothing typed
// goes into the view state or the page. Ctrl+Enter saves; Esc and Cancel ask first when there are changes.
// A change that an Alertmanager OmniKrux installed needs (the answer's `contacts` changes) is
// reviewed through the tool review queue once the form is gone.

import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { failure } from "../../../api/http";
import { pressed } from "../../../features/chrome/shortcuts";
import {
  createContactPoint, testContactPoint, testUnsavedContactPoint, updateContactPoint, useRefreshAfterContactPoint,
  type AlertChangeOut, type AlertRequestError, type ContactPointIn, type ContactPointOut, type ContactPointPatch, type ContactPointType,
} from "../api";
import { DiscardDialog, useLeaveGuard, type LeaveRef } from "../leave";
import { useToolReviews } from "../reviews/useToolReviews";
import s from "./Contacts.module.css";

export const TYPE_LABEL: Record<ContactPointType, string> = {
  slack: "Slack", email: "Email", teams: "Teams", pagerduty: "PagerDuty", webhook: "Webhook",
};
const TYPES = Object.keys(TYPE_LABEL) as ContactPointType[];
export const KEEP_HINT = "Saved. Leave empty to keep it.";
export const DISCARD_POINT = "Discard this contact point?";
export const DEFAULT_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
const PORT_WORDS = "Use a port from 1 to 65535.";
const SECURITY: readonly { id: string; label: string }[] = [
  { id: "starttls", label: "STARTTLS" }, { id: "tls", label: "TLS" }, { id: "none", label: "None" },
];

interface SecretSpec { key: string; label: string; required: boolean; noun: string }
const SECRETS: Record<ContactPointType, SecretSpec[]> = {
  slack: [{ key: "webhook_url", label: "Webhook address", required: true, noun: "webhook address" }],
  email: [{ key: "password", label: "Password", required: false, noun: "password" }],
  teams: [{ key: "webhook_url", label: "Webhook address", required: true, noun: "webhook address" }],
  pagerduty: [{ key: "routing_key", label: "Routing key", required: true, noun: "routing key" }],
  webhook: [
    { key: "url", label: "Address", required: true, noun: "address" },
    { key: "bearer_token", label: "Bearer token (optional)", required: false, noun: "token" },
  ],
};

type FieldKey = "name" | "username" | "host" | "port" | "from_address" | "to" | "events_url" | `secrets.${string}`;

/** The server's words about an address a webhook is sent to: said under that address's field. */
export const SLACK_ADDRESS = "Use a Slack webhook address that starts with https://hooks.slack.com/.";
const ADDRESS_WORDS: readonly string[] = [SLACK_ADDRESS, "Use an http or https address.", "Use an address without a user name or password in it."];
/** The address secret of each type that sends to one. */
const ADDRESS_SECRET: Partial<Record<ContactPointType, string>> = { slack: "webhook_url", teams: "webhook_url", webhook: "url" };

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

interface Plain { type: ContactPointType; name: string; host: string; port: string; security: string; username: string; from: string; to: string; eventsUrl: string }

function plainOf(initial: ContactPointOut | undefined): Plain {
  const set = initial?.settings ?? {};
  const to = Array.isArray(set.to) ? set.to.filter((x): x is string => typeof x === "string").join(", ") : "";
  return {
    type: initial?.type ?? "slack", name: initial?.name ?? "", host: str(set.host), port: String(typeof set.port === "number" ? set.port : 587),
    security: str(set.security, "starttls"), username: str(set.username), from: str(set.from_address), to,
    eventsUrl: str(set.events_url, DEFAULT_EVENTS_URL),
  };
}

export interface ContactPointFormProps {
  initial?: ContactPointOut;
  /** Saved (the stored contact point) or cancelled (nothing). */
  onDone(saved?: ContactPointOut): void;
  leaveRef?: LeaveRef;
  /** The Monitoring tab the form is in: its other ways out ask while the form has changes. */
  tabId?: string;
}

export function ContactPointForm({ initial, onDone, leaveRef, tabId }: ContactPointFormProps) {
  const ids = useId();
  const refresh = useRefreshAfterContactPoint();
  const reviews = useToolReviews();
  const start = useRef(plainOf(initial)).current;
  const [plain, setPlain] = useState<Plain>(start);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<FieldKey | "type" | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const busyRef = useRef(false);
  const fields = useRef(new Map<string, HTMLElement>());
  const setRef = (key: string) => (el: HTMLElement | null) => {
    if (el) fields.current.set(key, el);
    else fields.current.delete(key);
  };

  const type = plain.type;
  const stored = initial?.secrets_set ?? [];
  // A change answers what was said about the old values: their errors and a failed test's words go.
  const forget = () => {
    setErrors({});
    setFormError(null);
    setResult((r) => (r && !r.ok ? null : r));
  };
  const edit = (patch: Partial<Plain>) => { setPlain((p) => ({ ...p, ...patch })); forget(); };
  const typedSecret = Object.values(secrets).some((v) => v !== "") || Object.values(removed).some(Boolean);
  const changed = typedSecret || JSON.stringify(plain) !== JSON.stringify(start);
  const guard = useLeaveGuard(leaveRef, changed, busy,
    tabId === undefined ? undefined : { tabId, title: initial ? initial.name : "New contact point", tab: "contacts" });

  useLayoutEffect(() => { (initial ? fields.current.get("name") : fields.current.get("type"))?.focus({ preventScroll: true }); }, [initial]);
  useLayoutEffect(() => {
    if (focusKey === null) return;
    setFocusKey(null);
    fields.current.get(focusKey)?.focus();
  }, [focusKey]);

  const fail = (key: FieldKey, text: string) => {
    setErrors({ [key]: text });
    setFocusKey(key);
  };

  /** The request as entered, or the field that is wrong and its words. */
  const build = (): { body: ContactPointIn; patch: ContactPointPatch } | { key: FieldKey; text: string } => {
    const name = plain.name.trim();
    if (name === "") return { key: "name", text: "Give the contact point a name." };
    let settings: Record<string, unknown> = {};
    if (type === "email") {
      if (plain.host.trim() === "") return { key: "host", text: "Enter the mail server." };
      const port = plain.port.trim();
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return { key: "port", text: PORT_WORDS };
      const to = plain.to.split(",").map((a) => a.trim()).filter((a) => a !== "");
      if (plain.from.trim() === "") return { key: "from_address", text: "Enter the address it sends from." };
      if (to.length === 0) return { key: "to", text: "Add at least one address to send to." };
      settings = { host: plain.host.trim(), port: Number(port), security: plain.security, username: plain.username.trim(), from_address: plain.from.trim(), to };
    } else if (type === "pagerduty") {
      settings = { events_url: plain.eventsUrl.trim() || DEFAULT_EVENTS_URL };
    }
    const sent: Record<string, string | null> = {};
    for (const spec of SECRETS[type]) {
      const typed = secrets[spec.key] ?? "";
      if (typed !== "") sent[spec.key] = typed;
      else if (removed[spec.key] && !spec.required) sent[spec.key] = "";
      else if (spec.required && !stored.includes(spec.key)) return { key: `secrets.${spec.key}`, text: `Enter the ${spec.noun}.` };
    }
    return { body: { name, type, settings, secrets: sent }, patch: { name, settings, secrets: sent } };
  };

  const refused = (err: unknown) => {
    const e = err as AlertRequestError;
    const secret = e.field && e.field.startsWith("secrets.") ? (e.field as FieldKey) : null;
    const address = ADDRESS_SECRET[type];
    if (secret && fields.current.has(secret)) fail(secret, e.message);
    else if (address && ADDRESS_WORDS.includes(e.message) && fields.current.has(`secrets.${address}`)) fail(`secrets.${address}`, e.message);
    else if (e.status === 409) fail("name", e.message); // the only conflict a save can answer is a name already taken
    else setFormError(failure(err, "try again"));
  };

  const save = async (ev?: FormEvent) => {
    ev?.preventDefault();
    if (busyRef.current) return;
    setFormError(null);
    setErrors({});
    const built = build();
    if ("key" in built) return fail(built.key, built.text);
    busyRef.current = true;
    setBusy(true);
    try {
      // Plain calls: the body (a secret in it) never enters the TanStack cache. Only an edit answers
      // changes (a new contact point isn't used by a rule yet).
      let saved: ContactPointOut;
      let changes: AlertChangeOut[] = [];
      if (initial) {
        const out = await updateContactPoint(initial.id, built.patch);
        changes = out.alert_changes ?? [];
        saved = out;
      } else saved = await createContactPoint(built.body);
      // Nothing typed stays in the form, whatever happens next.
      setSecrets({});
      setRemoved({});
      await refresh();
      onDone(saved);
      if (changes.length > 0) reviews.enqueue(changes);
    } catch (err) {
      refused(err);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const test = async () => {
    if (busyRef.current || testing) return;
    setFormError(null);
    setResult(null);
    let run: () => ReturnType<typeof testContactPoint>;
    if (initial) run = () => testContactPoint(initial.id);
    else {
      const built = build();
      if ("key" in built) return fail(built.key, built.text);
      run = () => testUnsavedContactPoint(built.body);
    }
    setTesting(true);
    try {
      const out = await run();
      setResult({ ok: out.ok, text: out.message });
      await refresh();
    } catch (err) {
      setResult({ ok: false, text: failure(err, "test again") });
    } finally {
      setTesting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (pressed("confirmReview", e)) {
      e.preventDefault();
      if (!e.repeat) void save();
      return;
    }
    if (e.key === "Escape" && !e.defaultPrevented && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      guard.request(() => onDone());
    }
  };

  const err = (k: FieldKey) => errors[k] ?? null;
  const text = (key: FieldKey, label: string, value: string, set: (v: string) => void, extra: { placeholder?: string; inputMode?: "numeric" | "email" } = {}) => {
    const id = `${ids}-${key}`;
    return (
      <div className={s.field}>
        <label className={s.label} htmlFor={id}>{label}</label>
        <input id={id} ref={setRef(key)} className={s.input} type="text" autoComplete="off" spellCheck={false} value={value}
          placeholder={extra.placeholder} inputMode={extra.inputMode} aria-invalid={err(key) ? true : undefined}
          aria-describedby={err(key) ? `${id}-e` : undefined} onChange={(e) => set(e.target.value)} />
        {err(key) && <p id={`${id}-e`} className={s.fieldError}>{err(key)}</p>}
      </div>
    );
  };
  const secret = (spec: SecretSpec) => {
    const key: FieldKey = `secrets.${spec.key}`;
    const id = `${ids}-${key}`;
    const saved = stored.includes(spec.key);
    const hint = saved ? `${id}-h` : undefined;
    // The stored address's problem (a Slack address that isn't Slack's), until a new one is typed.
    const problem = saved && spec.key === ADDRESS_SECRET[type] && !(secrets[spec.key] ?? "") ? initial?.problem ?? null : null;
    const describedBy = [hint, problem ? `${id}-p` : undefined, err(key) ? `${id}-e` : undefined].filter(Boolean).join(" ") || undefined;
    return (
      <div className={s.field} key={spec.key}>
        <label className={s.label} htmlFor={id}>{spec.label}</label>
        <input id={id} ref={setRef(key)} className={s.input} type="password" autoComplete="new-password" spellCheck={false}
          value={secrets[spec.key] ?? ""} aria-invalid={err(key) ? true : undefined} aria-describedby={describedBy} disabled={removed[spec.key] || undefined}
          onChange={(e) => { setSecrets((cur) => ({ ...cur, [spec.key]: e.target.value })); forget(); }} />
        {saved && <span id={`${id}-h`} className={s.hint}>{removed[spec.key] ? `The saved ${spec.noun} is removed when you save.` : KEEP_HINT}</span>}
        {problem && <span id={`${id}-p`} className={s.stored} data-tone="warn">{problem}</span>}
        {saved && !spec.required && (
          <label className={s.check}>
            <input type="checkbox" checked={!!removed[spec.key]}
              onChange={(e) => { setRemoved((cur) => ({ ...cur, [spec.key]: e.target.checked })); if (e.target.checked) setSecrets((cur) => ({ ...cur, [spec.key]: "" })); }} />
            {` Remove the saved ${spec.noun}`}
          </label>
        )}
        {err(key) && <p id={`${id}-e`} className={s.fieldError}>{err(key)}</p>}
      </div>
    );
  };
  const secretOf = (k: string) => SECRETS[type].find((x) => x.key === k)!;

  const title = initial ? `Edit ${initial.name}` : "Add a contact point";
  return (
    <form className={s.form} aria-label={title} noValidate onSubmit={(e) => void save(e)} onKeyDown={onKeyDown} data-contact-form="" autoComplete="off">
      <h2 className={s.formTitle}>{title}</h2>
      <div className={s.pair}>
        <div className={s.field}>
          <label className={s.label} htmlFor={`${ids}-type`}>Type</label>
          <select id={`${ids}-type`} ref={setRef("type")} className={s.input} value={type} disabled={initial ? true : undefined}
            aria-describedby={initial ? `${ids}-type-h` : undefined}
            onChange={(e) => { edit({ type: e.target.value as ContactPointType }); setSecrets({}); setRemoved({}); setResult(null); }}>
            {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
          {initial && <span id={`${ids}-type-h`} className={s.hint}>The type can't change after saving.</span>}
        </div>
        {text("name", "Name", plain.name, (v) => edit({ name: v }))}
      </div>

      {type === "email" && (
        <>
          <div className={s.pair}>
            {text("host", "Mail server", plain.host, (v) => edit({ host: v }), { placeholder: "smtp.example.test" })}
            {text("port", "Port", plain.port, (v) => edit({ port: v }), { inputMode: "numeric" })}
          </div>
          <div className={s.pair}>
            <div className={s.field}>
              <label className={s.label} htmlFor={`${ids}-security`}>Security</label>
              <select id={`${ids}-security`} className={s.input} value={plain.security} onChange={(e) => edit({ security: e.target.value })}>
                {SECURITY.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            {text("username", "User name", plain.username, (v) => edit({ username: v }))}
          </div>
          {secret(secretOf("password"))}
          <div className={s.pair}>
            {text("from_address", "From", plain.from, (v) => edit({ from: v }), { placeholder: "alerts@example.test", inputMode: "email" })}
            {text("to", "To", plain.to, (v) => edit({ to: v }), { placeholder: "ops@example.test, oncall@example.test" })}
          </div>
        </>
      )}
      {type === "pagerduty" && (
        <>
          {secret(secretOf("routing_key"))}
          {text("events_url", "Events address", plain.eventsUrl, (v) => edit({ eventsUrl: v }))}
        </>
      )}
      {(type === "slack" || type === "teams") && secret(secretOf("webhook_url"))}
      {type === "webhook" && (
        <>
          {secret(secretOf("url"))}
          {secret(secretOf("bearer_token"))}
        </>
      )}

      {formError && <p className={s.formError} role="alert">{formError}</p>}
      {result && <p className={result.ok ? s.ok : s.formError} role="status">{result.text}</p>}
      {initial && changed && <p className={s.hint}>Send a test tries what is saved. Save your changes first to test them.</p>}
      <div className={s.actions}>
        {/* aria-disabled, not disabled: a pressed button keeps the keyboard while it waits. */}
        <button type="button" className={s.secondary} aria-disabled={busy || testing || undefined} onClick={() => void test()}>
          {testing ? "Sending…" : "Send a test"}
        </button>
        <span className={s.keyHint} aria-hidden="true">Ctrl+Enter saves</span>
        <button type="button" className={s.secondary} aria-disabled={busy || undefined} onClick={() => guard.request(() => onDone())}>Cancel</button>
        <button type="submit" className={s.primary} aria-keyshortcuts="Control+Enter" aria-disabled={busy || undefined}>
          {busy ? "Saving…" : "Save contact point"}
        </button>
      </div>
      {guard.asking && <DiscardDialog title={DISCARD_POINT} onKeep={guard.keep} onDiscard={guard.discard} />}
    </form>
  );
}
