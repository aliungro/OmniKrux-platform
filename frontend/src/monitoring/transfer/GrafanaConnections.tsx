// The Sources page's Grafana connections: one row each (where it is, how many dashboards came from
// it) with Test, Edit and Remove; Connect a Grafana opens the form in a dialog. Removing asks first
// and keeps the dashboards imported from it.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { failure } from "../../api/http";
import { DialogShell } from "../../features/dock/ConfirmDialog";
import { DeleteReviewDialog } from "../DeleteReviewDialog";
import { testGrafana, useDeleteGrafana, useGrafanaConnections, type GrafanaOut } from "./api";
import { GrafanaForm } from "./GrafanaForm";
import { GRAFANA_GONE, handOverWords, importedWords, rowWhere, testWords } from "./grafanaLabels";
import s from "./GrafanaConnections.module.css";

type Editing = { kind: "new" } | { kind: "edit"; id: string } | null;

export function GrafanaConnections({ tabId }: { tabId: string }) {
  const ids = useId();
  const connections = useGrafanaConnections();
  const remove = useDeleteGrafana();
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const noFirst = useRef<HTMLElement | null>(null);
  const cancelForm = useRef<((then: () => void) => void) | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string } | "busy">>({});
  const [removing, setRemoving] = useState<GrafanaOut | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  /** The keyboard back where the user was; if that row is gone, on the section's heading. */
  const returnFocus = useCallback(() => {
    setTimeout(() => {
      const back = opener.current;
      (back && back.isConnected ? back : heading.current)?.focus();
    }, 0);
  }, []);

  const openForm = (next: Editing, from: HTMLElement) => { opener.current = from; setGone(false); setEditing(next); };
  const closeForm = () => { setEditing(null); returnFocus(); };
  // Esc and a click outside ask the form first: it asks before discarding what was entered.
  const askClose = () => { if (cancelForm.current) cancelForm.current(closeForm); else closeForm(); };

  const runTest = async (g: GrafanaOut) => {
    setTests((t) => ({ ...t, [g.id]: "busy" }));
    try {
      const out = await testGrafana(g.id);
      setTests((t) => ({ ...t, [g.id]: testWords(out) }));
    } catch (err) {
      setTests((t) => ({ ...t, [g.id]: { ok: false, text: failure(err, "test again") } }));
    }
  };

  const confirmRemove = async () => {
    if (!removing || remove.isPending) return;
    setRemoveError(null);
    try {
      await remove.mutateAsync(removing.id);
      setRemoving(null);
      returnFocus();
    } catch (err) {
      setRemoveError(failure(err, "try again"));
    }
  };

  const list = connections.data;
  const editingOne = editing?.kind === "edit" ? list?.find((g) => g.id === editing.id) : undefined;
  const formTitle = editingOne ? `Edit ${editingOne.name}` : "Connect a Grafana";
  const showForm = editing?.kind === "new" || editingOne !== undefined;

  // The connection being edited went (removed in another tab): close the form and say why.
  const vanished = editing?.kind === "edit" && list !== undefined && editingOne === undefined;
  useEffect(() => {
    if (!vanished) return;
    setEditing(null);
    setGone(true);
    returnFocus();
  }, [vanished, returnFocus]);

  return (
    <section className={s.section} aria-labelledby={`${ids}-h`}>
      <header className={s.head}>
        <h2 id={`${ids}-h`} ref={heading} tabIndex={-1} className={s.title}>Grafana connections</h2>
        <button type="button" className={s.secondary} onClick={(e) => openForm({ kind: "new" }, e.currentTarget)}>Connect a Grafana</button>
      </header>

      {/* A status, not an alert: the Sources page's own failure is the one to hear first. */}
      {connections.isError && !list && (
        <div className={s.note} role="status">
          <p>{failure(connections.error, "try again")}</p>
          <button type="button" className={s.secondary} onClick={() => void connections.refetch()}>Try again</button>
        </div>
      )}
      {!list && !connections.isError && <p className={s.note} role="status">Loading Grafana connections…</p>}
      {gone && <p className={s.note} role="status">{GRAFANA_GONE}</p>}
      {list && list.length === 0 && <p className={s.empty}>No Grafana connected. Connect one here or from Import.</p>}

      {list && list.length > 0 && (
        <ul className={s.list}>
          {list.map((g) => {
            const test = tests[g.id];
            return (
              <li key={g.id} className={s.row}>
                <span className={s.mark} aria-hidden="true">G</span>
                <div className={s.main}>
                  <span className={s.name}>{g.name}</span>
                  <span className={s.where}>{rowWhere(g)}</span>
                </div>
                <span className={s.imported}>{importedWords(g.dashboards_imported)}</span>
                <div className={s.buttons}>
                  <button type="button" className={s.quiet} aria-label={`Test ${g.name}`} aria-disabled={test === "busy" || undefined}
                    onClick={() => { if (test !== "busy") void runTest(g); }}>
                    {test === "busy" ? "Testing…" : "Test"}
                  </button>
                  <button type="button" className={s.quiet} aria-label={`Edit ${g.name}`} onClick={(e) => openForm({ kind: "edit", id: g.id }, e.currentTarget)}>Edit</button>
                  <button type="button" className={s.quiet} aria-label={`Remove ${g.name}`}
                    onClick={(e) => { opener.current = e.currentTarget; setRemoveError(null); setRemoving(g); }}>Remove</button>
                </div>
                {test && test !== "busy" && <p className={test.ok ? s.ok : s.bad} role="status">{test.text}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {showForm && (
        <DialogShell provider="monitoring" role="dialog" busy={false} onCancel={askClose} first={noFirst} restoreFocusTo={opener}
          labelledBy={`${ids}-ft`} className={s.dialog}>
          <h2 id={`${ids}-ft`} className={s.dialogTitle}>{formTitle}</h2>
          <GrafanaForm key={editingOne?.id ?? "new"} mode="save" initial={editingOne} labelledBy={`${ids}-ft`} cancelRef={cancelForm}
            leave={{ tabId, page: "sources", title: formTitle }} onSaved={closeForm} onCancel={closeForm} />
        </DialogShell>
      )}

      {removing && (
        <DeleteReviewDialog title={`Remove the connection ${removing.name}?`} action="Remove connection" busy={remove.isPending}
          error={removeError} restoreFocusTo={opener} onCancel={() => { setRemoving(null); setRemoveError(null); }}
          onConfirm={() => void confirmRemove()}>
          <p>{removing.dashboards_imported === 0 ? "No dashboards were imported from it."
            : removing.same_as ? handOverWords(removing.same_as)
            : "Dashboards imported from it stay. To update them from their source later, pick their file."}</p>
        </DeleteReviewDialog>
      )}
    </section>
  );
}
