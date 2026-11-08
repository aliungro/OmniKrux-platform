import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { failure } from "../../api/http";
import type { AuditRecord } from "../../api/types";
import { useClusters } from "../../api/useClusters";
import { useNow } from "../../hooks/useNow";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import { Status } from "../territories/Status";
import { formatAgo } from "../territories/model";
import { ACTION_LABELS, actionLabel, diffKind, messageOf, outcomeOf, whatOf } from "./labels";
import { NO_AUDIT_FILTER, useAudit, type AuditFilters } from "./useAudit";
import pc from "../territories/provider.module.css";
import s from "./AuditView.module.css";

const ROW_HEIGHT = 36;
const DETAIL_ESTIMATE = 200;
const OVERSCAN = 12;
const SEARCH_DEBOUNCE_MS = 300;
/** A diff longer than this shows its first lines; a whole-file edit would otherwise fill the page. */
const MAX_DIFF_LINES = 1500;

type Item = { type: "row"; record: AuditRecord } | { type: "detail"; record: AuditRecord };

const TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function localTime(at: string | null, format: Intl.DateTimeFormat): string {
  if (!at) return "—";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : format.format(d);
}

const AuditRow = memo(function AuditRow({
  record,
  now,
  expanded,
  focusable,
  rowIndex,
  onToggle,
}: {
  record: AuditRecord;
  now: Date;
  expanded: boolean;
  focusable: boolean;
  rowIndex: number;
  onToggle: (id: number) => void;
}) {
  const what = whatOf(record);
  const outcome = outcomeOf(record.outcome);
  const message = messageOf(record);
  const provider = knownProvider(record.provider);
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-expanded={expanded}
      tabIndex={focusable ? 0 : -1}
      data-id={record.id}
      className={`${s.row} ${pc[provider]}`}
      onClick={() => onToggle(record.id)}
    >
      <span role="gridcell" className={s.when} title={formatAgo(record.started_at, now)}>
        {localTime(record.started_at, TIME)}
      </span>
      <span role="gridcell" className={s.cell}>{record.actor}</span>
      <span role="gridcell" className={`${s.cell} ${s.action}`}>{actionLabel(record.action)}</span>
      <span role="gridcell" className={`${s.cell} ${s.where}`}>
        <ProviderBadge provider={provider} />
        <span className={s.ellipsis}>{record.namespace ? `${record.cluster_name} / ${record.namespace}` : record.cluster_name}</span>
      </span>
      <span role="gridcell" className={`${s.cell} ${s.what}`}>
        {what.kind && <span className={s.kind}>{what.kind}</span>}
        <span className={s.ellipsis}>{what.name}</span>
      </span>
      <span role="gridcell" className={s.cell}>
        <Status label={outcome.label} cls={outcome.cls} />
      </span>
      <span role="gridcell" className={`${s.cell} ${s.message}`} title={message || undefined}>{message}</span>
    </div>
  );
});

function Detail({ record }: { record: AuditRecord }) {
  const lines = useMemo(() => (record.diff ? record.diff.split("\n") : []), [record.diff]);
  const shown = lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines;
  const details = record.details && Object.keys(record.details).length > 0 ? JSON.stringify(record.details, null, 2) : null;
  const message = messageOf(record);
  return (
    <div className={`${s.detail} ${pc[knownProvider(record.provider)]}`}>
      <p className={s.when2}>
        Started {localTime(record.started_at, FULL)}
        {record.finished_at ? `, finished ${localTime(record.finished_at, FULL)}` : ", not finished"}
        {`. Record ${record.id}.`}
      </p>
      {message && <p className={s.fullMessage}>{message}</p>}
      {shown.length > 0 ? (
        <div className={s.diff} role="group" aria-label="Change">
          {shown.map((line, i) => (
            <div key={i} className={s.line} data-line={diffKind(line)}>{line === "" ? " " : line}</div>
          ))}
          {lines.length > shown.length && (
            <div className={s.cut}>{`Showing the first ${shown.length} of ${lines.length} lines.`}</div>
          )}
        </div>
      ) : (
        <p className={s.none}>This record has no diff: it did not change a stored object.</p>
      )}
      {details && <pre className={s.json} aria-label="Details">{details}</pre>}
    </div>
  );
}

/**
 * The audit log as a full view (`#audit`): every change, shell, debug container, node shell,
 * port-forward and secret reveal Omnikrux made, newest first. The table is virtualized, so
 * thousands of records stay smooth; older ones come a page at a time. A row opens to show what
 * changed (a diff) and its details, exactly as the server recorded them.
 */
export function AuditView({ onBack }: { onBack: () => void }) {
  const clusters = useClusters();
  const [filters, setFilters] = useState<AuditFilters>(NO_AUDIT_FILTER);
  const [typed, setTyped] = useState("");
  const query = useAudit(filters);
  const now = useNow(60_000);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);

  // The search goes to the server once typing pauses.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.text === typed ? f : { ...f, text: typed })), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed]);

  const records = useMemo(() => query.data?.pages.flatMap((p) => p.records) ?? [], [query.data]);
  const items = useMemo<Item[]>(
    () => records.flatMap<Item>((record) => (record.id === expanded ? [{ type: "row", record }, { type: "detail", record }] : [{ type: "row", record }])),
    [records, expanded],
  );
  const indexById = useMemo(() => {
    const m = new Map<number, number>();
    items.forEach((it, i) => it.type === "row" && m.set(it.record.id, i));
    return m;
  }, [items]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i].type === "row" ? ROW_HEIGHT : DETAIL_ESTIMATE),
    getItemKey: (i) => `${items[i].type}:${items[i].record.id}`,
    overscan: OVERSCAN,
    paddingEnd: 8,
  });

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => (prev === id ? null : id));
    setFocusId(id);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const id = target.dataset?.id === undefined ? undefined : Number(target.dataset.id);
    if (id === undefined) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle(id);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = indexById.get(id);
    if (at === undefined) return;
    let i = at + (e.key === "ArrowDown" ? 1 : -1);
    while (i >= 0 && i < items.length && items[i].type !== "row") i += e.key === "ArrowDown" ? 1 : -1;
    const next = items[i];
    if (next?.type !== "row") return;
    setFocusId(next.record.id);
    focusPending.current = true;
    virtualizer.scrollToIndex(i, { align: "auto" });
  };

  // The arrow keys' target takes focus once the virtualizer has drawn it.
  useLayoutEffect(() => {
    if (!focusPending.current || focusId === null) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-id="${focusId}"]`);
    if (!el) return;
    focusPending.current = false;
    el.focus({ preventScroll: true });
  });

  const tabId = focusId !== null && indexById.has(focusId) ? focusId : (records[0]?.id ?? null);
  const filtered = filters.cluster !== "" || filters.action !== "" || filters.text.trim() !== "";
  const loading = query.isPending;
  const failed = query.isError ? failure(query.error, "try again") : null;

  let body;
  if (loading) {
    body = <div className={s.state} role="status">Reading the audit log…</div>;
  } else if (query.data === undefined && failed) {
    body = (
      <div className={s.state} role="alert">
        <span className={s.err}>{failed}</span>
        <button type="button" className={s.btn} onClick={() => void query.refetch()} disabled={query.isFetching}>
          Try again
        </button>
      </div>
    );
  } else if (records.length === 0) {
    body = (
      <div className={s.state}>
        {filtered ? "No records match these filters." : "Nothing has been changed from Omnikrux yet."}
      </div>
    );
  } else {
    body = (
      <div ref={scrollRef} className={s.scroll} onKeyDown={onKeyDown}>
        <div role="grid" aria-label="Audit log" aria-rowcount={records.length + 1} className={s.table}>
          <div role="rowgroup" className={s.head}>
            <div role="row" aria-rowindex={1} className={`${s.grid} ${s.cols}`}>
              {["When", "Who", "Action", "Where", "What", "Outcome", "Message"].map((c) => (
                <span key={c} role="columnheader">{c}</span>
              ))}
            </div>
          </div>
          <div role="rowgroup" className={s.body} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const it = items[v.index];
              if (it.type === "detail") {
                return (
                  <div
                    key={v.key}
                    ref={virtualizer.measureElement}
                    data-index={v.index}
                    role="row"
                    aria-label="Change details"
                    className={s.item}
                    style={{ transform: `translateY(${v.start}px)` }}
                  >
                    <div role="gridcell"><Detail record={it.record} /></div>
                  </div>
                );
              }
              return (
                <div key={v.key} role="presentation" className={s.item} style={{ height: v.size, transform: `translateY(${v.start}px)` }}>
                  <AuditRow
                    record={it.record}
                    now={now}
                    expanded={it.record.id === expanded}
                    focusable={it.record.id === tabId}
                    rowIndex={v.index + 2}
                    onToggle={toggle}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className={s.view} aria-label="Audit log">
      <div className={s.bar}>
        <button type="button" className={s.btn} onClick={onBack}>Back to resources</button>
        <h1 className={s.title}>Audit log</h1>
        <div className={s.filters}>
          <label className={s.field}>
            <span className={s.lbl}>Cluster</span>
            <select value={filters.cluster} onChange={(e) => setFilters({ ...filters, cluster: e.target.value })}>
              <option value="">All clusters</option>
              {(clusters.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            <span className={s.lbl}>Action</span>
            <select value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
              <option value="">All actions</option>
              {ACTION_LABELS.map(([action, label]) => (
                <option key={action} value={action}>{label}</option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            <span className={s.lbl}>Search</span>
            <input
              type="search"
              className={s.search}
              value={typed}
              placeholder="Name, namespace, message"
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
        </div>
      </div>
      {body}
      {records.length > 0 && (
        <div className={s.foot}>
          <span className={s.count}>{`${records.length} ${records.length === 1 ? "record" : "records"}`}</span>
          {query.data !== undefined && failed && <span className={s.err} role="alert">{failed}</span>}
          {query.hasNextPage ? (
            <button type="button" className={s.btn} onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? "Loading older…" : "Load older"}
            </button>
          ) : (
            <span className={s.count}>That is everything recorded.</span>
          )}
        </div>
      )}
    </section>
  );
}
