import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { failure, HttpError } from "../../api/http";
import type { AccountIn, CliLogin, CloudProvider } from "../../api/types";
import { connectAccount } from "../../api/useCloud";
import { DialogShell } from "../dock/ConfirmDialog";
import dialog from "../dock/ConfirmDialog.module.css";
import { CLOUD_PROVIDERS } from "./cloudProviders";
import { loginWords } from "./LoginsSection";
import s from "./CloudSettings.module.css";

type Source = "cli" | "entered";

function accountInput(provider: CloudProvider, source: Source, form: FormData, secret: string, passphrase: string): AccountIn {
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const parseRegions = () => field("regions").split(",").map(region => region.trim()).filter(Boolean);
  switch (provider) {
    case "azure": {
      const subscription_id = field("subscription_id");
      return source === "cli" ? { provider, source, subscription_id }
        : { provider, source, subscription_id, tenant_id: field("tenant_id"), client_id: field("client_id"), client_secret: secret };
    }
    case "aws": {
      const regions = parseRegions();
      return source === "cli" ? { provider, source, profile: field("profile"), regions }
        : { provider, source, regions, access_key_id: field("access_key_id"), secret_access_key: secret };
    }
    case "gcp": {
      const project_id = field("project_id");
      return source === "cli" ? { provider, source, project_id }
        : { provider, source, project_id, service_account_key: secret };
    }
    case "oci": {
      const regions = parseRegions();
      return source === "cli" ? { provider, source, profile: field("profile"), regions }
        : {
          provider, source, regions, tenancy_ocid: field("tenancy_ocid"), user_ocid: field("user_ocid"),
          fingerprint: field("fingerprint"), private_key: secret, ...(passphrase ? { passphrase } : {}),
        };
    }
  }
}

function TextField({ label, name, required = true, defaultValue, children }: {
  label: string; name: string; required?: boolean; defaultValue?: string; children?: ReactNode;
}) {
  return <label className={s.field}>
    {label}
    <input name={name} required={required} defaultValue={defaultValue} autoComplete="off" spellCheck={false} />
    {children}
  </label>;
}

function LoginChoice({ label, name, login, defaultValue }: {
  label: string; name: string; login: CliLogin | undefined; defaultValue?: string;
}) {
  return login?.choices.length ? <label className={s.field}>
    {label}
    <select name={name} required>
      {login.choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
    </select>
  </label> : <TextField label={label} name={name} defaultValue={defaultValue} />;
}

function AccountFields({ provider, source, login }: { provider: CloudProvider; source: Source; login?: CliLogin }) {
  const cli = source === "cli";
  switch (provider) {
    case "azure": return cli ? <LoginChoice label="Subscription" name="subscription_id" login={login} /> : <>
      <TextField label="Subscription ID" name="subscription_id" />
      <TextField label="Tenant ID" name="tenant_id" />
      <TextField label="Client ID" name="client_id" />
    </>;
    case "gcp": return cli ? <LoginChoice label="Project" name="project_id" login={login} />
      : <TextField label="Project ID" name="project_id" />;
    case "aws": return <>
      {cli ? <LoginChoice label="Profile" name="profile" login={login} /> : <TextField label="Access key ID" name="access_key_id" />}
      <TextField label="Regions" name="regions" required={!cli}><small>Comma-separated, e.g. us-east-1, us-west-2</small></TextField>
    </>;
    case "oci": return <>
      {cli ? <LoginChoice label="Profile" name="profile" login={login} defaultValue="DEFAULT" /> : <>
        <TextField label="Tenancy OCID" name="tenancy_ocid" />
        <TextField label="User OCID" name="user_ocid" />
        <TextField label="Fingerprint" name="fingerprint" />
      </>}
      <TextField label="Regions" name="regions" required={!cli}><small>Comma-separated, e.g. us-ashburn-1</small></TextField>
    </>;
  }
}

const SECRET_LABEL = { azure: "Client secret", aws: "Secret access key", gcp: "Service account key JSON", oci: "Private key (PEM)" };

export function ConnectAccountDialog({ logins, onClose }: { logins: CliLogin[]; onClose: () => void }) {
  const client = useQueryClient();
  const title = useId();
  const loginHint = useId();
  const first = useRef<HTMLSelectElement>(null);
  const [provider, setProvider] = useState<CloudProvider>("azure");
  const [pickedSource, setSource] = useState<Source>(() => logins.some(login => login.provider === "azure" && login.state === "found") ? "cli" : "entered");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const login = logins.find(item => item.provider === provider);
  const cliAvailable = login?.state === "found";
  const source = cliAvailable ? pickedSource : "entered";
  const meta = CLOUD_PROVIDERS[provider];
  const unavailable = !cliAvailable && (login ? loginWords(login) : `The ${meta.cli} login status is unavailable.`);

  function clearSecrets() {
    setSecret("");
    setPassphrase("");
  }

  function close() {
    clearSecrets();
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const body = accountInput(provider, source, new FormData(event.currentTarget), secret, passphrase);
    clearSecrets();
    setBusy(true);
    setError(null);
    try {
      await connectAccount(client, body);
      close();
    } catch (err) {
      clearSecrets();
      setError(err instanceof HttpError || err instanceof TypeError ? failure(err) : "Couldn't connect the account. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(<DialogShell provider={meta.kube} role="dialog" busy={busy} onCancel={close}
    first={first} labelledBy={title} className={s.dialog}>
    <h2 className={dialog.title} id={title}>Connect a cloud account</h2>
    <form onSubmit={submit} autoComplete="off">
      <fieldset disabled={busy} className={s.fields}>
        <label className={s.field}>
          Provider
          <select ref={first} value={provider} onChange={event => {
            const next = event.currentTarget.value as CloudProvider;
            clearSecrets();
            setError(null);
            setSource(logins.some(login => login.provider === next && login.state === "found") ? "cli" : "entered");
            setProvider(next);
          }}>
            {Object.entries(CLOUD_PROVIDERS).map(([value, option]) => <option key={value} value={value}>{option.account}</option>)}
          </select>
        </label>
        <fieldset className={s.source}>
          <legend>Sign in with</legend>
          <label>
            <input type="radio" name="source" checked={source === "cli"} disabled={!cliAvailable}
              aria-describedby={unavailable ? loginHint : undefined} onChange={() => { clearSecrets(); setError(null); setSource("cli"); }} />
            Use my {meta.cli} login
          </label>
          {unavailable && <p id={loginHint} className={login?.state === "unreadable" ? s.warning : s.muted}>{unavailable}</p>}
          <label>
            <input type="radio" name="source" checked={source === "entered"} onChange={() => { setError(null); setSource("entered"); }} />
            Enter credentials
          </label>
        </fieldset>
        <AccountFields key={`${provider}/${source}`} provider={provider} source={source} login={login} />
        {source === "entered" && <>
          <label className={s.field}>
            {SECRET_LABEL[provider]}
            {provider === "gcp" || provider === "oci"
              ? <textarea value={secret} onChange={event => { setSource("entered"); setSecret(event.currentTarget.value); }} required autoComplete="off" spellCheck={false} rows={4} className={s.secret} />
              : <input type="password" value={secret} onChange={event => { setSource("entered"); setSecret(event.currentTarget.value); }} required autoComplete="off" />}
          </label>
          {provider === "oci" && <label className={s.field}>
            Passphrase (optional)
            <input type="password" value={passphrase} onChange={event => { setSource("entered"); setPassphrase(event.currentTarget.value); }} autoComplete="off" />
          </label>}
          <p className={s.muted}>Stored encrypted with the console's key and never sent back to the browser.</p>
        </>}
      </fieldset>
      {error && <p className={dialog.error} role="alert">{error}</p>}
      <div className={dialog.actions}>
        <button type="button" className={dialog.btn} disabled={busy} onClick={close}>Cancel</button>
        <button type="submit" className={`${dialog.btn} ${dialog.go}`} disabled={busy}>{busy ? "Checking the login…" : "Connect"}</button>
      </div>
    </form>
  </DialogShell>, document.body);
}
