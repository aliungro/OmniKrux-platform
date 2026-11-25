// A Grafana connection as entered: by its address with a sign-in, or inside a cluster (read
// anonymously). `save` stores it (a plain call: the token never enters TanStack's caches) and
// clears the typed secrets; `collect` hands it to the caller and stores nothing. A stored secret
// is never shown back: its field stays empty and says so. With changes, the form holds its tab
// through the app's leave check (its title only, never what was typed).
import { useEffect, useId, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { useClusters } from "../../api/useClusters";
import { invalidateMonitoring } from "../api/hooks";
import type { Reach } from "../api/types";
import { DiscardDialog, useLeaveGuard } from "../alerts/leave";
import { escapeCloses } from "../focus";
import type { MonitoringView } from "../shell/tabState";
import {
  createGrafana, testGrafana, testNewGrafana, updateGrafana,
  type GrafanaAuth, type GrafanaAuthIn, type GrafanaIn, type GrafanaOut, type GrafanaPatch,
} from "./api";
import {
  ADDRESS_EXAMPLE, AUTH_LABELS, BASIC_NEEDS, CLUSTER_ANONYMOUS, CLUSTER_PICK, DISCARD_CONNECTION, KEEP_SECRET, TOKEN_NEEDED,
  RETYPE_TO_TEST, URL_RULE, testWords,
} from "./grafanaLabels";
import s from "./GrafanaForm.module.css";

export interface GrafanaFormProps {
  /** The connection being edited (save mode). Its reach can't change. */
  initial?: GrafanaOut;
  /** Fields to start from (never a secret: a preset's token or password is ignored). */
  preset?: Partial<GrafanaIn>;
  mode: "save" | "collect";
  onSaved?(g: GrafanaOut): void;
  onCollect?(body: GrafanaIn): void;
  onCancel(): void;
  /** The tab and page the form lives on: with changes it holds the tab under `title`. */
  leave?: { tabId: string; page: MonitoringView["page"]; title: string };
  /** Filled with the form's own Cancel (asks first when something changed), for a dialog's Esc and outside click. */
  cancelRef?: MutableRefObject<((then: () => void) => void) | null>;
  /** Shown inline: Esc cancels it, as Cancel does. */
  closeOnEscape?: boolean;
  /** The form's name for assistive technology, when a heading outside it names it. */
  labelledBy?: string;
}

/** Everything the form holds but the secrets. */
interface Plain {
  reach: Reach;
  url: string;
  clusterId: string;
  namespace: string;
  service: string;
  port: string;
  https: boolean;
  name: string;
  authType: GrafanaAuth;
  username: string;
}

function startOf(initial: GrafanaOut | undefined, preset: Partial<GrafanaIn> | undefined): Plain {
  const from = initial ?? preset ?? {};
  const auth = initial ? initial.auth : preset?.auth;
  return {
    reach: from.reach ?? "url",
    url: from.url ?? "",
    clusterId: from.cluster_id ?? "",
    namespace: from.namespace ?? "",
    service: from.service ?? "",
    port: from.port ?? "",
    https: from.scheme === "https",
    // Editing, the name field stays empty: the placeholder shows the current one.
    name: initial ? "" : (preset?.name ?? ""),
    authType: auth?.type ?? "none",
    username: auth?.username ?? "",
  };
}

function hostOf(url: string): string {
  try { return new URL(url.trim()).hostname; } catch { return ""; }
}

function Secret({ label, value, onChange, saved }: { label: string; value: string; onChange(v: string): void; saved: boolean }) {
  const id = useId();
  return (
    <div className={s.field}>
      <label htmlFor={id}>{label}</label>
      <input id={id} className={s.input} type="password" autoComplete="off" spellCheck={false}
        aria-describedby={saved ? `${id}-h` : undefined} value={value} onChange={(e) => onChange(e.target.value)} />
      {saved && <span id={`${id}-h`} className={s.hint}>{KEEP_SECRET}</span>}
    </div>
  );
}

export function GrafanaForm({ initial, preset, mode, onSaved, onCollect, onCancel, leave, cancelRef, closeOnEscape = false, labelledBy }: GrafanaFormProps) {
  const client = useQueryClient();
  const clusters = useClusters();
  const ids = useId();
  const first = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const stored = initial?.auth;

  const [start] = useState(() => startOf(initial, preset));
  const [plain, setPlain] = useState<Plain>(start);
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const changed = password !== "" || token !== "" || JSON.stringify(plain) !== JSON.stringify(start);
  const guard = useLeaveGuard(cancelRef, changed, busy, leave ? { tabId: leave.tabId, title: leave.title, page: leave.page } : undefined);

  useEffect(() => { first.current?.focus(); }, []);

  // Any change makes a test on its way out of date: its answer is about what was there before.
  const testRun = useRef(0);
  const stale = () => { testRun.current += 1; setError(null); setResult(null); };
  const edit = (patch: Partial<Plain>) => { setPlain((p) => ({ ...p, ...patch })); stale(); };
  const typeToken = (v: string) => { setToken(v); stale(); };
  const typePassword = (v: string) => { setPassword(v); stale(); };
  const byCluster = plain.reach === "cluster";
  // Inside a cluster there is no sign-in: what was picked for the address stays for a switch back.
  const authType: GrafanaAuth = byCluster ? "none" : plain.authType;
  const sameType = stored !== undefined && stored.type === authType;
  const clusterName = clusters.data?.find((c) => c.id === plain.clusterId)?.name;
  const autoName = `Grafana · ${byCluster ? (clusterName || "cluster") : (hostOf(plain.url) || "address")}`;
  // An edit whose sign-in leans on the stored secret can only be tested as saved (the secret never
  // comes back to the browser), which is honest only while nothing but the name changed.
  const { name: _n, ...where } = plain;
  const { name: _s, ...startWhere } = start;
  const connectionChanged = JSON.stringify(where) !== JSON.stringify(startWhere);
  const leansOnStored = initial !== undefined && !byCluster && sameType
    && ((authType === "bearer" && token === "" && !!stored?.has_token) || (authType === "basic" && password === "" && !!stored?.has_password));
  const retype = leansOnStored && connectionChanged && (authType === "bearer" || authType === "basic") ? RETYPE_TO_TEST[authType] : null;

  /** The connection as entered, or the words for what is missing (the backend's own). */
  function build(): { body: GrafanaIn; patch: GrafanaPatch } | string {
    const typed = plain.name.trim();
    if (byCluster) {
      const where = [plain.clusterId, plain.namespace.trim(), plain.service.trim(), plain.port.trim()];
      if (where.some((v) => v === "")) return CLUSTER_PICK;
      const [cluster_id, namespace, service, port] = where;
      const scheme = plain.https ? "https" : "http";
      const body: GrafanaIn = {
        reach: "cluster", ...(typed ? { name: typed } : {}), cluster_id, namespace, service, port, scheme,
        ...(preset?.path_prefix ? { path_prefix: preset.path_prefix } : {}), auth: { type: "none" },
      };
      const patch: GrafanaPatch = { ...(typed ? { name: typed } : {}), cluster_id, namespace, service, port, scheme };
      return { body, patch };
    }
    const url = plain.url.trim();
    if (url === "") return URL_RULE;
    const auth: GrafanaAuthIn = { type: authType };
    if (authType === "bearer") {
      if (token === "" && !(sameType && stored?.has_token)) return TOKEN_NEEDED;
      if (token !== "") auth.token = token;
    } else if (authType === "basic") {
      const username = plain.username.trim();
      if (username === "" || (password === "" && !(sameType && stored?.has_password))) return BASIC_NEEDS;
      auth.username = username;
      if (password !== "") auth.password = password;
    }
    const body: GrafanaIn = {
      reach: "url", ...(typed ? { name: typed } : {}), url,
      ...(preset?.path_prefix ? { path_prefix: preset.path_prefix } : {}), auth,
    };
    // A secret left out keeps the stored one while the sign-in stays the same.
    const patch: GrafanaPatch = { ...(typed ? { name: typed } : {}), url, auth };
    return { body, patch };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busyRef.current) return;
    setError(null);
    const built = build();
    if (typeof built === "string") return setError(built);
    if (mode === "collect") return onCollect?.(built.body);
    busyRef.current = true;
    setBusy(true);
    try {
      // A plain call, not a mutation: TanStack would keep this body (the secret in it) in its cache.
      const saved = initial ? await updateGrafana(initial.id, built.patch) : await createGrafana(built.body);
      // Nothing typed stays in the form, whatever the caller does next.
      setPassword("");
      setToken("");
      await invalidateMonitoring(client);
      onSaved?.(saved);
    } catch (err) {
      setError(failure(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function test() {
    if (busyRef.current || testing || retype) return;
    setError(null);
    setResult(null);
    const built = build();
    if (typeof built === "string") return setError(built);
    const run = ++testRun.current;
    setTesting(true);
    try {
      // As entered; a rename that leans on the stored secret tests the saved connection.
      const out = initial && leansOnStored ? await testGrafana(initial.id) : await testNewGrafana(built.body);
      if (run === testRun.current) setResult(testWords(out));
    } catch (err) {
      if (run === testRun.current) setResult({ ok: false, text: failure(err, "test again") });
    } finally {
      setTesting(false);
    }
  }

  const cancel = () => guard.request(onCancel);
  const reachChoice = (value: Reach, label: string) => (
    <label className={s.choice} data-checked={plain.reach === value || undefined}>
      <input ref={plain.reach === value ? first : undefined} type="radio" name={`${ids}-reach`} value={value}
        checked={plain.reach === value} disabled={initial !== undefined && initial.reach !== value}
        onChange={() => edit({ reach: value })} />
      {label}
    </label>
  );

  return (
    <form className={s.form} onSubmit={submit} noValidate autoComplete="off" aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : initial ? `Edit ${initial.name}` : "Connect a Grafana"}
      onKeyDown={closeOnEscape ? escapeCloses(cancel, busy) : undefined}>
      <fieldset className={s.reach} role="radiogroup" aria-label="Reach it">
        <legend className={s.label}>Reach it</legend>
        <div className={s.choices}>
          {reachChoice("url", "By its address")}
          {reachChoice("cluster", "Inside a cluster")}
        </div>
      </fieldset>

      {byCluster ? (
        <div className={s.grid}>
          <div className={`${s.field} ${s.wide}`}>
            <label htmlFor={`${ids}-cluster`}>Cluster</label>
            <select id={`${ids}-cluster`} className={s.input} value={plain.clusterId} onChange={(e) => edit({ clusterId: e.target.value })}>
              <option value="" disabled>Pick a cluster</option>
              {(clusters.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              {plain.clusterId && !clusters.data?.some((c) => c.id === plain.clusterId) && (
                <option value={plain.clusterId}>{initial?.cluster_name ?? plain.clusterId}</option>
              )}
            </select>
          </div>
          <div className={s.field}>
            <label htmlFor={`${ids}-ns`}>Namespace</label>
            <input id={`${ids}-ns`} className={`${s.input} ${s.mono}`} type="text" autoComplete="off" spellCheck={false} placeholder="monitoring"
              value={plain.namespace} onChange={(e) => edit({ namespace: e.target.value })} />
          </div>
          <div className={s.field}>
            <label htmlFor={`${ids}-svc`}>Service</label>
            <input id={`${ids}-svc`} className={`${s.input} ${s.mono}`} type="text" autoComplete="off" spellCheck={false} placeholder="grafana"
              value={plain.service} onChange={(e) => edit({ service: e.target.value })} />
          </div>
          <div className={s.field}>
            <label htmlFor={`${ids}-port`}>Port</label>
            <input id={`${ids}-port`} className={`${s.input} ${s.mono}`} type="text" autoComplete="off" spellCheck={false} placeholder="80"
              value={plain.port} onChange={(e) => edit({ port: e.target.value })} />
          </div>
          <label className={s.check}>
            <input type="checkbox" checked={plain.https} onChange={(e) => edit({ https: e.target.checked })} /> HTTPS
          </label>
        </div>
      ) : (
        <div className={s.field}>
          <label htmlFor={`${ids}-url`}>Address</label>
          <input id={`${ids}-url`} className={`${s.input} ${s.mono}`} type="text" inputMode="url" autoComplete="off" spellCheck={false}
            placeholder={ADDRESS_EXAMPLE} value={plain.url} onChange={(e) => edit({ url: e.target.value })} />
        </div>
      )}

      <div className={s.field}>
        <label htmlFor={`${ids}-name`}>Name</label>
        <input id={`${ids}-name`} className={s.input} type="text" autoComplete="off" placeholder={initial ? initial.name : autoName}
          value={plain.name} onChange={(e) => edit({ name: e.target.value })} />
        {initial && <span className={s.hint}>Leave empty to keep the name.</span>}
      </div>

      <div className={s.signIn}>
        <div className={s.field}>
          <label htmlFor={`${ids}-auth`}>Sign-in</label>
          <select id={`${ids}-auth`} className={s.input} value={authType} disabled={byCluster}
            aria-describedby={byCluster ? `${ids}-anon` : undefined} onChange={(e) => edit({ authType: e.target.value as GrafanaAuth })}>
            {(Object.keys(AUTH_LABELS) as GrafanaAuth[]).map((k) => <option key={k} value={k}>{AUTH_LABELS[k]}</option>)}
          </select>
          {byCluster && <span id={`${ids}-anon`} className={s.hint}>{CLUSTER_ANONYMOUS}</span>}
        </div>
        {authType === "bearer" && <Secret label="Token" value={token} onChange={typeToken} saved={sameType && !!stored?.has_token} />}
        {authType === "basic" && (
          <>
            <div className={s.field}>
              <label htmlFor={`${ids}-user`}>User name</label>
              <input id={`${ids}-user`} className={s.input} type="text" autoComplete="off" spellCheck={false}
                value={plain.username} onChange={(e) => edit({ username: e.target.value })} />
            </div>
            <Secret label="Password" value={password} onChange={typePassword} saved={sameType && !!stored?.has_password} />
          </>
        )}
      </div>

      {error && <p className={s.error} role="alert">{error}</p>}
      {result && <p className={result.ok ? s.ok : s.error} role="status">{result.text}</p>}
      {retype && <p id={`${ids}-retype`} className={s.hint}>{retype}</p>}
      <div className={s.actions}>
        {/* aria-disabled, not disabled: a pressed button keeps the keyboard while it waits. */}
        <button type="button" className={s.secondary} onClick={() => void test()} aria-disabled={busy || testing || !!retype || undefined}
          aria-describedby={retype ? `${ids}-retype` : undefined}>
          {testing ? "Testing…" : "Test connection"}
        </button>
        <span className={s.spacer} />
        <button type="button" className={s.secondary} onClick={cancel} aria-disabled={busy || undefined}>Cancel</button>
        <button type="submit" className={s.primary} aria-disabled={busy || undefined}>
          {mode === "collect" ? "Use it" : busy ? "Saving…" : "Save connection"}
        </button>
      </div>
      {guard.asking && <DiscardDialog title={DISCARD_CONNECTION} onKeep={guard.keep} onDiscard={guard.discard} />}
    </form>
  );
}
