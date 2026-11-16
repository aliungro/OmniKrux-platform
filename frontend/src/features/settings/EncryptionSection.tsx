import { failure } from "../../api/http";
import { useSettingsInfo } from "../../api/useCloud";
import s from "./CloudSettings.module.css";
import settings from "./SettingsView.module.css";

export function EncryptionSection() {
  const info = useSettingsInfo();
  const key = info.data?.encryption;

  return <section className={settings.section} id="encryption" aria-labelledby="encryption-heading">
    <h2 id="encryption-heading">Encryption</h2>
    {info.isPending && <p className={s.muted}>Loading encryption settings…</p>}
    {info.isError && <p className={s.warning} role="alert">{failure(info.error)} <button type="button" onClick={() => void info.refetch()}>Retry encryption settings</button></p>}
    {key && <p className={s.muted}>{key.source === "environment"
      ? "Secrets are encrypted with the key from OMNIKRUX_SECRET_KEY."
      : `Secrets are encrypted with the key in ${key.path}, created on first start. Keep it with the data volume: without it, stored credentials can't be read.`}</p>}
  </section>;
}
