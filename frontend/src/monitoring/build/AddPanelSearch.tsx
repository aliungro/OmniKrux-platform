// "+ Add panel" as "type what you want to see" (D3). One field over the owner's catalog: with no
// text it lists the suggestions, with text the finder's matches (150 ms after the last key). The
// first few cards preview live; the keyboard stays in the field (↑ ↓ pick, Enter adds, Ctrl+End
// goes to Empty panel, Esc clears and then closes). Empty panel, always last, is M2's blank time
// series. Matching is fixed rules over names, help text and labels: no AI, no paid service.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { failure } from "../../api/http";
import { DialogShell } from "../../features/dock/ConfirmDialog";
import { catalogAge, useOwnerCatalog } from "../catalog/merge";
import type { ResolvedVars } from "../dashboards/interpolate";
import type { NewPanel } from "../dashboards/layout";
import type { DashboardOwner } from "../dashboards/runPanel";
import { nextPanelId, type DashboardSpec, type OwnerKind } from "../dashboards/schema";
import { candidatePanel, type Candidate } from "./candidates";
import { buildFinderIndex, findPanels } from "./finder";
import PreviewCard from "./PreviewCard";
import { suggestionsHeading, suggestPanels } from "./suggest";
import { usePreviews } from "./usePreviews";
import s from "./AddPanelSearch.module.css";

export const SEARCH_DEBOUNCE_MS = 150;

export interface AddPanelSearchProps {
  /** `null` while the dashboard's owner is still being read. */
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
  /** Why the last pick wasn't added (the JSON text doesn't apply); the search stays open. */
  refused?: string | null;
  /** Where Esc returns the keyboard (the Add tile, or the tile that had it); else what had it on open. */
  restoreFocusTo?: RefObject<HTMLElement | null>;
}

export function AddPanelSearch({ owner, ownerName, ownerKind, vars, range, draft, onAdd, onEmpty, onClose, refused = null, restoreFocusTo }: AddPanelSearchProps) {
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

  const cat = useOwnerCatalog(owner);
  const catalog = cat.catalog;
  const index = useMemo(() => (catalog ? buildFinderIndex(catalog) : null), [catalog]);
  const listFor = useCallback((words: string): Candidate[] => {
    if (!catalog || !index) return [];
    return words.trim() === "" ? suggestPanels(catalog) : findPanels(index, words);
  }, [catalog, index]);
  const candidates = useMemo(() => listFor(query), [listFor, query]);
  const searching = query.trim() !== "";
  const previews = usePreviews(candidates, { owner, ownerName, vars, range });

  // The active option: the first, until the arrows move it; a new list starts at its first again.
  const listKey = JSON.stringify([query, candidates.map((c) => c.key)]);
  const [picked, setPicked] = useState({ key: listKey, at: 0 });
  const count = candidates.length + 1; // the results, then Empty panel
  const empty = candidates.length;
  const active = picked.key === listKey ? Math.min(picked.at, count - 1) : 0;
  const moveTo = (at: number) => setPicked({ key: listKey, at: (at + count) % count });

  useEffect(() => {
    document.getElementById(`${base}-o${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, base]);

  const rectOf = (i: number) => document.getElementById(ids.option(i))?.getBoundingClientRect() ?? new DOMRect();
  const add = (c: Candidate, from: DOMRect) => onAdd(candidatePanel(c, nextPanelId(draft), ownerKind), from);
  const pick = (i: number, from?: DOMRect) => {
    if (i >= candidates.length) onEmpty();
    else add(candidates[i], from ?? rectOf(i));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveTo(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "End" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      moveTo(empty);
    } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (e.repeat) return;
      if (text !== query && catalog) {
        // Typed faster than the list followed: Enter adds the first match of what is typed now.
        const now = listFor(text);
        setQuery(text);
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

  const reading = !catalog && !cat.error && (owner === null || cat.loading);
  const readFailed = !catalog && !reading ? (refreshError ?? cat.error) : null;
  const nothing = searching && catalog !== null && candidates.length === 0;
  const found = searching && candidates.length > 0
    ? `${candidates.length} ${candidates.length === 1 ? "panel matches" : "panels match"}.`
    : "";
  const age = catalog ? catalogAge(catalog.builtAt, Date.now()) : "";

  return (
    <DialogShell provider="monitoring" role="dialog" busy={false} onCancel={onClose} first={input}
      restoreFocusTo={restoreFocusTo} labelledBy={ids.heading} className={s.dialog}>
      <h2 id={ids.heading} className={s.hidden}>Add panel</h2>
      <div className={s.bar}>
        <span className={s.plus} aria-hidden="true">＋</span>
        <input ref={input} className={s.input} type="text" autoComplete="off" spellCheck={false}
          role="combobox" aria-label="What do you want to see" aria-expanded="true" aria-autocomplete="list"
          aria-controls={ids.list} aria-activedescendant={ids.option(active)} aria-describedby={ids.hint}
          aria-keyshortcuts="ArrowUp ArrowDown Enter Control+End Escape"
          placeholder="Type what you want to see, like errors by route"
          value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
        <span id={ids.hint} className={s.hint}>{active === 0 ? "Enter adds the first" : "Enter adds the highlighted one"}</span>
      </div>
      {refused && <p className={s.refused}>{refused}</p>}

      <div className={s.body}>
        {reading && <p className={s.line}>Reading what {ownerName}'s sources have…</p>}
        {readFailed && (
          <div className={s.failed}>
            <p className={s.line}>Couldn't read the metrics: {readFailed}</p>
            <button type="button" className={s.action} aria-disabled={refreshing || undefined} onClick={refresh}>
              {refreshing ? "Trying again…" : "Try again"}
            </button>
          </div>
        )}
        {catalog && !searching && <h3 className={s.heading}>{suggestionsHeading(ownerName, catalog)}</h3>}
        {catalog && [...catalog.problems, ...catalog.notes].map((n) => <p key={n} className={s.muted}>{n}</p>)}
        <p role="status" className={nothing ? s.none : s.hidden}>{nothing ? "Nothing matches yet. Try another word." : found}</p>

        <div role="listbox" id={ids.list} aria-label="Results" className={s.results}>
          {candidates.map((c, i) => (
            <PreviewCard key={c.key} option id={ids.option(i)} candidate={c} preview={previews[c.key]}
              active={i === active} onPick={(rect) => pick(i, rect)} />
          ))}
          <div role="option" id={ids.option(empty)} aria-selected={active === empty}
            aria-labelledby={`${ids.option(empty)}-t`} aria-describedby={`${ids.option(empty)}-d`}
            className={s.empty} data-active={active === empty ? "true" : undefined}
            onMouseDown={(e) => e.preventDefault()} onClick={() => pick(empty)}>
            <span className={s.emptyMark} aria-hidden="true">+</span>
            <span className={s.emptyTitle} id={`${ids.option(empty)}-t`}>Empty panel</span>
            <span className={s.emptyLine} id={`${ids.option(empty)}-d`}>Write the query yourself.</span>
            {active === empty && <span className={s.emptyKey}>Enter to add</span>}
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
