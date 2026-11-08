import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { failure, postJson } from "../../api/http";
import type { RevealIn, RevealOut, SecretKey } from "../../api/types";
import { isEditable, pressed } from "../chrome/shortcuts";
import k from "../chrome/key.module.css";
import { CopyButton } from "./CopyButton";
import s from "./SecretValues.module.css";

/** Global Constraints: the mask a Secret's value is shown as. */
export function mask(size: number): string {
  return `•••••• (${size} bytes)`;
}

function revealPath(clusterId: string, namespace: string, name: string): string {
  return `/api/clusters/${encodeURIComponent(clusterId)}/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/reveal`;
}

/**
 * A Secret's keys, each masked, with "Reveal" (`x` on the focused key) for one at a time.
 *
 * A revealed value is fetched with a plain POST (never a query or mutation, so TanStack Query never
 * holds it), lives in this component's state only, and is dropped on Hide, when another key is
 * revealed, when the browser tab is hidden and when this unmounts: the inspector closing, another
 * tab, another row, or a new resource version (the parent keys this on it). It is never logged,
 * put in a URL or stored. `canReveal` is false for Helm releases, which never show Secret data.
 */
export function SecretValues({
  clusterId,
  namespace,
  name,
  keys,
  canReveal,
}: {
  clusterId: string;
  namespace: string;
  name: string;
  keys: SecretKey[];
  canReveal: boolean;
}) {
  const [shown, setShown] = useState<RevealOut | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const hide = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setBusy(null);
    setShown(null);
  }, []);

  // An answer still on its way when this goes is dropped unread.
  useEffect(() => () => inFlight.current?.abort(), []);

  // A hidden browser tab keeps nothing on screen.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [hide]);

  const reveal = async (key: string) => {
    inFlight.current?.abort();
    const ctl = new AbortController();
    inFlight.current = ctl;
    setShown(null);
    setError(null);
    setBusy(key);
    try {
      const body: RevealIn = { key };
      const out = await postJson<RevealOut>(revealPath(clusterId, namespace, name), body, { signal: ctl.signal, cache: "no-store" });
      if (!ctl.signal.aborted) setShown(out);
    } catch (err) {
      // The server's words, e.g. the audit log couldn't record the reveal.
      if (!ctl.signal.aborted) setError({ key, message: failure(err) });
    } finally {
      if (inFlight.current === ctl) {
        inFlight.current = null;
        setBusy(null);
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, key: string) => {
    if (!canReveal || !pressed("reveal", e) || isEditable(e.target)) return;
    e.preventDefault();
    if (busy !== key && shown?.key !== key) void reveal(key);
  };

  if (keys.length === 0) return <p className={s.none}>No keys.</p>;

  return (
    <>
      <ul className={s.keys} aria-label="Keys">
        {keys.map(({ key, size }) => {
          const value = shown?.key === key ? shown : null;
          return (
            <li
              key={key}
              className={`${s.key}${value ? ` ${s.open}` : ""}`}
              data-testid={`secret-key-${key}`}
              tabIndex={canReveal ? 0 : undefined}
              onKeyDown={(e) => onKeyDown(e, key)}
            >
              <span className={s.name} title={key}>{key}</span>
              {value ? (
                <span className={s.well}>
                  <code className={`${s.value} mono`}>{value.value}</code>
                  {value.encoding === "base64" && <span className={s.enc}>Not UTF-8 text, so it's shown as base64.</span>}
                </span>
              ) : (
                <span className={s.mask}>{mask(size)}</span>
              )}
              {canReveal && (
                <span className={s.acts}>
                  {value ? (
                    <>
                      <CopyButton text={value.value} className={s.btn} />
                      <button type="button" className={s.btn} onClick={hide}>Hide</button>
                    </>
                  ) : (
                    <button type="button" className={s.btn} disabled={busy === key} onClick={() => void reveal(key)}>
                      {busy === key ? "Revealing…" : "Reveal"}
                      {busy !== key && <span className={`${k.k} ${s.cap}`} aria-hidden="true">x</span>}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className={s.err} role="alert">{`Couldn't reveal ${error.key}: ${error.message}`}</p>
      )}
    </>
  );
}
