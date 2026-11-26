// The Contact points view (A4): where notifications go. Each row says its type, what it sends to
// (never a secret), which rules use it and how the last delivery went, and offers Send a test,
// Edit and Delete…. Add a contact point and Edit open the form on the page.

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import {
  alertsKeys, listContactPoints, testContactPoint, useRefreshAfterContactPoint,
  type AlertRequestError, type ContactPointOut,
} from "../api";
import type { LeaveRef } from "../leave";
import { whenShort } from "../silences/when";
import { ContactPointDeleteDialog } from "./ContactPointDeleteDialog";
import { ContactPointForm, TYPE_LABEL } from "./ContactPointForm";
import s from "./Contacts.module.css";

export const NO_POINTS = "No contact points yet. Add one to be told when an alert fires.";

type Open = { mode: "new" } | { mode: "edit"; id: string };
type Test = { state: "sending" } | { state: "done"; ok: boolean; text: string };

export const usedByWords = (n: number) => (n === 0 ? "No rule uses it" : `Used by ${n} rule${n === 1 ? "" : "s"}`);

/** The last delivery in a few words. After a test sent from this row, its answer is shown under the
 * row, so the line only says when (`Last test hh:mm`): an answer is never shown twice. */
function lastWords(p: ContactPointOut, now: number, tested: boolean): { text: string; failed: boolean } | null {
  const d = p.last_delivery;
  if (!d) return null;
  const when = whenShort(d.at, now);
  if (tested) return { text: `Last test ${when}`, failed: !d.ok };
  return d.ok
    ? { text: `Last sent ${when}`, failed: false }
    : { text: `Last send failed ${when}${d.message ? `: ${d.message}` : ""}`, failed: true };
}

export function ContactPointsTab({ leaveRef, tabId }: { leaveRef: LeaveRef; tabId?: string }) {
  const refresh = useRefreshAfterContactPoint();
  const query = useQuery<ContactPointOut[], AlertRequestError>({
    queryKey: alertsKeys.contactPoints, queryFn: () => listContactPoints(), retry: false,
  });
  const points = query.data;
  const [open, setOpen] = useState<Open | null>(null);
  const [tests, setTests] = useState<Record<string, Test>>({});
  const [deleting, setDeleting] = useState<ContactPointOut | null>(null);

  const addRef = useRef<HTMLButtonElement>(null);
  const editRefs = useRef(new Map<string, HTMLButtonElement>());
  const restore = useRef<HTMLElement | null>(null);
  // Where the keyboard goes once the form is gone: its opener, else Add.
  const back = useRef<string | "add" | null>(null);
  useLayoutEffect(() => {
    if (back.current !== null && open === null) {
      const key = back.current;
      back.current = null;
      (key === "add" ? addRef.current : editRefs.current.get(key) ?? addRef.current)?.focus();
    }
  });

  const close = (id?: string) => {
    back.current = id ?? "add";
    setOpen(null);
  };

  const test = async (p: ContactPointOut) => {
    if (tests[p.id]?.state === "sending") return;
    setTests((cur) => ({ ...cur, [p.id]: { state: "sending" } }));
    let next: Test;
    try {
      // A plain call, then everything is read again: the row's last delivery moves.
      const out = await testContactPoint(p.id);
      next = { state: "done", ok: out.ok, text: out.message };
    } catch (err) {
      next = { state: "done", ok: false, text: failure(err, "try again") };
    }
    setTests((cur) => ({ ...cur, [p.id]: next }));
    void refresh();
  };

  const afterDelete = useCallback(() => {
    restore.current = addRef.current;
    setDeleting(null);
    void refresh();
    // `refresh` only closes over the query client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const now = Date.now();
  let body;
  if (!points) {
    body = query.isError ? (
      <div className={s.note} role="alert">
        <p>The contact points couldn't be read. {failure(query.error, "try again")}</p>
        <div><button type="button" className={s.small} onClick={() => void query.refetch()}>Try again</button></div>
      </div>
    ) : <p className={s.empty} role="status">Loading…</p>;
  } else if (points.length === 0) {
    body = open?.mode === "new" ? null : <p className={s.empty}>{NO_POINTS}</p>;
  } else {
    body = (
      <ul className={s.list} aria-label="Contact points">
        {points.map((p) => {
          if (open?.mode === "edit" && open.id === p.id) {
            return (
              <li key={p.id} className={s.editing}>
                <ContactPointForm initial={p} leaveRef={leaveRef} tabId={tabId} onDone={() => close(p.id)} />
              </li>
            );
          }
          const t = tests[p.id];
          const last = lastWords(p, now, t?.state === "done");
          return (
            <li key={p.id} className={s.item}>
              <div className={s.main}>
                <span className={s.badge}>{TYPE_LABEL[p.type]}</span>
                <span className={s.name}>{p.name}</span>
                <span className={s.summary}>{p.summary}</span>
              </div>
              <p className={s.meta}>
                {usedByWords(p.used_by.length)}
                {last && <> · <span className={s.last} data-failed={last.failed || undefined}>{last.text}</span></>}
              </p>
              {p.problem && <p className={s.stored} data-tone="warn">{p.problem}</p>}
              <div className={s.buttons}>
                <button type="button" className={s.small} aria-label={`Send a test to ${p.name}`} aria-disabled={t?.state === "sending" || undefined}
                  onClick={() => void test(p)}>
                  {t?.state === "sending" ? "Sending…" : "Send a test"}
                </button>
                <button type="button" className={s.small} aria-label={`Edit ${p.name}`}
                  ref={(el) => { if (el) editRefs.current.set(p.id, el); else editRefs.current.delete(p.id); }}
                  onClick={() => {
                    // Another form open: it asks first when it has changes.
                    const go = () => setOpen({ mode: "edit", id: p.id });
                    if (open !== null && leaveRef.current) leaveRef.current(go);
                    else go();
                  }}>
                  Edit
                </button>
                <button type="button" className={s.small} aria-label={`Delete ${p.name}…`}
                  onClick={(e) => { restore.current = e.currentTarget; setDeleting(p); }}>
                  Delete…
                </button>
              </div>
              <div role="status" className={s.test} data-ok={t?.state === "done" ? t.ok : undefined}>
                {t?.state === "done" ? t.text : null}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className={s.view} aria-label="Contact points">
      <div className={s.head}>
        <h2 className={s.headTitle}>Contact points</h2>
        <span className={s.spacer} />
        <button ref={addRef} type="button" className={s.secondary} aria-disabled={open !== null || undefined}
          onClick={() => { if (open === null) setOpen({ mode: "new" }); }}>
          Add a contact point
        </button>
      </div>
      {open?.mode === "new" && <ContactPointForm leaveRef={leaveRef} tabId={tabId} onDone={() => close()} />}
      {body}
      {deleting && (
        <ContactPointDeleteDialog point={deleting} restoreFocusTo={restore}
          onCancel={() => setDeleting(null)} onDeleted={afterDelete} />
      )}
    </section>
  );
}
