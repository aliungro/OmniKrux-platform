// Suggestions on a new dashboard (D2): a rail beside the grid with up to eight ready-made panels,
// each with a live preview. Picking one adds it and it flies from its card to its tile; the card
// then reads Added. The keyboard stays in the rail on the next suggestion, so a dashboard can be
// built with Enter alone. A card reads Added when the draft already holds that panel (same type,
// same query), so the mark survives a tab switch, clears when the panel is removed and Discard
// clears it with the draft. Its suggestions and previews are the page's (`useSuggestions`), the
// same ones Add panel lists, so a suggestion draws the same chart in both.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { failure } from "../../api/http";
import { JSON_FIRST } from "../dashboards/editor/editorState";
import type { NewPanel } from "../dashboards/layout";
import { nextPanelId, type DashboardSpec, type OwnerKind } from "../dashboards/schema";
import { candidatePanel } from "./candidates";
import PreviewCard from "./PreviewCard";
import type { Suggestions } from "./useSuggestions";
import s from "./SuggestionsRail.module.css";

/** Go to the first suggestion not yet added, unless the keyboard moved on from `from` meanwhile. */
export type RailFocusRequest = { seq: number; from: Element | null };

export interface SuggestionsRailProps {
  /** The page's one suggestion source (`useSuggestions`), shared with Add panel. */
  suggestions: Suggestions;
  ownerName: string;
  ownerKind: OwnerKind;
  draft: DashboardSpec;
  /** A card picked: the panel it becomes, where its card was and its key. False: refused (nothing was added). */
  onAdd(panel: NewPanel, from: DOMRect, key: string): boolean;
  onClose(): void;
  /** Esc on a suggestion: the keyboard goes back to "+ Add panel". */
  onEscape?(): void;
  /** The Suggestions button or `s`: the keyboard goes to the first unused card once there are cards. */
  focusRequest?: RailFocusRequest | null;
  /** The request was settled (the keyboard went there, or had moved on). */
  onFocused?(): void;
}

/** The rail beside the grid. The grid's own element stays where it is whether or not the rail shows. */
export function RailLayout({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  return (
    <div className={s.layout}>
      {rail}
      <div className={s.slot}>{children}</div>
    </div>
  );
}

export function SuggestionsRail({ suggestions, ownerName, ownerKind, draft, onAdd, onClose, onEscape, focusRequest = null, onFocused }: SuggestionsRailProps) {
  const list = useRef<HTMLUListElement>(null);
  const hide = useRef<HTMLButtonElement>(null);
  const tryAgain = useRef<HTMLButtonElement>(null);
  // Each message is a new node, so the same words said twice are read again.
  const [message, setMessage] = useState<{ text: string; seq: number; refused: boolean }>({ text: "", seq: 0, refused: false });
  const say = (text: string, refused = false) => setMessage((m) => ({ text, seq: m.seq + 1, refused }));

  const { catalog: cat, candidates, previews, heading } = suggestions;
  const catalog = cat.catalog;

  /** The candidates the draft already holds, by key. */
  const added = useMemo(() => {
    const held = new Set<string>();
    for (const c of candidates) {
      if (draft.panels.some((p) => p.type === c.panelType && p.queries.some((q) => q.expr === c.expr))) held.add(c.key);
    }
    return held;
  }, [candidates, draft.panels]);

  const cards = () => Array.from(list.current?.querySelectorAll<HTMLElement>("button") ?? []);
  const firstUnused = (from: number, used: ReadonlySet<string>) => {
    const at = candidates.findIndex((c, i) => i >= from && !used.has(c.key));
    return at !== -1 ? at : candidates.findIndex((c) => !used.has(c.key));
  };

  const pick = (i: number, rect: DOMRect) => {
    const c = candidates[i];
    if (!c || added.has(c.key)) return;
    const panel = candidatePanel(c, nextPanelId(draft), ownerKind);
    if (!onAdd(panel, rect, c.key)) {
      say(JSON_FIRST, true);
      return;
    }
    const used = new Set(added).add(c.key);
    say(`Added "${panel.title.trim() || "Untitled panel"}" to the dashboard.`);
    const next = firstUnused(i + 1, used);
    (next === -1 ? hide.current : cards()[next])?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || !onEscape) return;
    e.preventDefault();
    e.stopPropagation();
    onEscape();
  };

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const retry = () => {
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

  // The Suggestions button or `s` asked for the cards: the first unused one (Hide suggestions when
  // every card is added) as soon as there are cards; Try again or Hide suggestions when the read
  // settles with none. Left alone if the keyboard moved on while the suggestions were read.
  const asked = useRef(0);
  useLayoutEffect(() => {
    if (!focusRequest || asked.current === focusRequest.seq) return;
    const a = document.activeElement;
    const moved = a !== focusRequest.from && a !== null && a !== document.body && a.isConnected;
    const at = candidates.findIndex((c) => !added.has(c.key));
    const target = moved ? null
      : candidates.length > 0 ? (at === -1 ? hide.current : cards()[at])
        : reading ? undefined
          : tryAgain.current ?? hide.current;
    if (target === undefined) return;
    asked.current = focusRequest.seq;
    target?.focus();
    onFocused?.();
  });

  return (
    <aside className={s.rail} aria-label="Suggestions" data-suggestions-rail="" onKeyDown={onKeyDown}>
      <div className={s.head}>
        <h2 className={s.heading}>{catalog ? heading : "Suggestions"}</h2>
        <button ref={hide} type="button" className={s.hide} onClick={onClose}>Hide suggestions</button>
      </div>
      <p role="status" aria-live="polite" className={message.refused ? s.refused : s.hidden}>
        <span key={message.seq}>{message.text}</span>
      </p>
      {reading && <p className={s.line}>Loading suggestions…</p>}
      {readFailed && (
        <div className={s.failed}>
          <p className={s.line}>Couldn't read the metrics: {readFailed}</p>
          <button ref={tryAgain} type="button" className={s.action} aria-disabled={refreshing || undefined} onClick={retry}>
            {refreshing ? "Trying again…" : "Try again"}
          </button>
        </div>
      )}
      {catalog && candidates.length === 0 && (
        <p className={s.line}>No ready suggestions for what {ownerName}'s sources have. Use + Add panel to search, or write a query.</p>
      )}
      {candidates.length > 0 && (
        <ul ref={list} role="list" className={s.list} aria-label="Suggested panels">
          {candidates.map((c, i) => (
            <li key={c.key} className={s.item}>
              <PreviewCard candidate={c} preview={previews[c.key]} active={false} added={added.has(c.key)}
                onPick={(rect) => pick(i, rect)} />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
