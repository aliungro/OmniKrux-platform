import { useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure, HttpError } from "../../api/http";
import { importKubeconfig } from "../../api/useClusters";
import s from "./CloudSettings.module.css";

export function ImportKubeconfig() {
  const client = useQueryClient();
  const id = useId();
  const readId = useRef(0);
  const [kubeconfig, setKubeconfig] = useState("");
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function read(file: File) {
    const readingId = ++readId.current;
    setReading(true);
    setKubeconfig("");
    setError(null);
    setAdded(null);
    try {
      const contents = await file.text();
      if (readId.current === readingId) setKubeconfig(contents);
    } catch {
      if (readId.current === readingId) setError("Couldn't read the kubeconfig file. Choose it again or paste its contents.");
    } finally {
      if (readId.current === readingId) setReading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || reading || !kubeconfig.trim()) return;
    setBusy(true);
    setAdded(null);
    setError(null);
    try {
      const clusters = await importKubeconfig(client, kubeconfig);
      setAdded(clusters.map(cluster => cluster.name));
      setKubeconfig("");
    } catch (err) {
      setError(err instanceof HttpError || err instanceof TypeError ? failure(err) : "Couldn't import the kubeconfig. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return <details className={s.import}>
    <summary>Add from a kubeconfig</summary>
    <form onSubmit={submit} autoComplete="off" className={s.importForm}>
      <label className={s.field} htmlFor={`${id}-file`}>Choose a kubeconfig file</label>
      <input id={`${id}-file`} type="file" disabled={busy} onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void read(file);
      }} />
      <label className={s.field}>
        Or paste a kubeconfig
        <textarea value={kubeconfig} rows={5} autoComplete="off" spellCheck={false} disabled={busy} className={s.secret}
          onChange={event => {
            readId.current++;
            setReading(false);
            setKubeconfig(event.currentTarget.value);
          }} />
      </label>
      <div><button type="submit" disabled={busy || reading || !kubeconfig.trim()}>{busy ? "Importing…" : "Import kubeconfig"}</button></div>
      {reading && <p className={s.muted}>Reading the file…</p>}
      {error && <p className={s.warning} role="alert">{error}</p>}
      {added && <p className={s.result} aria-live="polite">{added.length ? `Added ${added.join(", ")}.` : "No clusters were added."}</p>}
    </form>
  </details>;
}
