import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Cluster, KindInfo, ResourceRow } from "../../api/types";
import { rowActions, type RowAction } from "../actions/tools";
import { useStartAction } from "../actions/useActions";
import { capsOf, pageKey, pressed } from "../chrome/shortcuts";
import { rowTitle } from "../territories/model";
import { ProviderBadge } from "../territories/ProviderBadge";
import { GROUP_ORDER, KIND_GROUPS, MAX_RESULTS, buildCommands, rankCommands, type Command, type CommandGroup } from "./commands";
import k from "../chrome/key.module.css";
import s from "./CommandPalette.module.css";

export type PaletteMode = "all" | "kinds";

/**
 * `Ctrl K` opens the palette on everything, `:` on kinds only. Neither is a shortcut while you type
 * in a field, the YAML editor or a terminal (a shell keeps its Ctrl K), nor under another dialog.
 * Ctrl K's browser default (the address bar's search) never fires when it opens the palette.
 */
export function usePaletteKeys(open: (mode: PaletteMode) => void): void {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mode = pressed("palette", e) ? "all" : pressed("kinds", e) ? "kinds" : null;
      if (mode === null || !pageKey(e)) return;
      e.preventDefault();
      openRef.current(mode);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** The selected row the palette offers actions on, with the cluster it's on. */
export interface PaletteSelection {
  row: ResourceRow;
  kind: KindInfo;
  cluster: Cluster;
}

/** A leading ":" narrows any palette to kinds, as k9s's prompt does. */
function splitQuery(query: string): { kindsOnly: boolean; q: string } {
  const m = /^\s*:/.exec(query);
  return m ? { kindsOnly: true, q: query.slice(m[0].length) } : { kindsOnly: false, q: query };
}

const NO_KINDS: readonly KindInfo[] = [];

/**
 * Why the list is empty, in plain words: the kinds are still loading, they couldn't be loaded (and
 * why), or nothing matches. A short-name hint only once kinds could have matched.
 */
function Empty({ kindsOnly, query, loading, error }: { kindsOnly: boolean; query: string; loading: boolean; error: string | null }) {
  if (kindsOnly) {
    if (error !== null) return <p className={s.empty} role="alert">{`Can't load the list of kinds: ${error}`}</p>;
    if (loading) return <p className={s.empty} role="status">Loading the list of kinds…</p>;
    return (
      <p className={s.empty} role="status">
        {query === "" ? "None of your clusters serves a kind Omnikrux can list." : `No kind your clusters serve matches “${query}”.`}
      </p>
    );
  }
  if (error !== null) {
    return <p className={s.empty} role="alert">{`Nothing matches “${query}”. Kinds aren't listed: can't load the list of kinds: ${error}`}</p>;
  }
  if (loading) return <p className={s.empty} role="status">{`Nothing matches “${query}” yet: the list of kinds is still loading.`}</p>;
  return <p className={s.empty} role="status">{`Nothing matches “${query}”. Try a kind's short name, like deploy or svc.`}</p>;
}

/** The ranked commands in groups, each group where its best match ranks, best first inside it. */
function inGroups(ranked: Command[]): [CommandGroup, Command[]][] {
  const groups = new Map<CommandGroup, Command[]>();
  for (const c of ranked) {
    const list = groups.get(c.group);
    if (list) list.push(c);
    else groups.set(c.group, [c]);
  }
  return [...groups];
}

/**
 * The command palette: a centred box with one field. It lists every served kind (Flux and other
 * custom resources in their own groups), the views, and the selected row's actions. It never
 * changes anything itself: an action opens the same form or review its key opens. ↑ and ↓ choose,
 * Enter runs, Esc closes and gives focus back.
 */
export function CommandPalette({
  mode,
  kinds,
  kindsError = null,
  selection,
  onKind,
  onRowAction,
  onAudit,
  onForwards,
  onClose,
  onFocusLost,
}: {
  mode: PaletteMode;
  /** Every served kind; undefined until GET /api/kinds has answered. */
  kinds: readonly KindInfo[] | undefined;
  /** Why the kinds couldn't be loaded, in plain words; null while they load or once they have. */
  kindsError?: string | null;
  selection: PaletteSelection | null;
  onKind: (key: string) => void;
  onRowAction: (action: RowAction) => void;
  onAudit: () => void;
  onForwards?: () => void;
  onClose: () => void;
  /**
   * On close, when the element that had focus has gone (a kind jump replaced the rows) or nothing
   * had it: put focus somewhere sensible instead of leaving it on the page's body.
   */
  onFocusLost?: () => void;
}) {
  const base = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const canChange = useStartAction() !== null;

  const commands = useMemo(() => {
    const selected = selection && {
      row: selection.row,
      kind: selection.kind,
      clusterName: selection.cluster.name,
      actions: rowActions(selection.kind.key, selection.kind.verbs, selection.row, {
        change: canChange,
        logs: true,
        shell: true,
        workloadLogs: true,
      }),
    };
    return buildCommands({ kinds: kinds ?? NO_KINDS, onKind, selected, onRowAction, onAudit, onForwards });
  }, [kinds, selection, canChange, onKind, onRowAction, onAudit, onForwards]);

  const split = splitQuery(query);
  const kindsOnly = mode === "kinds" || split.kindsOnly;
  const pool = useMemo(() => (kindsOnly ? commands.filter((c) => KIND_GROUPS.has(c.group)) : commands), [kindsOnly, commands]);
  const ranked = useMemo(() => rankCommands(split.q, pool), [split.q, pool]);
  const sections = useMemo(() => {
    const groups = inGroups(ranked);
    // Nothing typed: the groups in their usual order (actions first); typed: where each best matches.
    return split.q.trim() === "" ? groups.sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0])) : groups;
  }, [ranked, split.q]);
  const ordered = useMemo(() => sections.flatMap(([, cmds]) => cmds), [sections]);
  const at = ordered.length === 0 ? -1 : Math.min(active, ordered.length - 1);
  const optionId = (i: number) => `${base}-o${i}`;

  // Focus the field on open; give focus back to where it was on close, or, when that has gone,
  // wherever the page says (the kind you jumped to).
  const focusLost = useRef(onFocusLost);
  focusLost.current = onFocusLost;
  useEffect(() => {
    const back = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (back instanceof HTMLElement && back !== document.body && back.isConnected) back.focus();
      else focusLost.current?.();
    };
  }, []);

  // Keep the chosen option in view as the arrows move it.
  useEffect(() => {
    if (at >= 0) document.getElementById(optionId(at))?.scrollIntoView?.({ block: "nearest" });
  });

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed here never reach the table or the page's shortcuts.
    e.stopPropagation();
    if (e.key === "Escape" || pressed("palette", e)) {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (ordered.length > 0) setActive((at + (e.key === "ArrowDown" ? 1 : ordered.length - 1)) % ordered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(ordered[at]);
    } else if (e.key === "Tab") {
      e.preventDefault(); // one field: focus stays in it
    }
  };

  const title = mode === "kinds" ? "Jump to a kind" : "Commands";
  const total = pool.length;
  const capped = split.q.trim() === "" && total > MAX_RESULTS;
  let index = 0;

  return (
    <div className={s.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* A click anywhere but the field keeps focus in the field, so the keys (Esc) keep working. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={s.box}
        onKeyDown={onKey}
        onMouseDown={(e) => e.target !== inputRef.current && e.preventDefault()}
      >
        <div className={s.field}>
          {/* A typed leading colon is already in the field, so only kind mode shows it here. */}
          <span className={s.prompt} data-kinds={mode === "kinds" || undefined} aria-hidden="true">
            {mode === "kinds" ? ":" : "›"}
          </span>
          <input
            ref={inputRef}
            className={s.input}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${base}-list`}
            aria-autocomplete="list"
            aria-activedescendant={at >= 0 ? optionId(at) : undefined}
            aria-label={mode === "kinds" ? "Kind" : "Command, kind or view"}
            placeholder={mode === "kinds" ? "deploy, svc, cm, a custom resource…" : "A kind, a view, or what to do with the selected row"}
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
          <span className={k.k} aria-hidden="true">Esc</span>
        </div>
        <div id={`${base}-list`} role="listbox" aria-label={title} className={s.list}>
          {sections.map(([group, cmds]) => {
            const head = `${base}-g-${group}`;
            return (
              <div key={group} role="group" aria-labelledby={head} className={s.group}>
                <div id={head} className={s.groupTitle}>
                  {group}
                  {group === "Actions" && selection && (
                    <span className={s.where}>
                      on
                      <ProviderBadge provider={selection.cluster.provider} />
                      <span className={s.path}>
                        {[selection.cluster.name, selection.row.namespace, rowTitle(selection.row)].filter(Boolean).join(" / ")}
                      </span>
                    </span>
                  )}
                </div>
                {cmds.map((c) => {
                  const i = index++;
                  return (
                    <div
                      key={c.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === at}
                      aria-labelledby={`${optionId(i)}-l`}
                      className={s.option}
                      onMouseMove={() => i !== at && setActive(i)}
                      onClick={() => run(c)}
                    >
                      <span id={`${optionId(i)}-l`} className={s.label} data-part="label">{c.label}</span>
                      {c.hint && <span className={s.hint}>{c.hint}</span>}
                      {c.keys && c.keys.length > 0 && (
                        <span className={s.keys} aria-hidden="true">
                          {c.keys.map((key) => <span key={key} className={k.k}>{key}</span>)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {ordered.length === 0 && <Empty kindsOnly={kindsOnly} query={split.q.trim()} loading={kinds === undefined} error={kindsError} />}
        </div>
        <div className={s.foot}>
          <span><span className={k.k}>↑</span><span className={k.k}>↓</span> choose</span>
          <span><span className={k.k}>Enter</span> {kindsOnly ? "jump" : "run"}</span>
          {mode === "all" && !kindsOnly && <span><span className={k.k}>{capsOf("kinds")[0]}</span> kinds only</span>}
          {capped && <span className={s.more}>{`Showing ${MAX_RESULTS} of ${total}. Type to narrow.`}</span>}
        </div>
      </div>
    </div>
  );
}
