import { useEffect, useId, useRef, useState } from "react";
import { failure } from "../../api/http";
import type { ForwardOut } from "../../api/types";
import { CopyButton } from "../inspector/CopyButton";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import pc from "../territories/provider.module.css";
import { usePortForwards } from "./usePortForwards";
import s from "./ForwardsMenu.module.css";

function ForwardItem({ forward, onStop, stopping }: { forward: ForwardOut; onStop: (id: string) => void; stopping: boolean }) {
  const failed = forward.state === "error";
  return (
    <li className={`${s.item} ${pc[knownProvider(forward.provider)]}`}>
      <div className={s.top}>
        <ProviderBadge provider={knownProvider(forward.provider)} />
        <span className={s.target}>{`${forward.cluster_name} / ${forward.namespace} / ${forward.name}`}</span>
      </div>
      <div className={s.addr}>
        <span className={s.ports}>{`localhost:${forward.local_port} → ${forward.remote_port}`}</span>
        <CopyButton text={forward.address} label="Copy address" className={s.btn} />
        <button type="button" className={`${s.btn} ${s.stop}`} onClick={() => onStop(forward.id)} disabled={stopping}>
          Stop
        </button>
      </div>
      <p className={s.state} data-state={forward.state}>
        <span className={s.shape} data-shape={failed ? "diamond" : "dot"} aria-hidden="true" />
        {failed ? (forward.message ?? "This port-forward failed without details. Stop it and start a new one.") : "Listening"}
      </p>
    </li>
  );
}

/**
 * The top bar's port-forwards: shown only while one exists. Each is listed with the cluster it
 * reaches, the address on this computer, why it failed if it did, and a way to stop it. The list is
 * read every 5 s; when a read fails it says the list may be out of date rather than pass it off as live.
 */
export function ForwardsMenu() {
  const { query, stop } = usePortForwards();
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const forwards = query.data ?? [];

  // Escape and a click elsewhere close it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The last one stopped: nothing left to show.
  useEffect(() => {
    if (forwards.length === 0) setOpen(false);
  }, [forwards.length]);

  if (forwards.length === 0) return null;

  const onStop = (forwardId: string) => {
    setStopping(forwardId);
    setError(null);
    stop(forwardId)
      .catch((err: unknown) => setError(failure(err)))
      .finally(() => setStopping(null));
  };
  const label = `${forwards.length} port-forward${forwards.length === 1 ? "" : "s"}`;
  return (
    <div
      ref={root}
      className={s.menu}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          button.current?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className={s.trigger}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={s.pulse} aria-hidden="true" />
        {label}
      </button>
      {open && (
        <div id={id} role="group" aria-label="Port-forwards" className={s.panel}>
          {query.isError && (
            <p className={s.warn} role="status">
              {failure(query.error, "wait a moment")} This list may be out of date.
            </p>
          )}
          {error && <p className={s.warn} role="alert">{error}</p>}
          <ul className={s.list}>
            {forwards.map((f) => (
              <ForwardItem key={f.id} forward={f} onStop={onStop} stopping={stopping === f.id} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
