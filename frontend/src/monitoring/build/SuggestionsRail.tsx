// Suggestions on a new dashboard (D2): a rail beside the grid with up to eight ready-made panels,
// each with a live preview. Picking one adds it and it flies from its card to its tile; the card
// then reads Added. The keyboard stays in the rail on the next suggestion, so a dashboard can be
// built with Enter alone. The Added marks are this component's own state: the page keys it by the
// edit session, so Discard and a new Edit start clean (F34).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { failure } from "../../api/http";
import { isEditable, pressed } from "../../features/chrome/shortcuts";
import { useOwnerCatalog } from "../catalog/merge";
import { JSON_FIRST } from "../dashboards/editor/editorState";
import type { ResolvedVars } from "../dashboards/interpolate";
import type { NewPanel } from "../dashboards/layout";
import { pageLetter } from "../dashboards/page/keys";
import type { DashboardOwner } from "../dashboards/runPanel";
import { nextPanelId, type DashboardSpec, type OwnerKind } from "../dashboards/schema";
import { candidatePanel } from "./candidates";
import PreviewCard from "./PreviewCard";
import { MAX_SUGGESTIONS, suggestionsHeading, suggestPanels } from "./suggest";
import { usePreviews } from "./usePreviews";
import s from "./SuggestionsRail.module.css";

export interface SuggestionsRailProps {
  /** `null` while the dashboard's owner is still being read. */
  owner: DashboardOwner | null;
  ownerName: string;
  ownerKind: OwnerKind;
  vars: ResolvedVars;
  range: { start: number; end: number };
  draft: DashboardSpec;
  /** A card picked: the panel it becomes, where its card was and its key. False: refused (nothing was added). */
  onAdd(panel: NewPanel, from: DOMRect, key: string): boolean;
  onClose(): void;
  /** Esc on a suggestion: the keyboard goes back to "+ Add panel". */
  onEscape?(): void;
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

export function SuggestionsRail({ owner, ownerName, ownerKind, vars, range, draft, onAdd, onClose, onEscape }: SuggestionsRailProps) {
  const list = useRef<HTMLUListElement>(null);
  const hide = useRef<HTMLButtonElement>(null);
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
  // Each message is a new node, so the same words said twice are read again.
  const [message, setMessage] = useState<{ text: string; seq: number; refused: boolean }>({ text: "", seq: 0, refused: false });
  const say = (text: string, refused = false) => setMessage((m) => ({ text, seq: m.seq + 1, refused }));

  const cat = useOwnerCatalog(owner);
  const catalog = cat.catalog;
  const candidates = useMemo(() => (catalog ? suggestPanels(catalog).slice(0, MAX_SUGGESTIONS) : []), [catalog]);
  const previews = usePreviews(candidates, { owner, ownerName, vars, range }, MAX_SUGGESTIONS);

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
    setAdded(used);
    say(`Added "${panel.title.trim() || "Untitled panel"}" to the dashboard.`);
    const next = firstUnused(i + 1, used);
    (next === -1 ? hide.current : cards()[next])?.focus();
  };

  // `s` goes to the first suggestion not yet added (never from a field or a dialog).
  const latest = useRef({ candidates, added });
  latest.current = { candidates, added };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!pageLetter(e) || !pressed("suggestionsFocus", e) || isEditable(e.target)) return;
      const { candidates: shown, added: used } = latest.current;
      const at = shown.findIndex((c) => !used.has(c.key));
      const el = at === -1 ? hide.current : cards()[at];
      if (!el) return;
      e.preventDefault();
      el.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
  const reading = !catalog && !cat.error && (owner === null || cat.loading);
  const readFailed = !catalog && !reading ? (refreshError ?? cat.error) : null;

  return (
    <aside className={s.rail} aria-label="Suggestions" onKeyDown={onKeyDown}>
      <div className={s.head}>
        <h2 className={s.heading}>{catalog ? suggestionsHeading(ownerName, catalog) : "Suggestions"}</h2>
        <button ref={hide} type="button" className={s.hide} onClick={onClose}>Hide suggestions</button>
      </div>
      <p role="status" aria-live="polite" className={message.refused ? s.refused : s.hidden}>
        <span key={message.seq}>{message.text}</span>
      </p>
      {reading && <p className={s.line}>Loading suggestions…</p>}
      {readFailed && (
        <div className={s.failed}>
          <p className={s.line}>Couldn't read the metrics: {readFailed}</p>
          <button type="button" className={s.action} aria-disabled={refreshing || undefined} onClick={retry}>
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
