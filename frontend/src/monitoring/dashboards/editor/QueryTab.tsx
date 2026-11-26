// The Query tab: where the panel's queries run (a project's own sources, or each group member's),
// each query as code with its legend, and the run line under them. Typing goes into the draft at
// once; the run leaves 300 ms after the typing stops, or at once with Ctrl+Enter (F7).
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { pressed } from "../../../features/chrome/shortcuts";
import { isQueryable } from "../../sources/sourceLabels";
import { usePanelEmptyWords } from "../emptyReason";
import { PANEL_COPY } from "../grid/PanelState";
import { isLokiLogQuery, LOG_QUERY_IN_CHART, logQueryFirst, logQueryInChart, SWITCH_TO_LOGS } from "../logQueries";
import type { DashboardOwner, PanelData } from "../runPanel";
import { MAX_QUERIES, type OwnerKind, type PanelSpec, type QuerySpec, type SourceRef } from "../schema";
import { changeType } from "./ChartTab";
import { JSON_FIRST } from "./editorState";
import type { PanelLive, PanelUpdate } from "./SidePanel";
import s from "./SidePanel.module.css";

export const WAITING_COPY = "Waiting for you to stop typing…";
const RUNNING_COPY = "Running…";
const MIN_ROWS = 3;
const MAX_ROWS = 12;

type Choice = { value: string; label: string; source: SourceRef };

const valueOf = (src: SourceRef) => (src.id === null ? src.type : `id:${src.id}`);
const WORDS = { prometheus: "Prometheus-compatible", loki: "Loki" } as const;

/** Where a query can run: a project's default source of each type it has, then each linked source; a group's members' own. */
export function sourceChoices(owner: DashboardOwner | null, ownerKind: OwnerKind, current: SourceRef): Choice[] {
  const out: Choice[] = [];
  if (ownerKind === "group") {
    out.push({ value: "prometheus", label: "Each project's Prometheus-compatible source", source: { type: "prometheus", id: null } });
    out.push({ value: "loki", label: "Each project's Loki source", source: { type: "loki", id: null } });
  } else {
    const links = owner?.kind === "project" ? owner.project.links : [];
    for (const type of ["prometheus", "loki"] as const) {
      const first = links.find((l) => l.source_type === type);
      if (first) out.push({ value: type, label: `Default: ${first.source_name}`, source: { type, id: null } });
    }
    for (const l of links) if (isQueryable(l.source_type)) out.push({ value: `id:${l.source_id}`, label: l.source_name, source: { type: l.source_type, id: l.source_id } });
  }
  // What the panel uses, even when the project no longer has it: never shown as something else.
  // While the project is still loading its links aren't known, so nothing is called missing yet.
  if (!out.some((c) => c.value === valueOf(current))) {
    const loading = ownerKind === "project" && owner === null;
    const held = current.id !== null && owner?.kind === "project" && owner.project.links.some((l) => l.source_id === current.id);
    const label = held ? "A linked source that can't run queries" : current.id === null
      ? `Default ${WORDS[current.type]} source${loading ? "" : " (none linked)"}`
      : loading ? "The linked source" : "A source that isn't linked any more";
    out.push({ value: valueOf(current), label, source: current });
  }
  return out;
}

const rowsFor = (expr: string) => Math.min(MAX_ROWS, Math.max(MIN_ROWS, expr.split("\n").length));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the last run said, or that the panel is waiting for one. */
function runLine(panel: PanelSpec, data: PanelData | null, live: Omit<PanelLive, "data"> | null): { text: string; tone: "quiet" | "ok" | "warn" | "bad" } {
  if (live?.pending) return { text: WAITING_COPY, tone: "quiet" };
  if (live?.waiting || data === null) return { text: PANEL_COPY.loading, tone: "quiet" };
  if (live?.fetching) return { text: RUNNING_COPY, tone: "quiet" };
  if (data.state === "error" || data.state === "unreachable") return { text: data.problems[0] ?? PANEL_COPY[data.state], tone: "bad" };
  if (data.state === "noQuery") return { text: PANEL_COPY.noQuery, tone: "quiet" };
  const took = `${data.summary.tookMs} ms`;
  const text = panel.type === "logs"
    ? `${plural(data.logs.length, "line", "lines")} · ${took}`
    : `${data.summary.series} series · ${plural(data.summary.points, "point", "points")} · ${took}`;
  return { text, tone: data.state === "partial" ? "warn" : "ok" };
}

export function QueryTab({ panel, update, owner, ownerKind, data, live, jsonPending = false }: {
  panel: PanelSpec; update: PanelUpdate; owner: DashboardOwner | null; ownerKind: OwnerKind;
  data: PanelData | null; live: Omit<PanelLive, "data"> | null;
  /** The JSON tab holds text that does not apply: draft edits are refused until it is fixed or discarded. */
  jsonPending?: boolean;
}) {
  const [refused, setRefused] = useState<{ text: string; attempt: number } | null>(null);
  const sourceId = useId();
  const list = useRef<HTMLDivElement>(null);
  /** After the next render: the query (by ref) whose code takes the keyboard. */
  const focusNext = useRef<string | null>(null);
  useLayoutEffect(() => {
    const ref = focusNext.current;
    if (ref === null) return;
    focusNext.current = null;
    list.current?.querySelector<HTMLTextAreaElement>(`textarea[data-ref="${ref}"]`)?.focus();
  });

  const current = panel.queries[0]?.source ?? { type: panel.type === "logs" ? "loki" : "prometheus", id: null };
  const choices = sourceChoices(owner, ownerKind, current);
  const setSource = (value: string) => {
    const choice = choices.find((c) => c.value === value);
    if (choice) update((p) => ({ ...p, queries: p.queries.map((q) => ({ ...q, source: choice.source })) }));
  };
  const setQuery = (ref: string, patch: Partial<QuerySpec>) =>
    update((p) => ({ ...p, queries: p.queries.map((q) => (q.ref === ref ? { ...q, ...patch } : q)) }));
  const add = () => {
    const used = new Set(panel.queries.map((q) => q.ref));
    const ref = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).find((r) => !used.has(r));
    if (!ref) return;
    focusNext.current = ref;
    update((p) => ({ ...p, queries: [...p.queries, { ref, source: p.queries[0]?.source ?? current, expr: "", legend: "", hidden: false }] }));
  };
  const remove = (ref: string) => {
    const at = panel.queries.findIndex((q) => q.ref === ref);
    const rest = panel.queries.filter((q) => q.ref !== ref);
    focusNext.current = rest[Math.min(at, rest.length - 1)]?.ref ?? null;
    update((p) => ({ ...p, queries: p.queries.filter((q) => q.ref !== ref) }));
  };
  const onCodeKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!pressed("queryRun", e)) return;
    e.preventDefault();
    live?.flush();
  };

  const line = runLine(panel, data, live);
  // Under the run line's count: why the run came back empty, once the check proves it.
  const settled = !live?.pending && !live?.waiting && !live?.fetching;
  const logsInChart = logQueryInChart(panel);
  // The tile's own rule (the window hint first, then a proved reason), so the two never disagree.
  const reason = usePanelEmptyWords(panel, live?.run ?? null, settled && data?.state === "empty", settled, !settled);
  // A draft edit like any other: refused while the JSON does not apply; then the keyboard goes to the log query.
  const switchToLogs = () => {
    if (jsonPending) { setRefused((was) => ({ text: JSON_FIRST, attempt: (was?.attempt ?? 0) + 1 })); return; }
    setRefused(null);
    focusNext.current = logQueryFirst(panel).queries[0].ref;
    update((p) => changeType(logQueryFirst(p), "logs"));
  };
  const canAdd = panel.type !== "logs" && panel.queries.length < MAX_QUERIES;

  return (
    <div className={s.rows}>
      <div className={s.field}>
        <label className={s.fieldLabel} htmlFor={sourceId}>Source</label>
        <select id={sourceId} className={s.source} value={valueOf(current)} title={choices.find((c) => c.value === valueOf(current))?.label}
          onChange={(e) => setSource(e.target.value)}>
          {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      {logsInChart && (
        <div className={s.warning} role="note">
          <p className={s.warningText}>{LOG_QUERY_IN_CHART}</p>
          <button type="button" className={s.warningAction} onClick={switchToLogs}>{SWITCH_TO_LOGS}</button>
          {refused && <p key={refused.attempt} className={s.warningRefused} role="alert">{refused.text}</p>}
        </div>
      )}
      <div ref={list} className={s.queries}>
        {panel.queries.map((q) => (
          <QueryField key={q.ref} query={q} legend={!isLokiLogQuery(q)} removable={panel.queries.length > 1} onChange={(patch) => setQuery(q.ref, patch)}
            onRemove={() => remove(q.ref)} onKeyDown={onCodeKey} />
        ))}
      </div>
      {canAdd && <button type="button" className={s.add} onClick={add}>+ Add query</button>}
      <div className={s.run}>
        <p className={s.runLine} data-tone={line.tone}>{line.text}</p>
        {reason && <p className={s.runReason}>{reason}</p>}
        <p className={s.hint}>Ctrl+Enter runs it now.</p>
      </div>
    </div>
  );
}

function QueryField({ query, legend, removable, onChange, onRemove, onKeyDown }: {
  query: QuerySpec; legend: boolean; removable: boolean; onChange(patch: Partial<QuerySpec>): void; onRemove(): void;
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void;
}) {
  const id = useId();
  return (
    <div className={s.query} data-hidden={query.hidden || undefined}>
      <div className={s.queryHead}>
        <label className={s.queryName} htmlFor={id}>Query {query.ref}</label>
        {removable && (
          <button type="button" className={s.remove} aria-label={`Remove query ${query.ref}`} onClick={onRemove}>Remove query</button>
        )}
      </div>
      <textarea id={id} data-ref={query.ref} className={s.code} spellCheck={false} autoCapitalize="off" autoCorrect="off"
        rows={rowsFor(query.expr)} value={query.expr} aria-keyshortcuts="Control+Enter"
        onChange={(e) => onChange({ expr: e.target.value })} onKeyDown={onKeyDown} />
      <div className={s.queryMeta}>
        {legend && <label className={s.legend}>
          <span className={s.metaLabel}>Legend</span>
          <input type="text" autoComplete="off" spellCheck={false} className={s.input} placeholder="{{label}}" maxLength={200}
            aria-label={`Query ${query.ref} legend`} value={query.legend} onChange={(e) => onChange({ legend: e.target.value })} />
        </label>}
        <label className={s.check}>
          <input type="checkbox" className={s.box} aria-label={`Hide query ${query.ref}`} checked={query.hidden}
            onChange={(e) => onChange({ hidden: e.target.checked })} />
          <span aria-hidden="true">Hide</span>
        </label>
      </div>
    </div>
  );
}
