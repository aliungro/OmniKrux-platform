// New dashboard: a title and where it goes (a project or a group), then Create dashboard. The
// same form, with other words, copies a dashboard (CopyDashboardDialog).
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { DialogShell } from "../../../features/dock/ConfirmDialog";
import { useMonitoringTree } from "../../api/hooks";
import type { TreeOut } from "../../api/types";
import { createDashboard, dashboardKey, useDashboardMutation, type DashboardOut } from "../api";
import { emptyDashboard } from "../schema";
import { freeTitle, ownerIn, titlesOf, type Owner } from "./currentOwner";
import s from "./Create.module.css";

const MAX_TITLE = 120;
const NEW_TITLE = "New dashboard";
const PICK_OWNER = "Pick where the dashboard goes.";
const NEED_TITLE = "Give the dashboard a title.";
const GROUP_HINT = "A group dashboard runs each panel once per project in the group.";

const keyOf = (o: Pick<Owner, "kind" | "id"> | null) => (o ? `${o.kind}:${o.id}` : "");

function ownerOfKey(tree: TreeOut | undefined, key: string): Owner | null {
  const at = key.indexOf(":");
  if (!tree || at < 0) return null;
  const kind = key.slice(0, at);
  return kind === "project" || kind === "group" ? ownerIn(tree, kind, key.slice(at + 1)) : null;
}

/**
 * The form both dialogs share: Title (focused and selected), Goes to (projects, then groups), and
 * the action (Ctrl+Enter, or Enter in Title). A title the owner already uses comes back under Title
 * with the keyboard on it; nowhere picked says so under Goes to.
 */
export function OwnerDialog({ heading, action, busyAction, owner, titleFor, send, restoreFocusTo, onCancel, onDone, note }: {
  heading: string;
  action: string;
  busyAction: string;
  /** Where it goes at first; null: the reader picks. */
  owner: Owner | null;
  /** The title to offer for an owner, until the reader types one. */
  titleFor(owner: Owner | null, tree: TreeOut | undefined): string;
  send(owner: Owner, title: string): Promise<DashboardOut>;
  restoreFocusTo?: RefObject<HTMLElement | null>;
  onCancel(): void;
  onDone(out: DashboardOut): void;
  /** Said above the buttons: what the new dashboard won't have (a copy's alerts). */
  note?: string | null;
}) {
  const id = useId();
  const client = useQueryClient();
  const tree = useMonitoringTree().data;
  const titleRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const [ownerKey, setOwnerKey] = useState(keyOf(owner));
  const picked = ownerOfKey(tree, ownerKey);
  const [title, setTitle] = useState(() => titleFor(owner, tree));
  const typed = useRef(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutation = useDashboardMutation((x: { owner: Owner; title: string }) => send(x.owner, x.title));
  const busy = mutation.isPending;

  // The shell puts the keyboard on Title as it opens; its text is selected, ready to be replaced.
  useEffect(() => { titleRef.current?.select(); }, []);
  // Until the reader types a title, the offered one follows where it goes (and the tree as it loads).
  useEffect(() => {
    if (!typed.current) setTitle(titleFor(picked, tree));
    // `titleFor` is the caller's rule and doesn't change while open.
  }, [ownerKey, tree]);

  const submit = () => {
    if (busy) return;
    setError(null);
    const name = title.trim();
    if (!picked) {
      setOwnerError(PICK_OWNER);
      selectRef.current?.focus();
      return;
    }
    if (name === "") {
      setTitleError(NEED_TITLE);
      titleRef.current?.focus();
      return;
    }
    mutation.mutate({ owner: picked, title: name }, {
      onSuccess: (out) => {
        client.setQueryData(dashboardKey(out.id), out);
        onDone(out);
      },
      onError: (err) => {
        if (err.code === "name_taken") {
          setTitleError(err.message);
          titleRef.current?.focus();
        } else if (err.code === "unknown_owner") {
          setOwnerError(err.message);
          selectRef.current?.focus();
        } else {
          setError(failure(err, "try again"));
          actionRef.current?.focus();
        }
      },
    });
  };

  const projects = tree?.projects ?? [];
  const groups = tree?.groups ?? [];
  const hint = picked?.kind === "group" && !ownerError ? GROUP_HINT : null;
  const describe = (...ids: (string | false | null)[]) => ids.filter(Boolean).join(" ") || undefined;

  return (
    <DialogShell provider="monitoring" role="dialog" busy={busy} onCancel={onCancel} onConfirm={submit} first={titleRef}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-h`} className={s.dialog}>
      <h2 id={`${id}-h`} className={s.dialogTitle}>{heading}</h2>
      <form className={s.form} noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className={s.field}>
          <label htmlFor={`${id}-t`} className={s.label}>Title</label>
          <input id={`${id}-t`} ref={titleRef} className={s.input} type="text" autoComplete="off" maxLength={MAX_TITLE}
            value={title} aria-invalid={titleError ? true : undefined} aria-describedby={describe(titleError && `${id}-te`)}
            onChange={(e) => { typed.current = true; setTitle(e.target.value); setTitleError(null); }} />
          {titleError && <p id={`${id}-te`} className={s.fieldError}>{titleError}</p>}
        </div>
        <div className={s.field}>
          <label htmlFor={`${id}-o`} className={s.label}>Goes to</label>
          <select id={`${id}-o`} ref={selectRef} className={s.select} value={picked ? ownerKey : ""}
            aria-invalid={ownerError ? true : undefined} aria-describedby={describe(ownerError && `${id}-oe`, hint && `${id}-oh`)}
            onChange={(e) => { setOwnerKey(e.target.value); setOwnerError(null); }}>
            {!picked && <option value="">Choose a project or group…</option>}
            {projects.length > 0 && (
              <optgroup label="Projects">
                {projects.map((p) => <option key={p.id} value={keyOf({ kind: "project", id: p.id })}>{p.name}</option>)}
              </optgroup>
            )}
            {groups.length > 0 && (
              <optgroup label="Groups">
                {groups.map((g) => <option key={g.id} value={keyOf({ kind: "group", id: g.id })}>{g.name}</option>)}
              </optgroup>
            )}
          </select>
          {ownerError && <p id={`${id}-oe`} className={s.fieldError}>{ownerError}</p>}
          {hint && <p id={`${id}-oh`} className={s.hint}>{hint}</p>}
        </div>
        {note && <p className={s.hint}>{note}</p>}
        {error && <p className={s.error} role="alert">{error}</p>}
        <div className={s.actions}>
          <button type="button" className={s.secondary} aria-disabled={busy || undefined} onClick={() => { if (!busy) onCancel(); }}>Cancel</button>
          <button ref={actionRef} type="submit" className={s.primary} aria-disabled={busy || undefined} aria-keyshortcuts="Control+Enter">
            {busy ? busyAction : action}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

/** New dashboard: an empty dashboard for the picked project or group. */
export function NewDashboardDialog({ owner, restoreFocusTo, onCancel, onCreated }: {
  owner: Owner | null;
  restoreFocusTo?: RefObject<HTMLElement | null>;
  onCancel(): void;
  onCreated(out: DashboardOut): void;
}) {
  return (
    <OwnerDialog heading="New dashboard" action="Create dashboard" busyAction="Creating…" owner={owner}
      titleFor={(o, tree) => (o && tree ? freeTitle(NEW_TITLE, titlesOf(tree, o)) : NEW_TITLE)}
      send={(o, title) => createDashboard({ owner_kind: o.kind, owner_id: o.id, spec: emptyDashboard(title) })}
      restoreFocusTo={restoreFocusTo} onCancel={onCancel} onDone={onCreated} />
  );
}
