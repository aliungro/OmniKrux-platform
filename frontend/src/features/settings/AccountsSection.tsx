import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import type { CloudAccount } from "../../api/types";
import { checkAccount, removeAccount, useCliLogins, useCloudAccounts } from "../../api/useCloud";
import { useNow } from "../../hooks/useNow";
import { ProviderBadge } from "../territories/ProviderBadge";
import { formatAgo } from "../territories/model";
import { ConnectAccountDialog } from "./ConnectAccountDialog";
import { LoginsSection } from "./LoginsSection";
import { SettingsRemovalDialog } from "./RemoveClusterDialog";
import { CLOUD_PROVIDERS } from "./cloudProviders";
import s from "./CloudSettings.module.css";
import settings from "./SettingsView.module.css";

function AccountCard({ account, now, onRemove }: { account: CloudAccount; now: Date; onRemove: () => void }) {
  const client = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { check, counts } = account;
  const source = account.source === "cli" ? `Your ${CLOUD_PROVIDERS[account.provider].cli} login`
    : account.source === "entered" ? "Entered credentials" : "Workload identity";

  async function checkNow() {
    setChecking(true);
    setError(null);
    try {
      await checkAccount(client, account.id);
    } catch (err) {
      setError(failure(err));
    } finally {
      setChecking(false);
    }
  }

  return <li className={s.item}>
    <div className={s.details}>
      <div className={s.identity}><ProviderBadge provider={account.kube_provider} /><strong>{account.name}</strong></div>
      <p>{account.principal}</p>
      <p>{source}</p>
      <p>{check.checked_at ? <time dateTime={check.checked_at} title={new Date(check.checked_at).toLocaleString()}>Checked {formatAgo(check.checked_at, now)}</time> : "Never checked"}</p>
      <p>{counts.found} clusters · {counts.added} in OmniKrux</p>
      {error && <p className={s.warning} role="alert">{error}</p>}
      {check.message && <p className={s.warning}>{check.message}</p>}
      {check.problems.map((problem, index) => <p className={s.warning} key={`${index}:${problem}`}>{problem}</p>)}
    </div>
    <div className={s.controls}>
      <button type="button" disabled={checking} aria-label={checking ? undefined : `Check now for ${account.name}`} onClick={() => void checkNow()}>{checking ? "Checking…" : "Check now"}</button>
      <button type="button" disabled={checking} aria-label={`Remove ${account.name}`} onClick={onRemove}>Remove</button>
    </div>
  </li>;
}

export function AccountsSection() {
  const client = useQueryClient();
  const accounts = useCloudAccounts();
  const logins = useCliLogins();
  const heading = useRef<HTMLHeadingElement>(null);
  const now = useNow(30_000);
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<CloudAccount | null>(null);
  const target = accounts.data?.find(account => account.id === removing?.id) ?? removing;

  return <section className={settings.section} id="cloud-accounts" aria-labelledby="cloud-accounts-heading">
    <div className={s.sectionHead}>
      <h2 id="cloud-accounts-heading" ref={heading} tabIndex={-1}>Cloud accounts</h2>
      <button type="button" disabled={logins.isPending} onClick={() => setConnecting(true)}>Connect an account</button>
    </div>
    {logins.isPending && <p className={s.muted}>Checking for CLI logins…</p>}
    {logins.isError && <p className={s.warning} role="alert">{failure(logins.error)} <button type="button" onClick={() => void logins.refetch()}>Retry CLI logins</button></p>}
    <LoginsSection logins={logins.data ?? []} />
    {accounts.isPending && <p className={s.muted}>Loading cloud accounts…</p>}
    {accounts.isError && <p className={s.warning} role="alert">{failure(accounts.error)} <button type="button" onClick={() => void accounts.refetch()}>Retry accounts</button></p>}
    {accounts.data?.length === 0 && <p className={s.muted}>No cloud accounts yet. Connect one to find its clusters.</p>}
    {!!accounts.data?.length && <ul className={s.items} aria-label="Connected accounts">
      {accounts.data.map(account => <AccountCard key={account.id} account={account} now={now} onRemove={() => setRemoving(account)} />)}
    </ul>}
    {connecting && <ConnectAccountDialog logins={logins.data ?? []} onClose={() => setConnecting(false)} />}
    {target && <SettingsRemovalDialog provider={target.kube_provider}
      title={`Remove the ${CLOUD_PROVIDERS[target.provider].account} ${target.name}?`}
      onRemove={() => removeAccount(client, target.id)} onClose={() => setRemoving(null)} focusAfterRemoval={heading}>
      <p>Its {target.counts.added} {target.counts.added === 1 ? "cluster leaves" : "clusters leave"} OmniKrux too. Nothing changes in {CLOUD_PROVIDERS[target.provider].cloud}.</p>
    </SettingsRemovalDialog>}
  </section>;
}
