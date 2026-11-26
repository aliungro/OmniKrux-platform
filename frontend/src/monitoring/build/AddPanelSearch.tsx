// "+ Add panel" as "type what you want to see" (D3). One field over the owner's catalog: with no
// text it lists the suggestions, with text the finder's matches (150 ms after the last key). Every
// card previews live; the suggestions and their previews are the page's, shared with the
// suggestions column. The keyboard stays in the field (↑ ↓ pick, Enter adds, Ctrl+End goes to
// Empty panel, Esc clears and then closes). Empty panel, always last, is M2's blank time series.
// Matching is fixed rules over names, help text and labels: no AI, no paid service.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { failure } from "../../api/http";
import { DialogShell } from "../../features/dock/ConfirmDialog";
import { catalogAge } from "../catalog/merge";
import type { ResolvedVars } from "../dashboards/interpolate";
import type { NewPanel } from "../dashboards/layout";
import type { DashboardOwner } from "../dashboards/runPanel";
import { nextPanelId, type DashboardSpec, type OwnerKind } from "../dashboards/schema";
import { candidatePanel, heldKeys, type Candidate } from "./candidates";
import { buildFinderIndex, findPanels } from "./finder";
import HelpTip from "./HelpTip";
import PreviewCard from "./PreviewCard";
import { usePreviews } from "./usePreviews";
import type { Suggestions } from "./useSuggestions";
import s from "./AddPanelSearch.module.css";

export const SEARCH_DEBOUNCE_MS = 150;

export interface AddPanelSearchProps {
  /** The page's one suggestion source (`useSuggestions`): its catalog, suggestions and their previews. */
  suggestions: Suggestions;
  /** `null` while the dashboard's owner is still being read. Typed text previews with it. */
  owner: DashboardOwner | null;
  ownerName: string;
  ownerKind: OwnerKind;
  vars: ResolvedVars;
  range: { start: number; end: number };
  draft: DashboardSpec;
  /** A result picked: the panel it becomes (next id in the draft) and where its card was. */
  onAdd(panel: NewPanel, from: DOMRect): void;
  onEmpty(): void;
  onClose(): void;
  /**
   * Why the last pick wasn't added (the JSON text doesn't apply); the search stays open. `attempt`
   * counts the refusals, so each one is said again (the page behind a modal dialog isn't heard).
   */
  refused?: { text: string; attempt: number } | null;
  /** Where Esc returns the keyboard (the Add tile, or the tile that had it); else what had it on open. */
  restoreFocusTo?: RefObject<HTMLElement | null>;
}

export function AddPanelSearch({ suggestions, owner, ownerName, ownerKind, vars, range, draft, onAdd, onEmpty, onClose, refused = null, restoreFocusTo }: AddPanelSearchProps) {
  const base = useId();
  const ids = { heading: `${base}-h`, list: `${base}-l`, hint: `${base}-k`, option: (i: number) => `${base}-o${i}` };
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");

  // The finder runs a moment after the last key; clearing the text shows the suggestions at once.
  useEffect(() => {
    if (text.trim() === "") { setQuery(""); return; }
    const timer = setTimeout(() => setQuery(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const cat = suggestions.catalog;
  const catalog = cat.catalog;
  const index = useMemo(() => (catalog ? buildFinderIndex(catalog) : null), [catalog]);
  const suggested = suggestions.candidates;
  const listFor = useCallback((words: string): Candidate[] => {
    if (!catalog || !index) return [];
    return words.trim() === "" ? suggested : findPanels(index, words);
  }, [catalog, index, suggested]);
  const candidates = useMemo(() => listFor(query), [listFor, query]);
  const searching = query.trim() !== "";
  // Typed text previews its own matches; with no text the suggestions' previews are the page's.
  const found = usePreviews(searching ? candidates : [], { owner, ownerName, vars, range });
  const previews = searching ? found : suggestions.previews;
  // What the dashboard already holds says Added here, as in the suggestions column.
  const added = useMemo(() => heldKeys(candidates, draft.panels), [candidates, draft.panels]);

  // The active option: the first, until the arrows move it; a new list starts at its first again.
  const listKey = JSON.stringify([query, candidates.map((c) => c.key)]);
  const [picked, setPicked] = useState({ key: listKey, at: 0 });
  const count = candidates.length + 1; // the results, then Empty panel
  const empty = candidates.length;
  const active = picked.key === listKey ? Math.min(picked.at, count - 1) : 0;
  const moveTo = (at: number) => setPicked({ key: listKey, at: (at + count) % count });
  const results = useRef<HTMLDivElement>(null);
  /** Cards in one grid row, measured: the options that share the first one's top. */
  const columns = () => {
    const opts = Array.from(results.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    if (opts.length === 0) return 1;
    const top = opts[0].getBoundingClientRect().top;
    const n = opts.findIndex((o) => Math.abs(o.getBoundingClientRect().top - top) > 1);
    return n === -1 ? 1 : n; // all in one row: up and down step by card
  };
  const moveRow = (down: boolean) => {
    const cols = columns();
    const last = count - 1;
    if (down) {
      if (active + cols <= last) moveTo(active + cols);
      else if (Math.floor(active / cols) < Math.floor(last / cols)) moveTo(last); // a short last row
      else moveTo(active % cols); // down from the last row wraps to the top of the column
    } else if (active - cols >= 0) moveTo(active - cols);
    else {
      let at = Math.floor(last / cols) * cols + (active % cols); // up from the first row wraps to the bottom of the column
      if (at > last) at -= cols;
      moveTo(at);
    }
  };

  useEffect(() => {
    document.getElementById(`${base}-o${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, base]);

  const rectOf = (i: number) => document.getElementById(ids.option(i))?.getBoundingClientRect() ?? new DOMRect();
  const add = (c: Candidate, from: DOMRect) => onAdd(candidatePanel(c, nextPanelId(draft), ownerKind), from);
  const pick = (i: number, from?: DOMRect) => {
    if (i >= candidates.length) onEmpty();
    else add(candidates[i], from ?? rectOf(i));
  };

  const atEdge = (e: KeyboardEvent<HTMLInputElement>) => {
    const t = e.currentTarget;
    if (t.value === "") return true;
    if (t.selectionStart !== t.selectionEnd) return false;
    return e.key === "ArrowLeft" ? t.selectionStart === 0 : t.selectionStart === t.value.length;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveRow(e.key === "ArrowDown");
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && atEdge(e)) {
      // Left and right move by card; inside typed text they move the caret, until it reaches that end.
      e.preventDefault();
      moveTo(active + (e.key === "ArrowRight" ? 1 : -1));
    } else if (e.key === "End" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      moveTo(empty);
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (e.repeat) return;
      // Only spaces: that is no text (the suggestions), as the list shows.
      const typed = text.trim() === "" ? "" : text;
      if (typed !== query && catalog) {
        // Typed faster than the list followed: Enter adds the first match of what is typed now.
        const now = listFor(typed);
        setQuery(typed);
        if (now.length > 0) add(now[0], rectOf(0));
        else onEmpty();
        return;
      }
      pick(active);
    } else if (e.key === "Escape" && text !== "") {
      // Esc clears first; the dialog closes on the next one.
      e.preventDefault();
      e.stopPropagation();
      setText("");
      setQuery("");
    }
  };

  // Refresh list, and Try again after a failure: the server builds the catalog again.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    cat.refresh().then(
      () => { if (alive.current) setRefreshing(false); },
      (err: unknown) => { if (alive.current) { setRefreshing(false); setRefreshError(failure(err, "try again")); } },
    );
  };

  const reading = !catalog && !cat.error;
  const readFailed = !catalog && !reading ? (refreshError ?? cat.error) : null;
  // Try again worked: its button went with the failure, and the keyboard goes back to the field.
  const failedShown = readFailed !== null;
  const hadFailed = useRef(failedShown);
  useLayoutEffect(() => {
    const lost = () => { const a = document.activeElement; return a === null || a === document.body || !a.isConnected; };
    if (hadFailed.current && !failedShown && lost()) input.current?.focus();
    hadFailed.current = failedShown;
  }, [failedShown]);
  const nothing = searching && catalog !== null && candidates.length === 0;
  const matches = searching && candidates.length > 0
    ? `${candidates.length} ${candidates.length === 1 ? "panel matches" : "panels match"}.`
    : "";
  const age = catalog ? catalogAge(catalog.builtAt, Date.now()) : "";
  const statusText = reading ? `Reading what ${ownerName}'s sources have…`
    : readFailed ? `Couldn't read the metrics: ${readFailed}`
      : nothing ? "Nothing matches yet. Try another word." : matches;

  return (
    <DialogShell provider="monitoring" role="dialog" busy={false} onCancel={onClose} first={input}
      restoreFocusTo={restoreFocusTo} labelledBy={ids.heading} className={s.dialog}>
      <h2 id={ids.heading} className={s.hidden}>Add panel</h2>
      <div className={s.bar}>
        <span className={s.plus} aria-hidden="true">＋</span>
        <input ref={input} className={s.input} type="text" autoComplete="off" spellCheck={false}
          role="combobox" aria-label="What do you want to see" aria-expanded="true" aria-autocomplete="list"
          aria-controls={ids.list} aria-activedescendant={ids.option(active)} aria-describedby={ids.hint}
          aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Enter Control+End Escape"
          placeholder="Type what you want to see, like errors by route"
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
        <span id={ids.hint} className={s.hint}>{active === 0 ? "Enter adds the first" : "Enter adds the highlighted one"}</span>
      </div>
      {refused && <p key={refused.attempt} className={s.refused} role="alert">{refused.text}</p>}

      <div className={s.body}>
        {/* One status region, always there, says the reading, the failure and the matches. */}
        <div className={readFailed ? s.failed : undefined}>
          <p role="status" className={reading || readFailed ? s.line : nothing ? s.none : s.hidden}>{statusText}</p>
          {readFailed && (
            <button type="button" className={s.action} aria-disabled={refreshing || undefined} onClick={refresh}>
              {refreshing ? "Trying again…" : "Try again"}
            </button>
          )}
        </div>
        {catalog && (!searching || catalog.notes.length > 0) && (
          <div className={s.headingRow}>
            {!searching && <h3 className={s.heading}>{suggestions.heading}</h3>}
            {catalog.notes.length > 0 && (
              <HelpTip label="About this list">
                {catalog.notes.map((n) => <span key={n} className={s.tipLine}>{n}</span>)}
              </HelpTip>
            )}
          </div>
        )}
        {catalog && catalog.problems.map((n) => <p key={n} className={s.muted}>{n}</p>)}

        <div ref={results} role="listbox" id={ids.list} aria-label="Results" className={s.results}>
          {candidates.map((c, i) => (
            <PreviewCard key={c.key} option id={ids.option(i)} candidate={c} preview={previews[c.key]}
              active={i === active} added={added.has(c.key)} onPick={(rect) => pick(i, rect)} />
          ))}
          <div role="option" id={ids.option(empty)} aria-selected={active === empty}
            aria-labelledby={`${ids.option(empty)}-t`} aria-describedby={`${ids.option(empty)}-d`}
            className={s.empty} data-active={active === empty ? "true" : undefined}
            onMouseDown={(e) => e.preventDefault()} onClick={() => pick(empty)}>
            <span className={s.emptyHead}>
              <span className={s.emptyMark} aria-hidden="true">＋</span>
              <span className={s.emptyTitle} id={`${ids.option(empty)}-t`}>Empty panel</span>
              {active === empty && <span className={s.emptyKey}>Enter to add</span>}
            </span>
            <span className={s.emptyLine} id={`${ids.option(empty)}-d`}>Write the query yourself.</span>
          </div>
        </div>
      </div>

      {catalog && (
        <div className={s.footer}>
          {age && <span className={s.age}>Known metrics from {age}</span>}
          <button type="button" className={s.refresh} aria-disabled={refreshing || undefined} onClick={refresh}>
            {refreshing ? "Refreshing…" : "Refresh list"}
          </button>
          {refreshError && <span className={s.refreshError}>Couldn't refresh the list: {refreshError}</span>}
        </div>
      )}
    </DialogShell>
  );
}
