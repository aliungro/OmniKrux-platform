// The Chart tab: six chart types as tiles (a radio group: arrows move and select), then what the
// chosen type offers. A new type keeps the queries, title and size; its options start from that
// type's defaults, keeping the unit, decimals and thresholds when it has them.
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { defaultOptions, type PanelSpec, type PanelType } from "../schema";
import { CheckRow, NumberRow, Row, SelectRow } from "./OptionsTab";
import type { PanelUpdate } from "./SidePanel";
import s from "./SidePanel.module.css";

export const LOGS_NEED_LOKI = "A logs panel needs a Loki query. Pick a Loki source in Query.";

const CALCS = [["last", "Last"], ["mean", "Mean"], ["max", "Max"], ["min", "Min"], ["sum", "Sum"]] as const;
const KEPT = ["unit", "decimals", "thresholds"] as const;

/** The panel as another chart type: same queries (logs: the first), title and layout; that type's options. */
export function changeType(p: PanelSpec, type: PanelType): PanelSpec {
  if (p.type === type) return p;
  const next = defaultOptions(type) as unknown as Record<string, unknown>;
  const was = p.options as unknown as Record<string, unknown>;
  for (const key of KEPT) if (key in next && key in was) next[key] = was[key];
  // A logs panel has exactly one query: it keeps the first.
  const queries = type === "logs" ? p.queries.slice(0, 1) : p.queries;
  return { ...p, type, queries, options: next } as unknown as PanelSpec;
}

// Small line drawings of each type, in the tile's own colour.
const GLYPHS: Readonly<Record<PanelType, ReactNode>> = {
  timeseries: <polyline points="1,12 5,7 9,9 13,3 17,6" />,
  stat: <><path d="M3 4h12" /><path d="M3 9h8" /><path d="M3 13h5" /></>,
  gauge: <><path d="M2 13a7 7 0 0 1 14 0" /><path d="M9 13l3.5-5" /></>,
  bar: <><path d="M2 4h12" /><path d="M2 8.5h8" /><path d="M2 13h14" /></>,
  table: <><rect x="2" y="3" width="14" height="11" rx="1.5" /><path d="M2 7h14" /><path d="M8 7v7" /></>,
  logs: <><path d="M2 4h3" /><path d="M7 4h9" /><path d="M2 8.5h3" /><path d="M7 8.5h6" /><path d="M2 13h3" /><path d="M7 13h8" /></>,
};
const TYPES: readonly [PanelType, string][] = [
  ["timeseries", "Time series"], ["stat", "Stat"], ["gauge", "Gauge"], ["bar", "Bar"], ["table", "Table"], ["logs", "Logs"],
];

export function ChartTab({ panel, update, onRunNow }: { panel: PanelSpec; update: PanelUpdate; onRunNow?(): void }) {
  const radios = useRef<Partial<Record<PanelType, HTMLButtonElement | null>>>({});
  const pick = (type: PanelType) => update((p) => changeType(p, type));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TYPES.findIndex(([t]) => t === panel.type);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    const type = TYPES[(at + step + TYPES.length) % TYPES.length][0];
    pick(type);
    radios.current[type]?.focus();
  };
  const set = (patch: Record<string, unknown>) => update((p) => ({ ...p, options: { ...p.options, ...patch } } as PanelSpec));

  return (
    <div className={s.rows}>
      <div role="radiogroup" aria-label="Chart type" className={s.types} onKeyDown={onKey}>
        {TYPES.map(([type, label]) => (
          <button key={type} ref={(el) => { radios.current[type] = el; }} type="button" role="radio"
            aria-checked={panel.type === type} tabIndex={panel.type === type ? 0 : -1} className={s.type}
            onClick={() => pick(type)}>
            <svg className={s.glyph} viewBox="0 0 18 16" aria-hidden="true">{GLYPHS[type]}</svg>
            <span>{label}</span>
          </button>
        ))}
      </div>
      {panel.type === "timeseries" && (
        <SelectRow label="Style" value={panel.options.style} onChange={(style) => set({ style })}
          choices={[["lines", "Lines"], ["area", "Area"], ["stacked", "Stacked"]] as const} />
      )}
      {(panel.type === "stat" || panel.type === "gauge") && (
        <SelectRow label="Show" value={panel.options.calc} choices={CALCS} onChange={(calc) => set({ calc })} />
      )}
      {panel.type === "stat" && <CheckRow label="Sparkline" checked={panel.options.sparkline} onChange={(sparkline) => set({ sparkline })} />}
      {panel.type === "bar" && (
        <SelectRow label="Direction" value={panel.options.orientation} onChange={(orientation) => set({ orientation })}
          choices={[["horizontal", "Horizontal"], ["vertical", "Vertical"]] as const} />
      )}
      {panel.type === "table" && <Columns columns={panel.options.columns} onChange={(columns) => set({ columns })} />}
      {panel.type === "logs" && (
        <>
          {panel.queries.some((q) => q.source.type !== "loki") && <p className={s.warning} role="note">{LOGS_NEED_LOKI}</p>}
          {/* Lines is part of the request: it runs with the queries, after the typing stops or on Ctrl+Enter. */}
          <NumberRow label="Lines" value={panel.options.limit} whole={[1, 1000]} onRunNow={onRunNow}
            onValue={(limit) => { if (limit !== null) set({ limit }); }} />
          <CheckRow label="Wrap long lines" checked={panel.options.wrap} onChange={(wrap) => set({ wrap })} />
          <SelectRow label="Order" value={panel.options.order} onChange={(order) => set({ order })}
            choices={[["newest", "Newest first"], ["oldest", "Oldest first"]] as const} />
        </>
      )}
    </div>
  );
}

const parseColumns = (text: string) => text.split(",").map((c) => c.trim()).filter((c) => c !== "");

/** Label names, comma-separated; empty shows every label. */
function Columns({ columns, onChange }: { columns: string[]; onChange(columns: string[]): void }) {
  const id = useId();
  const [text, setText] = useState(columns.join(", "));
  // Changed elsewhere (the JSON): show it.
  const [was, setWas] = useState(columns);
  if (was !== columns) {
    setWas(columns);
    if (JSON.stringify(parseColumns(text)) !== JSON.stringify(columns)) setText(columns.join(", "));
  }
  return (
    <>
      <Row label="Columns" htmlFor={id}>
        <input id={id} type="text" autoComplete="off" spellCheck={false} className={s.input} value={text} placeholder="All labels"
          onChange={(e) => {
            setText(e.target.value);
            const next = parseColumns(e.target.value);
            if (JSON.stringify(next) !== JSON.stringify(columns)) onChange(next);
          }} />
      </Row>
      <p className={s.note}>Sort by clicking a column.</p>
    </>
  );
}
