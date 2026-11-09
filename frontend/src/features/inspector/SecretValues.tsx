import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { failure, postJson } from "../../api/http";
import type { RevealIn, RevealOut, SecretKey } from "../../api/types";
import { capsOf, isEditable, pressed } from "../chrome/shortcuts";
import k from "../chrome/key.module.css";
import { CopyButton } from "./CopyButton";
import s from "./SecretValues.module.css";

/** Global Constraints: the mask a Secret's value is shown as. */
export function mask(size: number): string {
  return `•••••• (${size} bytes)`;
}

/**
 * An ask to focus the first key (Ruling R38: `x` on a Secret's row), with where focus was when it
 * was asked: if you've moved on by the time the keys show, focus stays where you are (Plan 2 R16).
 */
export interface KeysAsk {
  seq: number;
  from: Element | null;
}

function revealPath(clusterId: string, namespace: string, name: string): string {
  return `/api/clusters/${encodeURIComponent(clusterId)}/secrets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/reveal`;
}

/**
 * A Secret's keys, each masked, with "Reveal" (`x` on the focused key).
 *
 * A revealed value is fetched with a plain POST (never a query or mutation, so TanStack Query never
 * holds it), lives in this component's state only, and is dropped on Hide, Hide all,
 * when the browser tab is hidden and when this unmounts: the inspector closing, another
 * tab, another row, or a new resource version (the parent keys this on it). It is never logged,
 * put in a URL or stored. `canReveal` is false for Helm releases, which never show Secret data.
 */
export function SecretValues({
  clusterId,
  namespace,
  name,
  keys,
  canReveal,
  focusFirst = null,
  onFocused,
}: {
  clusterId: string;
  namespace: string;
  name: string;
  keys: SecretKey[];
  canReveal: boolean;
  focusFirst?: KeysAsk | null;
  onFocused?: () => void;
}) {
  const [shown, setShown] = useState<ReadonlyMap<string, RevealOut>>(() => new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const inFlight = useRef(new Map<string, AbortController>());

  const abortAll = useCallback(() => {
    const controllers = [...inFlight.current.values()];
    inFlight.current.clear();
    for (const ctl of controllers) ctl.abort();
  }, []);

  const hideAll = useCallback(() => {
    abortAll();
    setBusy(new Set());
    setShown(new Map());
    setError(null);
  }, [abortAll]);

  const hide = useCallback((key: string) => {
    const ctl = inFlight.current.get(key);
    inFlight.current.delete(key);
    ctl?.abort();
    setBusy((previous) => { const next = new Set(previous); next.delete(key); return next; });
    setShown((previous) => { const next = new Map(previous); next.delete(key); return next; });
    setError((previous) => previous?.key === key ? null : previous);
  }, []);

  // Asked to focus the first key: done once the keys are on screen, never pulled from elsewhere.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (focusFirst === null) return;
    const active = document.activeElement;
    if (canReveal && (active === focusFirst.from || active === null || active === document.body)) {
      list.current?.querySelector<HTMLElement>("li")?.focus();
    }
    onFocused?.();
  }, [focusFirst, onFocused, canReveal]);

  // An answer still on its way when this goes is dropped unread.
  useEffect(() => abortAll, [abortAll]);

  // A hidden browser tab keeps nothing on screen.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hideAll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [hideAll]);

  const reveal = async (key: string) => {
    if (inFlight.current.has(key) || shown.has(key) || document.visibilityState === "hidden") return;
    const ctl = new AbortController();
    inFlight.current.set(key, ctl);
    setError(null);
    setBusy((previous) => new Set(previous).add(key));
    // Identity also invalidates a late answer after Hide/unmount, even if abort races decoding.
    const current = () => inFlight.current.get(key) === ctl && !ctl.signal.aborted;
    try {
      const body: RevealIn = { key };
      const out = await postJson<RevealOut>(revealPath(clusterId, namespace, name), body, { signal: ctl.signal, cache: "no-store" });
      if (current()) setShown((previous) => new Map(previous).set(key, out));
    } catch (err) {
      // The server's words, e.g. the audit log couldn't record the reveal.
      if (current()) setError({ key, message: failure(err) });
    } finally {
      if (current()) {
        inFlight.current.delete(key);
        setBusy((previous) => { const next = new Set(previous); next.delete(key); return next; });
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, key: string) => {
    if (!canReveal || !pressed("reveal", e) || isEditable(e.target)) return;
    e.preventDefault();
    // A held `x` repeats: only a fresh press reveals (the row's `x` has just focused this key).
    if (e.repeat) return;
    if (!busy.has(key) && !shown.has(key)) void reveal(key);
  };

  if (keys.length === 0) return <p className={s.none}>No keys.</p>;

  return (
    <>
      {shown.size > 0 && <button type="button" className={`${s.btn} ${s.hideAll}`} onClick={hideAll}>Hide all</button>}
      <ul ref={list} className={s.keys} aria-label="Keys">
        {keys.map(({ key, size }) => {
          const value = shown.get(key);
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
                      <button type="button" className={s.btn} onClick={() => hide(key)}>Hide</button>
                    </>
                  ) : (
                    <button type="button" className={s.btn} disabled={busy.has(key)} onClick={() => void reveal(key)}>
                      {busy.has(key) ? "Revealing…" : "Reveal"}
                      {!busy.has(key) && <span className={`${k.k} ${s.cap}`} aria-hidden="true">{capsOf("reveal")[0]}</span>}
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
