import { useEffect, useId, useRef } from "react";
import { ProviderBadge } from "../territories/ProviderBadge";
import forms from "../actions/forms.module.css";
import { DialogShell } from "./ConfirmDialog";
import s from "./ConfirmDialog.module.css";
import field from "./ShellContainerDialog.module.css";
import type { ShellChoice } from "./useDock";

export function ShellContainerDialog({ choice, onCancel }: { choice: ShellChoice; onCancel: () => void }) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (choice.stage === "choose") container.current?.focus();
    else cancel.current?.focus();
  }, [choice.stage, choice.request]);

  return (
    <DialogShell
      provider={choice.cluster.provider}
      role="dialog"
      busy={false}
      onCancel={onCancel}
      first={cancel}
      labelledBy={`${id}-title`}
    >
      <div className={s.where}>
        <ProviderBadge provider={choice.cluster.provider} />
        <span className={s.path} title={choice.where}>{choice.where}</span>
      </div>
      <h2 id={`${id}-title`} className={s.title}>Open shell</h2>
      {choice.stage === "loading" && <p className={s.body} role="status">Reading the pod’s containers…</p>}
      {choice.stage === "choose" && (
        <div className={forms.row}>
          <label className={forms.field} htmlFor={`${id}-container`}>Container</label>
          <select key={choice.request} id={`${id}-container`} ref={container} className={field.select} defaultValue={choice.selected}>
            {choice.containers.map((option) => (
              <option key={option.name} value={option.name}>{option.name} · {option.state}</option>
            ))}
          </select>
        </div>
      )}
      {choice.stage === "error" && (
        <p className={s.error} role="alert">
          Couldn’t read the pod’s containers. {choice.error}
          {choice.openDefault && " You can retry or let Kubernetes choose the default container."}
        </p>
      )}
      <div className={s.actions}>
        <button ref={cancel} type="button" className={s.btn} onClick={onCancel}>Cancel</button>
        {choice.stage === "error" && (
          <button type="button" className={s.btn} onClick={choice.retry}>Retry</button>
        )}
        {choice.stage === "error" && choice.openDefault && (
          <button type="button" className={`${s.btn} ${s.go}`} onClick={choice.openDefault}>Open default shell</button>
        )}
        {choice.stage === "choose" && (
          <button
            type="button"
            className={`${s.btn} ${s.go}`}
            onClick={() => { if (container.current) choice.open(container.current.value); }}
          >
            Open shell
          </button>
        )}
      </div>
    </DialogShell>
  );
}
