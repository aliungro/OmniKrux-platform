import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import type { CloudAccount, Discovered } from "../../api/types";
import { addDiscovered, dismissDiscovered, useCloudAccounts, useDiscovered } from "../../api/useCloud";
import { useNow } from "../../hooks/useNow";
import { formatAgo, poolSummary } from "../territories/model";
import { ProviderBadge } from "../territories/ProviderBadge";
import s from "./DiscoveryList.module.css";

const MAX_SELECTION = 50;

function canSelect(row: Discovered): boolean {
  return row.state !== "added" && !row.private && !row.why_not && !row.missing_since;
}

function DiscoveryRow({ row, checked, disabled, onChange, showLastSeen, now }: {
  row: Discovered;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  showLastSeen: boolean;
  now: Date;
}) {
  const name = useId();
  const blocked = row.why_not || (row.private ? "Private API endpoint." : null);
  const state = row.state === "added" ? "In Omnikrux" : blocked ? `Can't add: ${blocked}`
    : row.state === "dismissed" ? "Dismissed" : "New";
  return <li className={s.row}>
    <div className={s.identity}>
      <div className={s.checkbox}>
        {canSelect(row) && <input type="checkbox" aria-labelledby={name} checked={checked} disabled={disabled} onChange={onChange} />}
      </div>
      <ProviderBadge provider={row.provider} />
      <strong id={name}>{row.name}</strong>
    </div>
    <div className={s.details}>
      <div className={s.metadata}>
        {row.region && <span>{row.region}</span>}
        {row.kubernetes_version && <span>Kubernetes {row.kubernetes_version}</span>}
        <span>{poolSummary(row.node_pools ? row.node_pools.length : null, row.node_count)}</span>
        {row.environment !== "unknown" && <span className={s.environment} data-environment={row.environment}>
          {row.environment === "production" ? "Production" : "Development"}
        </span>}
      </div>
      <p className={s.state} data-state={row.state !== "added" && blocked ? "blocked" : row.state}>{state}</p>
      {row.missing_since && <p className={s.warning}>Not found at the last check</p>}
      {showLastSeen && <p className={s.muted}>Last seen {formatAgo(row.last_seen, now)}</p>}
    </div>
  </li>;
}

function DiscoveryGroup({ account, rows, checked, busy, toggle, now }: {
  account: CloudAccount;
  rows: Discovered[];
  checked: ReadonlySet<string>;
  busy: boolean;
  toggle: (id: string) => void;
  now: Date;
}) {
  const id = useId();
  const { check } = account;
  const latestSeen = rows.reduce<string | null>((latest, row) =>
    latest === null || Date.parse(row.last_seen) > Date.parse(latest) ? row.last_seen : latest, null);
  const message = check.message ?? "The cloud provider did not return a cluster list.";
  const failed = `The last check failed: ${/[.!?]$/.test(message) ? message : `${message}.`}`;
  const affected = check.state === "error" || check.problems.length > 0;
  const checkTime = check.checked_at ? Date.parse(check.checked_at) : 0;

  return <section className={s.group} aria-labelledby={id}>
    <h3 id={id}>Clusters in {account.name}</h3>
    {rows.length ? <ul className={s.rows}>
      {rows.map(row => <DiscoveryRow key={row.id} row={row} checked={checked.has(row.id)} disabled={busy}
        onChange={() => toggle(row.id)} now={now}
        showLastSeen={affected && Date.parse(row.last_seen) < (check.state === "error" && latestSeen ? Date.parse(latestSeen) : checkTime)} />)}
    </ul> : <p className={s.muted}>No {account.kube_provider.toUpperCase()} clusters in {account.name}.</p>}
    <div className={s.check}>
      <p className={s.muted}>{check.checked_at
        ? <time dateTime={check.checked_at} title={new Date(check.checked_at).toLocaleString()}>Last checked {formatAgo(check.checked_at, now)}</time>
        : "Never checked"}</p>
      {check.state === "error" && <p className={s.warning}>{failed}{latestSeen && ` These clusters are from ${formatAgo(latestSeen, now)}.`}</p>}
      {check.problems.length > 0 && <ul className={s.problems}>
        {check.problems.map((problem, index) => <li key={index}>{problem}</li>)}
      </ul>}
    </div>
  </section>;
}

export function DiscoveryList({ accountId }: { accountId?: string }) {
  const client = useQueryClient();
  const accounts = useCloudAccounts();
  const discovered = useDiscovered();
  const now = useNow(30_000);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [working, setWorking] = useState<"add" | "dismiss" | null>(null);
  const [errors, setErrors] = useState<{ id: string; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const visible = (Array.isArray(accounts.data) ? accounts.data : []).filter(account => accountId === undefined || account.id === accountId);
  const grouped = new Map(visible.map(account => [account.id, [] as Discovered[]]));
  for (const row of Array.isArray(discovered.data) ? discovered.data : []) grouped.get(row.account_id)?.push(row);
  const selected = [...grouped.values()].flat().filter(row => checked.has(row.id) && canSelect(row));
  const dismissible = selected.filter(row => row.state === "new");

  function toggle(id: string) {
    setChecked(old => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(action: "add" | "dismiss") {
    const targets = action === "add" ? selected : dismissible;
    if (working || targets.length === 0 || targets.length > MAX_SELECTION) return;
    setWorking(action);
    setErrors([]);
    setError(null);
    try {
      const names = new Map(targets.map(row => [row.id, row.name]));
      const ids = [...names.keys()];
      let failures: { id: string; message: string }[] = [];
      if (action === "add") failures = (await addDiscovered(client, ids)).failed;
      else await dismissDiscovered(client, ids);
      const failedIds = new Set(failures.map(item => item.id));
      setErrors(failures.map(item => ({ id: item.id, message: `${names.get(item.id) ?? item.id}: ${item.message}` })));
      setChecked(old => {
        const next = new Set(old);
        for (const id of ids) if (!failedIds.has(id)) next.delete(id);
        return next;
      });
    } catch (err) {
      setError(failure(err));
    } finally {
      setWorking(null);
    }
  }

  const loadError = accounts.error ?? discovered.error;
  const pending = accounts.isPending || (visible.length > 0 && discovered.isPending);
  return <div className={s.list}>
    {loadError && <p role="alert" className={s.warning}>Can't load discovered clusters: {failure(loadError)}{" "}
      <button type="button" onClick={() => { void accounts.refetch(); void discovered.refetch(); }}>Try again</button>
    </p>}
    {pending && !loadError && <p role="status" className={s.muted}>Loading discovered clusters…</p>}
    {!pending && !loadError && !visible.length && <p className={s.muted}>Connect a cloud account in Settings to find its clusters.</p>}
    {!discovered.isPending && visible.map(account => <DiscoveryGroup key={account.id} account={account}
      rows={grouped.get(account.id) ?? []} checked={checked} busy={working !== null} toggle={toggle} now={now} />)}
    {selected.length > 0 && <div className={s.actions}>
      <button type="button" className={s.add} disabled={working !== null || selected.length > MAX_SELECTION} onClick={() => void submit("add")}>
        {working === "add" ? "Adding…" : `Add ${selected.length} ${selected.length === 1 ? "cluster" : "clusters"}`}
      </button>
      {dismissible.length > 0 && <button type="button" disabled={working !== null || dismissible.length > MAX_SELECTION}
        onClick={() => void submit("dismiss")}>{working === "dismiss" ? "Dismissing…" : "Dismiss"}</button>}
      {selected.length > MAX_SELECTION && <p className={s.warning}>Select up to {MAX_SELECTION} clusters at a time.</p>}
    </div>}
    {error && <p className={s.warning} role="alert">{error}</p>}
    {errors.length > 0 && <ul className={s.problems} role="alert">{errors.map(item => <li key={item.id}>{item.message}</li>)}</ul>}
  </div>;
}
