// A dashboard: header, Updated line, ready-made note, variables and the panel grid; the JSON tab
// (the document, edited live) and, for a saved dashboard, the Versions tab. Edit turns the grid
// into tiles and the header into Discard and Save dashboard (edit mode, kept per workspace tab).
// Time, variables, auto-refresh and the view tab live in the tab's view (replace navigations).
// "+ Add panel" (and `a`) open Add panel's search; what it adds goes into the edit draft.
// A link to a panel (`panel`) scrolls to it and flashes it; `editAlert` opens edit mode on that
// panel's Alert tab. A panel's alert badge and its Alert tab open the rule on the Alerts page.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../../api/http";
import { isEditable, pressed } from "../../../features/chrome/shortcuts";
import { AddPanelSearch } from "../../build/AddPanelSearch";
import { useFlyIn } from "../../build/flyIn";
import { RailLayout, SuggestionsRail } from "../../build/SuggestionsRail";
import { focusMainFrom } from "../../focus";
import type { MonitoringPageProps } from "../../MonitoringApp";
import { Gone, keyboardIsFree } from "../../pages/Gone";
import { MONITORING_HOME, type MonitoringView } from "../../shell/tabState";
import { refreshAfterDashboardChange, useDashboard, useReadyMade, type DashboardOut, type DashboardRequestError } from "../api";
import { focusHeadingOnArrival, forgetArrival, openMade, peekArrival, useCopyToEdit } from "../create/arrival";
import { CopyDashboardDialog } from "../create/CopyDashboardDialog";
import { DeleteDashboardDialog } from "../create/DeleteDashboardDialog";
import type { VarValue } from "../interpolate";
import type { NewPanel } from "../layout";
import type { RefreshSpec, TimeSpec } from "../schema";
import { DashboardGrid, type GridControls } from "../grid/DashboardGrid";
import { usePrefersReducedMotion } from "../motion";
import { DiscardDialog, EditControls, EditingPill, EditNotice } from "../editor/EditBar";
import { hasUnsavedWork, isDraftEdit, JSON_FIRST, type EditorAction, type EditorState } from "../editor/editorState";
import { SaveConflict } from "../editor/SaveConflict";
import { editSessions, useDashboardEditor } from "../editor/useDashboardEditor";
import { DraftBanner, DraftsOffNotice, EditedElsewhere } from "../drafts/DraftBanner";
import { forgetSession, useDraftOffer } from "../drafts/useDraft";
import { readDraft, removeDraft, type StoredDraft } from "../drafts/draftStore";
import { JsonTab, ReadyMadeJson } from "../json/JsonTab";
import { VersionsTab } from "../versions/VersionsTab";
import e from "../editor/EditBar.module.css";
import { DashboardHeader, type DashboardTab, type MenuAction } from "./DashboardHeader";
import { pageLetter } from "./keys";
import { RefreshControl } from "./RefreshControl";
import { TimeRangePicker } from "./TimeRangePicker";
import { PROJECTS_VAR, useDashboardContext, usePanelStatus, type DashboardViewState, type PanelStatusStore } from "./useDashboardContext";
import { VariablesBar } from "./VariablesBar";
import s from "./DashboardPage.module.css";

const two = (n: number) => String(n).padStart(2, "0");
const clockTime = (ms: number) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
/** The keyboard is nowhere: on <body>, or on something that just went away. */
const focusLost = () => { const a = document.activeElement; return a === null || a === document.body || !a.isConnected; };

/** When the data was last read: the oldest panel read of the current set, or Updating… while any loads. */
function UpdatedLine({ status }: { status: PanelStatusStore }) {
  const { updatedAt, updating } = usePanelStatus(status);
  const text = updating ? "Updating…" : updatedAt !== null ? `Updated ${clockTime(updatedAt)}` : null;
  return <p className={s.updated} data-updating={updating || undefined}>{text}</p>;
}

/** Under a ready-made view's header: where it comes from, and what its project's Prometheus lacks. */
function ReadyNote({ dashboard }: { dashboard: DashboardOut }) {
  const ready = useReadyMade(dashboard.owner_id);
  const notes = ready.data?.find((r) => r.id === dashboard.id)?.notes ?? [];
  return (
    <div className={s.readyNote}>
      <p className={s.readyLine}>Ready-made views are generated from what {dashboard.owner_name}'s Prometheus has. Copy one to change it.</p>
      {notes.map((n) => <p key={n} className={s.readyLine}>{n}</p>)}
    </div>
  );
}

/**
 * A background re-read of the dashboard failed (window focus, after a save, after a refused save)
 * while the page already shows it: the page and any edit session stay, and this says why in place.
 */
export interface RereadFailure {
  error: DashboardRequestError;
  retrying: boolean;
  retry(): void;
}

/** Said above the tabs while the dashboard couldn't be read again; the page shows it as last read. */
function RereadNotice({ failed, buttonRef }: { failed: RereadFailure; buttonRef: RefObject<HTMLButtonElement | null> }) {
  return (
    <div className={e.notice} data-kind="reread" role="alert">
      <p className={e.noticeLine}>Couldn't read this dashboard again, so it shows as last read. {failure(failed.error, "try again")}</p>
      <button ref={buttonRef} type="button" className={e.noticeAction} aria-disabled={failed.retrying || undefined}
        onClick={() => { if (!failed.retrying) failed.retry(); }}>
        {failed.retrying ? "Trying again…" : "Try again"}
      </button>
    </div>
  );
}

function DashboardScreen({ view, tabId, dashboard, reread, nav, openInNewTab, activateTab }: MonitoringPageProps & {
  view: DashboardViewState;
  dashboard: DashboardOut;
  reread: RereadFailure | null;
}) {
  const ready = dashboard.ready_made;
  const editButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  // A save's cluster reviews open over the saved dashboard; the keyboard comes back to Edit after.
  const editor = useDashboardEditor(dashboard.id, tabId, {
    reviewFocus: (stillEditing) => (stillEditing ? saveButton.current : editButton.current),
  });
  const editing = editor.state.mode === "edit" ? editor.state : null;
  // In edit mode the page shows the draft; the saved document otherwise.
  const spec = editing ? editing.draft : dashboard.spec;
  const ctx = useDashboardContext(view, spec, dashboard.owner_kind, dashboard.owner_id);
  // Ready-made views have no versions (their ids answer 404 there).
  const tabs: DashboardTab[] = ready ? ["dashboard", "json"] : ["dashboard", "json", "versions"];
  const tab: DashboardTab = view.tab && tabs.includes(view.tab) ? view.tab : "dashboard";

  const base = useId();
  const titleId = `${base}-title`;
  const tabIds = useCallback((t: DashboardTab) => ({ tab: `${base}-tab-${t}`, panel: `${base}-panel-${t}` }), [base]);
  const title = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<Partial<Record<DashboardTab, HTMLButtonElement | null>>>({});
  const timeButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const discardButton = useRef<HTMLButtonElement>(null);
  const page = useRef<HTMLElement>(null);
  const [timeOpen, setTimeOpen] = useState(false);
  /** Asking before Discard drops changes; the keyboard goes back to the Discard it came from. */
  const [askDiscard, setAskDiscard] = useState<RefObject<HTMLButtonElement | null> | null>(null);
  /** The JSON tab's typing that hasn't paused yet: Save and Discard apply it first. */
  const flushJson = useRef<(() => EditorState | null) | null>(null);

  // A draft left behind (a reload, Browser Back, Keep draft and leave) is offered back when the
  // page opens without a live session; not while another tab has unsaved changes to this dashboard.
  const offer = useDraftOffer(dashboard.id, !ready && editor.state.mode === "view"
    && ![...editSessions.values()].some((x) => x.mode === "edit" && x.dashboardId === dashboard.id && hasUnsavedWork(x)));
  // Editing replaces the offer: the stored draft became the session's, or new changes replace it.
  const { dismiss: dismissOffer } = offer;
  useEffect(() => { if (editing) dismissOffer(); }, [editing, dismissOffer]);

  // One edit session per dashboard in this window: another tab already editing it is where to go.
  const [elsewhere, setElsewhere] = useState<string | null>(null);
  const goElsewhere = useRef<HTMLButtonElement>(null);
  const editingTab = () => {
    for (const [t, x] of editSessions) if (t !== tabId && x.mode === "edit" && x.dashboardId === dashboard.id) return t;
    return null;
  };
  /**
   * Edit, or Restore draft: a stored draft is where editing starts (Discard draft starts afresh).
   * Its base stays the version it started from, so a save over a newer one is reviewed first.
   * False: another tab of this window edits it, and the page says so.
   */
  const startEditing = (offered: StoredDraft | null): boolean => {
    const other = editingTab();
    setElsewhere(other);
    if (other) return false;
    const d = readDraft(dashboard.id) ?? offered;
    if (d) editor.restore(d, dashboard.spec, dashboard.owner_kind);
    else editor.dispatch({ type: "start", dashboardId: dashboard.id, version: dashboard.version, spec: dashboard.spec });
    offer.dismiss();
    return true;
  };
  useLayoutEffect(() => { if (elsewhere) goElsewhere.current?.focus(); }, [elsewhere]);
  const restoreDraft = () => startEditing(offer.draft);
  // Asked again on the press: a tab that is gone or stopped editing leaves editing to this one.
  const goToEditingTab = () => {
    const other = editingTab();
    if (other) activateTab(other);
    else startEditing(null);
  };
  const discardDraft = () => {
    offer.discard();
    title.current?.focus({ preventScroll: true });
  };

  // The page opens with the keyboard on its title, unless the user is working elsewhere (Find, the tree).
  useEffect(() => { if (keyboardIsFree()) title.current?.focus({ preventScroll: true }); }, []);

  // Just made or copied here: in edit mode with the keyboard on + Add panel (and a word on what it
  // is), or as it is with the keyboard on its title. Read once: a later visit opens as usual.
  const [arrival] = useState(() => peekArrival(dashboard.id));
  const [arrivedWords, setArrivedWords] = useState("");
  const toAddTile = useRef(false);
  useEffect(() => {
    if (!arrival) return;
    forgetArrival(dashboard.id);
    if (arrival.edit && !ready && editor.state.mode === "view" && startEditing(null)) {
      toAddTile.current = true;
      setArrivedWords(arrival.status ?? "");
    } else {
      title.current?.focus({ preventScroll: true });
    }
    // Once, as the page opens.
  }, []);

  // View state changes replace the view: Back still goes to where the user came from.
  const replace = useCallback((patch: Partial<DashboardViewState>) => {
    nav.navigate((v) => (v.page === "dashboard" && v.id === view.id ? { ...v, ...patch } : v), "replace");
  }, [nav, view.id]);
  const setVar = useCallback((name: string, value: VarValue) => {
    nav.navigate((v) => (v.page === "dashboard" && v.id === view.id ? { ...v, vars: { ...v.vars, [name]: value } } : v), "replace");
  }, [nav, view.id]);
  const selectTab = useCallback((t: DashboardTab) => {
    replace({ tab: t });
    tabRefs.current[t]?.focus();
  }, [replace]);
  const pickTime = (t: TimeSpec) => {
    setTimeOpen(false);
    replace({ time: t });
    timeButton.current?.focus();
  };
  const closeTime = useCallback((restore: boolean) => {
    setTimeOpen(false);
    if (restore) timeButton.current?.focus();
  }, []);
  const refreshNow = useCallback(() => {
    ctx.refreshNow();
    refreshButton.current?.focus();
  }, [ctx]);
  // Copy to edit (a ready-made view): copied into its project as it is, then opened in edit mode.
  const opener = { tabId, nav, openInNewTab };
  const copyToEdit = useCopyToEdit(opener);
  const edit = ready ? () => copyToEdit.copy(dashboard.id, dashboard.owner_id) : () => { startEditing(null); };
  const save = () => {
    flushJson.current?.();
    return editor.save();
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  // Changes, or JSON text that doesn't apply yet, are asked about first.
  const discard = (from: RefObject<HTMLButtonElement | null> = discardButton) => {
    const st = flushJson.current?.() ?? editor.state;
    if (hasUnsavedWork(st)) setAskDiscard(from);
    else editor.discard();
  };
  // Restoring a version under a draft or an edit session (here, another tab, another window) would
  // leave that draft based on a version that is no longer current: it is refused.
  const restoreBlocked = () => editor.state.mode === "edit" || readDraft(dashboard.id) !== null
    || [...editSessions.values()].some((x) => x.mode === "edit" && x.dashboardId === dashboard.id);

  // Add panel's search. Esc goes back to what opened it; an add puts the keyboard on the new tile
  // once the search has gone (an effect, so the dialog's own focus return comes first).
  const grid = useRef<GridControls | null>(null);
  const searchOpener = useRef<HTMLElement | null>(null);
  const [searching, setSearching] = useState(false);
  const [refused, setRefused] = useState<{ text: string; attempt: number } | null>(null);
  const [added, setAdded] = useState<{ kind: "panel"; id: string; title: string } | { kind: "empty" } | null>(null);
  const { launch, tileRef } = useFlyIn();
  const openSearch = useCallback((opener: HTMLElement | null) => {
    searchOpener.current = opener;
    setRefused(null);
    setSearching(true);
  }, []);
  /** While the JSON text doesn't apply, nothing is added (it would drop that text): the search stays open and says why. */
  const jsonBlocks = (action: EditorAction) => {
    const st = editor.state;
    return st.mode === "edit" && st.jsonText !== null && isDraftEdit(action);
  };
  const refusedByJson = (action: EditorAction) => {
    if (!jsonBlocks(action)) return false;
    grid.current?.announce(JSON_FIRST);
    setRefused((was) => ({ text: JSON_FIRST, attempt: (was?.attempt ?? 0) + 1 }));
    return true;
  };
  const addFromSearch = (panel: NewPanel, from: DOMRect) => {
    const action: EditorAction = { type: "insertPanel", panel, select: false };
    if (editor.state.mode !== "edit" || refusedByJson(action)) return;
    editor.dispatch(action);
    launch(panel.id, from);
    searchOpener.current = null;
    setSearching(false);
    setAdded({ kind: "panel", id: panel.id, title: panel.title.trim() || "Untitled panel" });
  };
  // The suggestions rail (D2): an add flies the card to its tile and leaves the keyboard in the rail.
  const [flying, setFlying] = useState<string | null>(null);
  const addFromRail = (panel: NewPanel, from: DOMRect): boolean => {
    const action: EditorAction = { type: "insertPanel", panel, select: false };
    // Refused while the JSON text doesn't apply: the rail says why in its own live region.
    if (editor.state.mode !== "edit" || jsonBlocks(action)) return false;
    editor.dispatch(action);
    launch(panel.id, from);
    setFlying(panel.id);
    return true;
  };
  useEffect(() => {
    if (flying === null) return;
    setFlying(null);
    const tile = Array.from(page.current?.querySelectorAll<HTMLElement>("[data-tile-id]") ?? []).find((t) => t.dataset.tileId === flying);
    if (tile) tileRef(flying)(tile);
  }, [flying, tileRef]);
  const toAddPanel = () => (page.current?.querySelector<HTMLElement>("[data-add-tile]") ?? saveButton.current)?.focus();
  const hideSuggestions = () => {
    toAddPanel();
    editor.dispatch({ type: "suggestions", open: false });
  };
  const emptyFromSearch = () => {
    if (editor.state.mode !== "edit" || refusedByJson({ type: "addPanel", panelType: "timeseries" })) return;
    searchOpener.current = null;
    setSearching(false);
    setAdded({ kind: "empty" });
  };
  useEffect(() => {
    if (!added) return;
    setAdded(null);
    const g = grid.current;
    if (!g) return;
    // Empty panel is M2's: settings open on Query with the keyboard in Query A.
    if (added.kind === "empty") {
      g.addEmpty();
      return;
    }
    const tile = g.focusPanel(added.id);
    if (tile) tileRef(added.id)(tile);
    g.announce(`Added "${added.title}". Enter opens its settings.`);
  }, [added, tileRef]);

  // Edit mode ended (saved or discarded): the keyboard goes to Edit, never to <body>.
  const isEditing = editing !== null;
  const wasEditing = useRef(isEditing);
  // Edit mode started where no grid takes the keyboard (the JSON tab, an owner failure): Edit
  // went away under it, so it goes to Save dashboard. With the grid, the first tile already has it.
  useLayoutEffect(() => {
    if (wasEditing.current && !isEditing) {
      setAskDiscard(null);
      setSearching(false);
      editButton.current?.focus();
    } else if (!wasEditing.current && isEditing && focusLost()) {
      saveButton.current?.focus();
    }
    wasEditing.current = isEditing;
  }, [isEditing]);
  useLayoutEffect(() => {
    if (!isEditing || !toAddTile.current) return;
    toAddTile.current = false;
    (page.current?.querySelector<HTMLElement>("[data-add-tile]") ?? saveButton.current)?.focus();
  }, [isEditing]);

  // The conflict review closed because the draft itself was refused (422): the keyboard goes to
  // Show in JSON, or Save dashboard.
  const conflictShown = editor.conflict !== null;
  const hadConflict = useRef(conflictShown);
  const showInJson = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (hadConflict.current && !conflictShown && isEditing && focusLost()) (showInJson.current ?? saveButton.current)?.focus();
    hadConflict.current = conflictShown;
  }, [conflictShown, isEditing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pageLetter(e)) return;
      if (pressed("dashboardViews", e)) {
        const t = tabs[Number(e.key) - 1];
        if (!t) return;
        e.preventDefault();
        selectTab(t);
      } else if (pressed("dashboardTime", e)) {
        e.preventDefault();
        setTimeOpen(true);
      } else if (pressed("dashboardRefresh", e)) {
        e.preventDefault();
        refreshNow();
      } else if (pressed("dashboardEdit", e) && !ready && !editing) {
        e.preventDefault();
        editButton.current?.focus();
        edit?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Ctrl+S (Cmd+S) while editing saves, from this page's fields too (F7). It is caught before the
  // page's own handlers (dialogs keep their keys to themselves): with a dialog open it saves
  // nothing, but the browser's Save dialog never opens either. Outside edit mode it's the browser's.
  useEffect(() => {
    if (!isEditing) return;
    const onSave = (e: KeyboardEvent) => {
      if (!pressed("dashboardSave", e) || e.defaultPrevented) return;
      const t = e.target;
      const here = t instanceof Node && !!page.current?.contains(t);
      if (!here && isEditable(t)) return;
      e.preventDefault();
      if (document.querySelector('[aria-modal="true"]') !== null || e.repeat) return;
      void saveRef.current();
    };
    document.addEventListener("keydown", onSave, true);
    return () => document.removeEventListener("keydown", onSave, true);
  }, [isEditing]);

  // The owner read failed and Try again worked: its button went with the message, and the
  // keyboard goes to the title rather than <body>.
  const ownerRetry = useRef<HTMLButtonElement>(null);
  const failed = ctx.ownerFailure !== null;
  const wasFailed = useRef(failed);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (wasFailed.current && !failed && (active === null || active === document.body)) title.current?.focus({ preventScroll: true });
    wasFailed.current = failed;
  }, [failed]);
  // The same for the dashboard's own re-read: its Try again went with the notice.
  const rereadRetry = useRef<HTMLButtonElement>(null);
  const rereadFailed = reread !== null;
  const wasRereadFailed = useRef(rereadFailed);
  useLayoutEffect(() => {
    if (wasRereadFailed.current && !rereadFailed && focusLost()) title.current?.focus({ preventScroll: true });
    wasRereadFailed.current = rereadFailed;
  }, [rereadFailed]);

  const openPage = (target: MonitoringView, e: MouseEvent<HTMLAnchorElement>) =>
    (e.ctrlKey || e.metaKey ? openInNewTab(target) : nav.navigate(target, "push"));
  // A panel's alert (its badge, its Alert tab): the rule on the Alerts page. The same function
  // across renders, so panels don't render again for it.
  const ways = useRef({ nav, openInNewTab });
  ways.current = { nav, openInNewTab };
  const openRule = useCallback((rule: string, newTab: boolean) => {
    const target: MonitoringView = { page: "alerts", rule };
    if (newTab) ways.current.openInNewTab(target);
    else ways.current.nav.navigate(target, "push");
  }, []);

  // A link to a panel: it is scrolled into view and flashes; with `editAlert`, edit mode opens on
  // its Alert tab with the keyboard on Threshold. Both are done once, then left out of the view
  // (replaced: Back still goes where the user came from); a later link to the same dashboard is a
  // view change here (the page stays), so it is acted on as it comes.
  const reduced = usePrefersReducedMotion();
  const [spotlight, setSpotlight] = useState<{ id: string; seq: number } | null>(null);
  const alertArrival = useRef<string | null>(null);
  /** Renders again so the Alert tab opens once the grid can take it. */
  const [, setAlertSeq] = useState(0);
  const linkKey = view.panel ? `${view.panel}:${view.editAlert ? "edit" : "view"}` : "";
  useEffect(() => {
    const id = view.panel;
    if (!id) return;
    const wantsAlert = view.editAlert === true;
    nav.navigate((v) => {
      if (v.page !== "dashboard" || v.id !== view.id) return v;
      const rest = { ...v };
      delete rest.panel;
      delete rest.editAlert;
      return wantsAlert && rest.tab !== undefined && rest.tab !== "dashboard" ? { ...rest, tab: undefined } : rest;
    }, "replace");
    if (!spec.panels.some((p) => p.id === id)) return;
    const el = Array.from(page.current?.querySelectorAll<HTMLElement>("[data-panel-id]") ?? []).find((x) => x.dataset.panelId === id);
    el?.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
    setSpotlight((was) => ({ id, seq: (was?.seq ?? 0) + 1 }));
    if (!wantsAlert || ready) return;
    if (editor.state.mode === "edit" || startEditing(null)) {
      alertArrival.current = id;
      setAlertSeq((n) => n + 1);
    }
    // Acted on as each link arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey]);
  // Once edit mode is on and the grid can take it: the panel's settings, on its Alert tab.
  useLayoutEffect(() => {
    const id = alertArrival.current;
    if (id === null || editor.state.mode !== "edit" || !grid.current) return;
    alertArrival.current = null;
    grid.current.openPanel(id, "alert");
  });

  // A save refused for a panel's alert (a contact point that's gone): that panel's Alert tab, with
  // its words under the field and the keyboard there.
  const refusal = editor.saveError;
  useEffect(() => {
    if (!refusal || refusal.code !== "invalid_dashboard" || editor.state.mode !== "edit") return;
    const at = refusal.problems.map((p) => /^panels\[(\d+)\]\.alert(?:[.[]|$)/.exec(p.path)).find((m) => m !== null);
    const panel = at ? editor.state.draft.panels[Number(at[1])] : undefined;
    if (!panel) return;
    alertArrival.current = panel.id;
    setAlertSeq((n) => n + 1);
    // Once per refusal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refusal]);
  // Save refused because an alert's threshold isn't a number: that panel's Alert tab, keyboard on
  // Threshold (each press of Save brings it back there).
  const alertRefused = editor.alertRefused;
  useEffect(() => {
    if (alertRefused === null || editor.state.mode !== "edit") return;
    alertArrival.current = alertRefused.panelId;
    setAlertSeq((n) => n + 1);
    // Once per refused save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertRefused]);
  const ownerView = { page: dashboard.owner_kind, id: dashboard.owner_id } as const;
  const openOwner = (e: MouseEvent<HTMLAnchorElement>) => openPage(ownerView, e);
  const [asking, setAsking] = useState<"copy" | "delete" | null>(null);
  const copyAction: MenuAction = { label: "Copy dashboard…", onSelect: () => setAsking("copy") };
  const actions: MenuAction[] = ready ? [copyAction] : [copyAction, { label: "Delete dashboard…", danger: true, onSelect: () => setAsking("delete") }];
  const client = useQueryClient();
  // Gone: its draft (whoever wrote it: the reader asked for it to go) and every edit session on
  // it, then the tab shows its owner, with the keyboard on the owner's heading.
  const deleted = () => {
    // The page and the dialog's opener go away: the keyboard waits on the workspace until the
    // owner's heading takes it, and stays there if that page can't be shown.
    focusMainFrom(page.current);
    removeDraft(dashboard.id);
    for (const [t, x] of [...editSessions]) {
      if (x.mode !== "edit" || x.dashboardId !== dashboard.id) continue;
      editSessions.delete(t);
      forgetSession(t);
    }
    focusHeadingOnArrival(dashboard.owner_kind, dashboard.owner_id);
    nav.navigate(ownerView, "replace");
    void refreshAfterDashboardChange(client, dashboard.id);
  };
  const ids = tabIds(tab);

  const { saveError, conflict } = editor;
  const otherError = saveError && saveError.code !== "version_conflict" ? saveError : null;
  const saveProblems = saveError?.code === "invalid_dashboard" ? saveError.problems : undefined;

  return (
    <section ref={page} className={s.page} aria-labelledby={titleId}>
      <DashboardHeader title={spec.title || dashboard.title} titleId={titleId} titleRef={title}
        ownerName={dashboard.owner_name || ctx.ownerName} onOwner={openOwner} readyMade={ready}
        tabs={tabs} tab={tab} tabIds={tabIds} onTab={selectTab} tabRefs={tabRefs}
        timeControl={<TimeRangePicker time={ctx.time} open={timeOpen} onOpen={() => setTimeOpen(true)} onClose={closeTime} onPick={pickTime} buttonRef={timeButton} />}
        refreshControl={<RefreshControl value={ctx.refresh} onRefresh={refreshNow} buttonRef={refreshButton}
          onChange={(r: RefreshSpec) => replace({ refresh: r })} />}
        editRef={editButton} onEdit={copyToEdit.busy ? undefined : edit} moreRef={moreButton} actions={actions}
        badge={editing ? <EditingPill /> : undefined}
        afterTitle={offer.draft && !editing
          ? <DraftBanner draft={offer.draft} version={dashboard.version} onRestore={restoreDraft} onDiscard={discardDraft} />
          : undefined}
        editControls={editing
          ? <EditControls saving={editor.saving} onDiscard={() => discard()} onSave={() => { void save(); }} discardRef={discardButton} saveRef={saveButton} />
          : undefined} />
      {reread && <RereadNotice failed={reread} buttonRef={rereadRetry} />}
      {editing && !editor.draftsWork && <DraftsOffNotice />}
      {!editing && elsewhere && <EditedElsewhere buttonRef={goElsewhere} onGo={goToEditingTab} />}
      <p className={s.arrived} role="status">{editing ? arrivedWords : ""}</p>
      {copyToEdit.error && <p className={s.copyProblem} role="alert">{copyToEdit.error.text}</p>}
      {editing && conflict !== null && (
        <SaveConflict version={conflict} saved={dashboard} draft={editing.draft} saving={editor.saving} error={otherError}
          onSaveOver={(version, base) => { void editor.saveOver(version, base); }} />
      )}
      {editing && conflict === null && otherError && <EditNotice error={otherError} onShowJson={() => selectTab("json")} actionRef={showInJson} />}
      {asking === "copy" && (
        <CopyDashboardDialog dashboard={dashboard} restoreFocusTo={moreButton} onCancel={() => setAsking(null)}
          onCopied={(out) => { setAsking(null); openMade(out, { edit: false }, opener); }} />
      )}
      {asking === "delete" && !ready && (
        <DeleteDashboardDialog dashboard={dashboard} restoreFocusTo={moreButton} onCancel={() => setAsking(null)} onDeleted={deleted} />
      )}
      {searching && editing && (
        <AddPanelSearch owner={ctx.owner} ownerName={ctx.ownerName || dashboard.owner_name} ownerKind={dashboard.owner_kind}
          vars={ctx.vars} range={ctx.range} draft={editing.draft} refused={refused}
          onAdd={addFromSearch} onEmpty={emptyFromSearch} onClose={() => setSearching(false)} restoreFocusTo={searchOpener} />
      )}
      {askDiscard && editing && (
        <DiscardDialog title={editing.base.title || dashboard.title} restoreFocusTo={askDiscard}
          onCancel={() => setAskDiscard(null)} onDiscard={() => editor.discard()} />
      )}
      <UpdatedLine status={ctx.status} />
      {ready && <ReadyNote dashboard={dashboard} />}
      <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} className={s.content}>
        {tab === "dashboard" && ctx.ownerFailure && (
          <div className={s.ownerFailure} role="alert">
            <p className={s.ownerProblem}>{ctx.ownerFailure.message}</p>
            <button ref={ownerRetry} type="button" className={s.retry} aria-disabled={ctx.ownerFailure.retrying || undefined}
              onClick={() => { if (!ctx.ownerFailure?.retrying) ctx.ownerFailure?.retry(); }}>
              {ctx.ownerFailure.retrying ? "Trying again…" : "Try again"}
            </button>
          </div>
        )}
        {tab === "dashboard" && editing && editing.jsonProblems.length > 0 && (
          <div className={`${e.notice} ${s.jsonWarning}`} data-kind="json" role="status">
            <p className={e.noticeLine}>The JSON has a problem, so the dashboard shows the last valid version. Fix it on the JSON tab.</p>
            <button type="button" className={e.noticeAction} onClick={() => selectTab("json")}>Go to JSON</button>
          </div>
        )}
        {tab === "dashboard" && !ctx.ownerFailure && (
          <>
            <VariablesBar projects={ctx.projects} projectsLoading={ctx.owner === null} variables={ctx.variables}
              onVar={setVar} onProjects={(value) => setVar(PROJECTS_VAR, value)} onRetry={ctx.retryVariable}
              onOpenProject={(p, e) => openPage({ page: "project", id: p.id }, e)} />
            <RailLayout rail={editing && editing.suggestions === "open" ? (
              <SuggestionsRail owner={ctx.owner} ownerName={ctx.ownerName || dashboard.owner_name}
                ownerKind={dashboard.owner_kind} vars={ctx.vars} range={ctx.range} draft={editing.draft}
                onAdd={addFromRail} onClose={hideSuggestions} onEscape={toAddPanel} />
            ) : null}>
            <DashboardGrid dashboardId={dashboard.id} panels={spec.panels} owner={ctx.owner} ownerName={ctx.ownerName}
              vars={ctx.vars} range={ctx.range} waiting={ctx.waiting} blocked={ctx.blocked} refreshSeq={ctx.refreshSeq} status={ctx.status}
              editor={editing ? {
                state: editing, dispatch: editor.dispatch, ownerKind: dashboard.owner_kind, onLeave: () => saveButton.current?.focus(),
                saveProblems, openRule,
              } : undefined}
              onAddPanel={editing ? openSearch : undefined} controls={grid}
              board={editing !== null && editing.suggestions === "open" && editing.draft.panels.length === 0}
              openRule={openRule} spotlight={spotlight} />
            </RailLayout>
          </>
        )}
        {tab === "json" && (ready
          ? <ReadyMadeJson spec={dashboard.spec} onCopy={copyToEdit.busy ? undefined : edit} />
          : <JsonTab dashboard={dashboard} editing={editing} dispatch={editor.dispatch} onStartEditing={() => startEditing(null)}
              onSave={save} lastSaved={editor.lastSaved} onDiscard={discard} saving={editor.saving} flushRef={flushJson} />)}
        {tab === "versions" && !ready && (
          <VersionsTab dashboard={dashboard} restoreBlocked={restoreBlocked} onRestored={() => selectTab("dashboard")} />
        )}
      </div>
    </section>
  );
}

/** The dashboard couldn't be read at all: why, and Try again (with the keyboard, when it is free). */
function PageFailure({ error, onRetry }: { error: DashboardRequestError; onRetry(): void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (keyboardIsFree()) button.current?.focus(); }, []);
  return (
    <section className={s.page}>
      <p className={s.pageProblem} role="alert">{failure(error, "try again")}</p>
      <button ref={button} type="button" className={s.retryPage} onClick={onRetry}>Try again</button>
    </section>
  );
}

/**
 * `PAGES.dashboard`: reads the dashboard, then shows it; a dashboard that is gone says so. Once it
 * is shown, a failed re-read never replaces the page (or its edit session): it is said in place.
 */
export default function DashboardPage(props: MonitoringPageProps) {
  const id = props.view.page === "dashboard" ? props.view.id : "";
  const dash = useDashboard(id);
  const { refetch } = dash;
  const retry = useCallback(() => { void refetch(); }, [refetch]);
  if (props.view.page !== "dashboard") return null;
  const view = props.view;
  if (dash.isPending) {
    return <section className={s.page} aria-busy="true"><p className={s.pageNote}>Loading the dashboard…</p></section>;
  }
  if (dash.data === undefined) {
    if (dash.error?.code === "not_found") return <Gone what="dashboard" onHome={() => props.nav.navigate(MONITORING_HOME, "push")} />;
    return <PageFailure error={dash.error as DashboardRequestError} onRetry={retry} />;
  }
  const reread = dash.isError ? { error: dash.error, retrying: dash.isFetching, retry } : null;
  return <DashboardScreen key={view.id} {...props} view={view} dashboard={dash.data} reread={reread} />;
}
