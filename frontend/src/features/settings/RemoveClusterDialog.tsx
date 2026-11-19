import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import type { Cluster, Provider } from "../../api/types";
import { removeCluster } from "../../api/useClusters";
import { DialogShell } from "../dock/ConfirmDialog";
import c from "../dock/ConfirmDialog.module.css";
import { ProviderBadge } from "../territories/ProviderBadge";
import s from "./CloudSettings.module.css";

export function SettingsRemovalDialog({ provider, title, children, onRemove, onClose, focusAfterRemoval }: {
  provider: Provider; title: string; children: ReactNode; onRemove: () => Promise<void>; onClose: () => void;
  focusAfterRemoval: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    setBusy(true);
    try {
      await onRemove();
      restoreFocusTo.current = focusAfterRemoval.current;
      onClose();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(<DialogShell provider={provider} busy={busy} onCancel={onClose} first={cancel} restoreFocusTo={restoreFocusTo}
    labelledBy={`${id}-title`} describedBy={`${id}-body`} className={s.dialog}>
    <ProviderBadge provider={provider} />
    <h2 className={c.title} id={`${id}-title`}>{title}</h2>
    <div className={s.confirmCopy} id={`${id}-body`}>{children}</div>
    {error && <p className={c.error} role="alert">{error}</p>}
    <div className={c.actions}>
      <button type="button" className={c.btn} ref={cancel} disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className={`${c.btn} ${c.go}`} disabled={busy} onClick={() => void confirm()}>{busy ? "Removing…" : "Remove"}</button>
    </div>
  </DialogShell>, document.body);
}

export function RemoveClusterDialog({ cluster, location, onClose, focusAfterRemoval }: {
  cluster: Cluster; location: string; onClose: () => void; focusAfterRemoval: RefObject<HTMLElement | null>;
}) {
  const client = useQueryClient();
  return <SettingsRemovalDialog provider={cluster.provider} title={`Remove ${cluster.name} from OmniKrux?`}
    onRemove={() => removeCluster(client, cluster.id)} onClose={onClose} focusAfterRemoval={focusAfterRemoval}>
    <p>{location}</p>
    <p>This doesn't change the cluster. Its port-forwards stop and its sessions close.</p>
    {cluster.source === "file" && <p>It's in your kubeconfig file, so it comes back on the next start unless you remove its context there.</p>}
  </SettingsRemovalDialog>;
}
