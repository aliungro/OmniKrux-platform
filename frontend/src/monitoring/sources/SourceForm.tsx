import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { createSource, testNewSource, testSource, updateSource } from "../api/client";
import { invalidateMonitoring } from "../api/hooks";
import type { AuthIn, AuthType, HeaderIn, SourceIn, SourceOut, SourcePatch, SourceType, TestOut } from "../api/types";
import { sourceTypeLabel } from "./sourceLabels";
import s from "./SourceForm.module.css";

const MAX_HEADERS = 20;
const KEEP = "Saved. Leave empty to keep it.";
const AUTH_LABELS: Record<AuthType, string> = {
  none: "None", basic: "Basic", bearer: "Bearer token", api_key: "API key header", mtls: "Client certificate (mTLS)",
};

interface HeaderRow { key: number; name: string; value: string; saved: boolean }

interface CommonProps {
  initial?: SourceOut;
  onCancel(): void;
}

/** `save` stores the source and reports it; `collect` hands the entered source to `onCollect` and stores nothing. */
export type SourceFormProps = CommonProps & (
  /** The form stays busy until a promise `onSaved` returns has settled: Save can't be pressed twice. */
  | { mode: "save"; onSaved(source: SourceOut): void | Promise<void>; onCollect?: never }
  | { mode: "collect"; onCollect?(body: SourceIn): void; onSaved?: never }
);

type Secrets = { password: string; token: string; apiKey: string; certPem: string; keyPem: string };

/** The auth part of a request, or the words for what is missing. Stored secrets are never sent back. */
function buildAuth(type: AuthType, username: string, headerName: string, v: Secrets, stored: SourceOut["auth"] | undefined): AuthIn | string {
  const same = stored !== undefined && stored.type === type;
  const need = (value: string, has: boolean | undefined, what: string): string | null =>
    value.trim() !== "" || (same && has) ? null : `Enter the ${what}. A source can't be saved with an empty one.`;
  const auth: AuthIn = { type };
  let problem: string | null = null;
  if (type === "basic") {
    problem = username.trim() === "" ? "Enter the user name for basic sign-in." : need(v.password, stored?.has_password, "password");
    auth.username = username.trim();
    if (v.password !== "") auth.password = v.password;
  } else if (type === "bearer") {
    problem = need(v.token, stored?.has_token, "token");
    if (v.token !== "") auth.token = v.token;
  } else if (type === "api_key") {
    problem = headerName.trim() === "" ? "Enter the header name the key is sent in." : need(v.apiKey, stored?.has_api_key, "key");
    auth.header_name = headerName.trim();
    if (v.apiKey !== "") auth.api_key = v.apiKey;
  } else if (type === "mtls") {
    problem = need(v.certPem, stored?.has_client_cert, "client certificate") ?? need(v.keyPem, stored?.has_client_key, "client key");
    if (v.certPem !== "") auth.client_cert_pem = v.certPem;
    if (v.keyPem !== "") auth.client_key_pem = v.keyPem;
  }
  return problem ?? auth;
}

function hostOf(url: string): string {
  try { return new URL(url.trim()).hostname; } catch { return ""; }
}

function Secret({ label, value, onChange, saved, multiline = false }: {
  label: string; value: string; onChange(v: string): void; saved: boolean; multiline?: boolean;
}) {
  const id = useId();
  const hint = saved ? `${id}-h` : undefined;
  return (
    <div className={s.field}>
      <label htmlFor={id}>{label}</label>
      {multiline
        ? <textarea id={id} className={`${s.input} ${s.pem}`} rows={4} autoComplete="off" spellCheck={false}
            aria-describedby={hint} value={value} onChange={(e) => onChange(e.target.value)} />
        : <input id={id} className={s.input} type="password" autoComplete="off" spellCheck={false}
            aria-describedby={hint} value={value} onChange={(e) => onChange(e.target.value)} />}
      {saved && <span id={`${id}-h`} className={s.hint}>{KEEP}</span>}
    </div>
  );
}

export function SourceForm(props: SourceFormProps) {
  const { initial, onCancel, mode } = props;
  const client = useQueryClient();
  const ids = useId();
  const address = useRef<HTMLInputElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const keyCounter = useRef(0);
  const busyRef = useRef(false);
  const byCluster = initial?.reach === "cluster";
  const stored = initial?.auth;

  const [type, setType] = useState<SourceType>(initial?.type ?? "prometheus");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [name, setName] = useState("");
  const [authType, setAuthType] = useState<AuthType>(initial?.auth.type ?? "none");
  const [username, setUsername] = useState(initial?.auth.username ?? "");
  const [headerName, setHeaderName] = useState(initial?.auth.header_name ?? "");
  const [secrets, setSecrets] = useState<Secrets>({ password: "", token: "", apiKey: "", certPem: "", keyPem: "" });
  const [headers, setHeaders] = useState<HeaderRow[]>(() =>
    (initial?.headers ?? []).map((h) => ({ key: ++keyCounter.current, name: h.name, value: "", saved: h.has_value })));
  const [ca, setCa] = useState("");
  const [removeCa, setRemoveCa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { (byCluster ? nameInput : address).current?.focus(); }, [byCluster]);

  const setSecret = (k: keyof Secrets) => (v: string) => setSecrets((cur) => ({ ...cur, [k]: v }));
  const sameType = stored?.type === authType;
  const autoName = `${type === "loki" ? "Loki" : "Prometheus"} · ${hostOf(url) || "address"}`;

  /** The source as entered, or the words for what is missing. */
  function build(): { body: SourceIn; patch: SourcePatch } | string {
    if (!byCluster && url.trim() === "") return "Enter the address of the source, for example http://prometheus.example:9090.";
    let auth: AuthIn | undefined;
    let hdrs: HeaderIn[] | undefined;
    if (!byCluster) {
      const a = buildAuth(authType, username, headerName, secrets, stored);
      if (typeof a === "string") return a;
      auth = a;
      const named = headers.filter((h) => h.name.trim() !== "" || h.value !== "");
      for (const h of named) {
        if (h.name.trim() === "") return "Give every custom header a name, or remove the row.";
        if (h.value === "" && !h.saved) return `Enter a value for the ${h.name.trim()} header, or remove the row.`;
      }
      hdrs = named.map((h) => (h.value === "" ? { name: h.name.trim() } : { name: h.name.trim(), value: h.value }));
    }
    const typed = name.trim();
    const body: SourceIn = {
      type, reach: byCluster ? "cluster" : "url", ...(typed ? { name: typed } : {}),
      ...(byCluster ? { cluster_id: initial?.cluster_id } : { url: url.trim() }),
      ...(auth ? { auth } : {}), ...(hdrs ? { headers: hdrs } : {}), ...(ca.trim() ? { ca_pem: ca } : {}),
    };
    const caPatch = removeCa ? { ca_pem: "" } : ca.trim() ? { ca_pem: ca } : {};
    const patch: SourcePatch = {
      ...(typed ? { name: typed } : {}), type,
      ...(byCluster ? {} : { url: url.trim(), auth, headers: hdrs }), ...caPatch,
    };
    return { body, patch };
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    // One save at a time, until the caller has finished with it: a second press would add the source twice.
    if (busyRef.current) return;
    setError(null);
    const built = build();
    if (typeof built === "string") return setError(built);
    if (props.mode === "collect") return props.onCollect?.(built.body);
    busyRef.current = true;
    setBusy(true);
    try {
      // A plain call, not a mutation: TanStack would keep this body (secrets in it) in its cache.
      const saved = initial ? await updateSource(initial.id, built.patch) : await createSource(built.body);
      // Nothing typed stays in the form, whatever the caller does next.
      setSecrets({ password: "", token: "", apiKey: "", certPem: "", keyPem: "" });
      setHeaders((cur) => cur.map((h) => ({ ...h, value: "" })));
      setCa("");
      await invalidateMonitoring(client);
      await props.onSaved?.(saved);
    } catch (err) {
      setError(failure(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function test() {
    if (busyRef.current || testing) return;
    setError(null);
    setResult(null);
    const built = build();
    if (typeof built === "string") return setError(built);
    setTesting(true);
    try {
      const out: TestOut = initial ? await testSource(initial.id) : await testNewSource(built.body);
      setResult(out.ok
        ? { ok: true, text: `Connected · version ${out.version ?? "unknown"}` }
        : { ok: false, text: out.message ?? "The source didn't answer. Check the address and sign-in, then test again." });
    } catch (err) {
      setResult({ ok: false, text: failure(err, "test again") });
    } finally {
      setTesting(false);
    }
  }

  const addHeader = () => setHeaders((cur) =>
    (cur.length >= MAX_HEADERS ? cur : [...cur, { key: ++keyCounter.current, name: "", value: "", saved: false }]));
  const editHeader = (key: number, patch: Partial<HeaderRow>) => setHeaders((cur) => cur.map((h) => (h.key === key ? { ...h, ...patch } : h)));

  return (
    <form className={s.form} onSubmit={save} noValidate aria-label={initial ? `Edit ${initial.name}` : "Add a source by hand"}>
      <h2 className={s.title}>{initial ? `Edit ${initial.name}` : "Add a source by hand"}</h2>
      <div className={s.field}>
        <label htmlFor={`${ids}-type`}>Type</label>
        <select id={`${ids}-type`} className={s.input} value={type} onChange={(e) => setType(e.target.value as SourceType)}>
          <option value="prometheus">{sourceTypeLabel("prometheus")}</option>
          <option value="loki">{sourceTypeLabel("loki")}</option>
        </select>
      </div>
      {byCluster ? (
        <p className={s.fixed}>Reached inside the cluster. Its address and sign-in can&apos;t be changed here.</p>
      ) : (
        <div className={s.field}>
          <label htmlFor={`${ids}-url`}>Address</label>
          <input id={`${ids}-url`} ref={address} className={s.input} type="text" inputMode="url" autoComplete="off" spellCheck={false}
            placeholder="http://prometheus.example:9090" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
      )}
      <div className={s.field}>
        <label htmlFor={`${ids}-name`}>Name</label>
        <input id={`${ids}-name`} ref={nameInput} className={s.input} type="text" autoComplete="off" placeholder={initial ? initial.name : autoName}
          value={name} onChange={(e) => setName(e.target.value)} />
        {initial && <span className={s.hint}>Leave empty to keep the name.</span>}
      </div>

      {!byCluster && (
        <>
          <fieldset className={s.group}>
            <legend>Sign-in</legend>
            <div className={s.field}>
              <label htmlFor={`${ids}-auth`}>Authentication</label>
              <select id={`${ids}-auth`} className={s.input} value={authType} onChange={(e) => setAuthType(e.target.value as AuthType)}>
                {(Object.keys(AUTH_LABELS) as AuthType[]).map((k) => <option key={k} value={k}>{AUTH_LABELS[k]}</option>)}
              </select>
            </div>
            {authType === "basic" && (
              <>
                <div className={s.field}>
                  <label htmlFor={`${ids}-user`}>User name</label>
                  <input id={`${ids}-user`} className={s.input} type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
                </div>
                <Secret label="Password" value={secrets.password} onChange={setSecret("password")} saved={sameType && !!stored?.has_password} />
              </>
            )}
            {authType === "bearer" && <Secret label="Token" value={secrets.token} onChange={setSecret("token")} saved={sameType && !!stored?.has_token} />}
            {authType === "api_key" && (
              <>
                <div className={s.field}>
                  <label htmlFor={`${ids}-hname`}>Header name</label>
                  <input id={`${ids}-hname`} className={s.input} type="text" autoComplete="off" spellCheck={false} placeholder="X-API-Key"
                    value={headerName} onChange={(e) => setHeaderName(e.target.value)} />
                </div>
                <Secret label="Key" value={secrets.apiKey} onChange={setSecret("apiKey")} saved={sameType && !!stored?.has_api_key} />
              </>
            )}
            {authType === "mtls" && (
              <>
                <Secret label="Client certificate (PEM)" multiline value={secrets.certPem} onChange={setSecret("certPem")} saved={sameType && !!stored?.has_client_cert} />
                <Secret label="Client key (PEM)" multiline value={secrets.keyPem} onChange={setSecret("keyPem")} saved={sameType && !!stored?.has_client_key} />
              </>
            )}
          </fieldset>

          <fieldset className={s.group}>
            <legend>Custom headers</legend>
            {headers.map((h, i) => (
              <div key={h.key} className={s.headerRow}>
                <input className={s.input} type="text" aria-label={`Header ${i + 1} name`} autoComplete="off" spellCheck={false} placeholder="Name"
                  value={h.name} onChange={(e) => editHeader(h.key, { name: e.target.value })} />
                <input className={s.input} type="password" aria-label={`Header ${i + 1} value`} autoComplete="off" spellCheck={false}
                  placeholder={h.saved ? "Saved. Leave empty to keep it." : "Value"} value={h.value} onChange={(e) => editHeader(h.key, { value: e.target.value })} />
                <button type="button" className={s.quiet} onClick={() => setHeaders((cur) => cur.filter((x) => x.key !== h.key))}
                  aria-label={`Remove header ${i + 1}`}>Remove</button>
              </div>
            ))}
            <div>
              <button type="button" className={s.quiet} onClick={addHeader} aria-disabled={headers.length >= MAX_HEADERS || undefined}>Add header</button>
              {headers.length >= MAX_HEADERS && <span className={s.hint}> The most is {MAX_HEADERS} headers.</span>}
            </div>
          </fieldset>
        </>
      )}

      <div className={s.field}>
        <label htmlFor={`${ids}-ca`}>CA certificate (PEM, optional)</label>
        <textarea id={`${ids}-ca`} className={`${s.input} ${s.pem}`} rows={3} autoComplete="off" spellCheck={false} value={ca} disabled={removeCa}
          aria-describedby={initial?.has_ca ? `${ids}-cah` : undefined} onChange={(e) => setCa(e.target.value)} />
        {initial?.has_ca && <span id={`${ids}-cah`} className={s.hint}>{removeCa ? "The saved certificate is removed when you save." : KEEP}</span>}
        {initial?.has_ca && (
          <label className={s.check}>
            <input type="checkbox" checked={removeCa} onChange={(e) => setRemoveCa(e.target.checked)} /> Remove saved CA
          </label>
        )}
      </div>

      {error && <p className={s.error} role="alert">{error}</p>}
      {result && <p className={result.ok ? s.ok : s.error} role="status">{result.text}</p>}
      <div className={s.actions}>
        {/* aria-disabled, not disabled: a pressed button keeps the keyboard while it waits. */}
        <button type="button" className={s.secondary} onClick={() => void test()} aria-disabled={busy || testing || undefined}>
          {testing ? "Testing…" : "Test connection"}
        </button>
        <span className={s.spacer} />
        <button type="button" className={s.secondary} onClick={() => { if (!busyRef.current) onCancel(); }} aria-disabled={busy || undefined}>Cancel</button>
        <button type="submit" className={s.primary} aria-disabled={busy || undefined}>{mode === "collect" ? "Use this source" : busy ? "Saving…" : "Save source"}</button>
      </div>
    </form>
  );
}
