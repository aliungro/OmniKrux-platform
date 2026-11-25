// Attach a page rule to a panel of its project's or group's dashboard: the dashboard saves a new
// version with the alert on that panel, and the rule lives there from then on. Only panels that can
// take an alert can be picked; the others are listed, off, with why.

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { DialogShell } from "../../../features/dock/ConfirmDialog";
import { dashboardKey, getDashboard, useOwnerDashboards, type DashboardOut, type DashboardRequestError } from "../../dashboards/api";
import { ALERT_PANEL_TYPES, type PanelSpec } from "../../dashboards/schema";
import { attachRule, type AttachOut, type RuleOut } from "../api";
import s from "./RuleForm.module.css";

export const attachTitle = (name: string) => `Attach "${name}" to a panel`;
export const attachedWords = (panel: string) => `Attached. The rule now lives on the panel "${panel}".`;
export const NO_DASHBOARDS = "There are no dashboards here yet. Make one, then attach the rule to one of its panels.";
export const NO_PANEL = "No panel on this dashboard can take this alert.";

const panelName = (p: PanelSpec) => p.title.trim() || "Untitled panel";

/** Why a panel can't take the alert, or null when it can. */
export function panelRefusal(p: PanelSpec): string | null {
  if (!ALERT_PANEL_TYPES.includes(p.type)) return "can't have an alert";
  if (p.alert !== null) return "has an alert";
  return null;
}

export function AttachDialog({ rule, restoreFocusTo, onCancel, onAttached }: {
  rule: RuleOut;
  restoreFocusTo: RefObject<HTMLElement | null>;
  onCancel(): void;
  onAttached(out: AttachOut, panelTitle: string): void;
}) {
  const id = useId();
  const go = useRef<HTMLButtonElement>(null);
  const boards = useOwnerDashboards({ kind: rule.scope.kind, id: rule.scope.id });
  const [boardId, setBoardId] = useState<string | null>(null);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = boards.data ?? [];
  const chosenBoard = boardId ?? list[0]?.id ?? null;
  const board = useQuery<DashboardOut, DashboardRequestError>({
    queryKey: dashboardKey(chosenBoard ?? ""), queryFn: ({ signal }) => getDashboard(chosenBoard as string, signal),
    enabled: chosenBoard !== null, retry: false,
  });
  const panels = board.data?.id === chosenBoard ? board.data.spec.panels : [];
  const firstOpen = panels.find((p) => panelRefusal(p) === null)?.id ?? null;
  const chosenPanel = panelId !== null && panels.some((p) => p.id === panelId && panelRefusal(p) === null) ? panelId : firstOpen;
  const ready = !busy && board.data !== undefined && chosenPanel !== null;

  // Back from an attach that didn't go through: the keyboard returns to Attach.
  useEffect(() => { if (!busy) go.current?.focus(); }, [busy]);

  const attach = async () => {
    if (!ready || !board.data || chosenPanel === null) return;
    const panel = panels.find((p) => p.id === chosenPanel)!;
    setBusy(true);
    setError(null);
    try {
      const out = await attachRule(rule.id, { dashboard_id: board.data.id, panel_id: chosenPanel, base_version: board.data.version });
      onAttached(out, panelName(panel));
      return;
    } catch (err) {
      setError(failure(err, "try again"));
      // Saved somewhere else meanwhile: read it again, so the next Attach starts from it.
      void board.refetch();
    }
    setBusy(false);
  };

  let body;
  if (boards.isError) body = <p className={s.dialogBody} role="alert">{failure(boards.error, "try again")}</p>;
  else if (!boards.data) body = <p className={s.dialogBody} role="status">Loading…</p>;
  else if (list.length === 0) body = <p className={s.dialogBody}>{NO_DASHBOARDS}</p>;
  else {
    body = (
      <div className={s.fields}>
        <div className={s.field}>
          <label htmlFor={`${id}-d`} className={s.label}>Dashboard</label>
          <select id={`${id}-d`} className={s.input} value={chosenBoard ?? ""} disabled={busy}
            onChange={(e) => { setBoardId(e.target.value); setPanelId(null); setError(null); }}>
            {list.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </select>
        </div>
        <div className={s.field}>
          <label htmlFor={`${id}-p`} className={s.label}>Panel</label>
          {board.isError ? <p className={s.fieldError}>{failure(board.error, "try again")}</p>
            : board.data?.id !== chosenBoard ? <p className={s.help} role="status">Loading…</p>
            : (
              <>
                <select id={`${id}-p`} className={s.input} value={chosenPanel ?? ""} disabled={busy}
                  onChange={(e) => { setPanelId(e.target.value); setError(null); }}>
                  {chosenPanel === null && <option value="">{NO_PANEL}</option>}
                  {panels.map((p) => {
                    const why = panelRefusal(p);
                    return <option key={p.id} value={p.id} disabled={why !== null}>{why ? `${panelName(p)} (${why})` : panelName(p)}</option>;
                  })}
                </select>
                {chosenPanel === null && <p className={s.help}>{NO_PANEL}</p>}
              </>
            )}
        </div>
      </div>
    );
  }

  return (
    <DialogShell provider="monitoring" role="dialog" busy={busy} onCancel={onCancel} onConfirm={() => void attach()} first={go}
      restoreFocusTo={restoreFocusTo} labelledBy={`${id}-t`} className={s.dialog}>
      <h2 id={`${id}-t`} className={s.dialogTitle}>{attachTitle(rule.name)}</h2>
      <p className={s.dialogBody}>The dashboard saves a new version with the rule as its panel's alert.</p>
      {body}
      {error && <p className={s.formError} role="alert">{error}</p>}
      <div className={s.dialogActions}>
        <button type="button" className={s.secondary} aria-disabled={busy || undefined} onClick={() => { if (!busy) onCancel(); }}>Cancel</button>
        <button ref={go} type="button" className={s.primary} aria-disabled={!ready || undefined} aria-keyshortcuts="Control+Enter"
          onClick={() => void attach()}>
          Attach
        </button>
      </div>
    </DialogShell>
  );
}
