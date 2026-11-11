import type { Cluster, ColumnSpec } from "../../api/types";
import { chipLabel, filterUiFor, type ColumnFilter } from "../territories/columnFilters";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import { ColumnFilterMenu } from "../territories/ColumnFilterMenu";
import type { Territory } from "../territories/model";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { ChipDef, FilterCounts, Filters } from "../territories/model";
import { capsOf, pageKey, pressed } from "./shortcuts";
import k from "./key.module.css";
import s from "./FilterBar.module.css";

const PLACEHOLDER = "Filter by name, label or image";

/** The namespace chip's list: every namespace in the rows on screen, plus all of them. */
function NamespacePicker({
  value,
  namespaces,
  onPick,
}: {
  value: string | null;
  namespaces: string[];
  onPick: (ns: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const chipRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const id = useId();
  // The current choice stays listed even when no row on screen is in it any more.
  const options: (string | null)[] = [null, ...namespaces];
  if (value !== null && !namespaces.includes(value)) options.splice(1, 0, value);

  const show = () => {
    setActive(Math.max(0, options.indexOf(value)));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) chipRef.current?.focus();
  };
  const pick = (ns: string | null) => {
    close(true);
    if (ns !== value) onPick(ns);
  };

  // Focus follows the active option while the list is open.
  useEffect(() => {
    if (open) optionRefs.current[active]?.focus();
  }, [open, active]);

  // A click anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const last = options.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(last, active + 1),
      ArrowUp: Math.max(0, active - 1),
      Home: 0,
      End: last,
    };
    if (e.key in moves) {
      e.preventDefault();
      setActive(moves[e.key]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      close(e.key === "Escape");
    }
  };

  return (
    <div ref={boxRef} className={s.pick}>
      <button
        ref={chipRef}
        type="button"
        className={`${s.fchip}${value !== null ? ` ${s.on}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            show();
          }
        }}
      >
        Namespace: {value ?? "all"}
        <i className={s.caret} aria-hidden="true" />
      </button>
      {open && (
        <ul id={`${id}-list`} role="listbox" aria-label="Namespace" className={s.menu} onKeyDown={onListKey}>
          {options.map((ns, i) => (
            <li
              key={ns ?? ""}
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              role="option"
              aria-selected={ns === value}
              tabIndex={i === active ? 0 : -1}
              className={`${s.option}${ns === null ? ` ${s.allNs}` : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(ns)}
            >
              {ns ?? "All namespaces"}
            </li>
          ))}
          {namespaces.length === 0 && <li className={s.none} role="presentation">No namespaces in the rows on screen</li>}
        </ul>
      )}
    </div>
  );
}

interface ClusterScopeProps {
  clusters: Cluster[];
  scope: string[] | null;
  onScope: (scope: string[] | null) => void;
}

function ClusterScope({ clusters, scope, onScope }: ClusterScopeProps) {
  const picker = useRef<HTMLButtonElement>(null);
  const focusPicker = useRef(false);
  useLayoutEffect(() => {
    if (scope !== null || !focusPicker.current) return;
    focusPicker.current = false;
    picker.current?.focus();
  }, [scope]);

  const singleId = scope?.length === 1 ? scope[0] : clusters.length === 1 ? clusters[0].id : undefined;
  if (singleId !== undefined) {
    const cluster = clusters.find(c => c.id === singleId);
    return <>
      <span className={s.scope}>
        {cluster && <ProviderBadge provider={knownProvider(cluster.provider)} />}
        {cluster?.name ?? singleId}
      </span>
      {clusters.length > 1 && <button
        type="button"
        className={s.fchip}
        onClick={() => { focusPicker.current = true; onScope(null); }}
      >Show all clusters</button>}
    </>;
  }
  return clusters.length > 1 ? <ClusterPicker clusters={clusters} scope={scope} onScope={onScope} button={picker} /> : null;
}

function ClusterPicker({ clusters, scope, onScope, button }: ClusterScopeProps & { button: RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const label = scope === null ? "All clusters" : `${scope.length} clusters`;
  return <div className={s.pick} ref={box} onKeyDown={e => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); button.current?.focus(); } }}>
    <button ref={button} type="button" aria-label="Clusters" aria-expanded={open} className={`${s.fchip}${scope !== null ? ` ${s.on}` : ""}`} onClick={() => setOpen(!open)}>{label}<i className={s.caret} aria-hidden="true" /></button>
    {open && <div className={s.menu} role="group" aria-label="Cluster scope">
      <button type="button" className={s.addOption} onClick={() => { onScope(null); setOpen(false); button.current?.focus(); }}>All clusters</button>
      {clusters.map(c => <label className={s.option} key={c.id}><input type="checkbox" checked={scope === null || scope.includes(c.id)} onChange={e => { const next = scope === null ? (e.target.checked ? [c.id] : clusters.filter(x => x.id !== c.id).map(x => x.id)) : e.target.checked ? [...scope, c.id] : scope.filter(id => id !== c.id); onScope(next.length === 0 || next.length === clusters.length ? null : next); }} /><ProviderBadge provider={knownProvider(c.provider)} />{c.name}</label>)}
    </div>}
  </div>;
}

export function FilterBar({
  value,
  onChange,
  chips,
  counts,
  namespaces, columns = [], pickSource = [], clusters, scope = null, onScope,
}: {
  value: Filters;
  onChange: (f: Filters) => void;
  /** The kind's status chips (`chipsFor`); none for a kind without a status. */
  chips: ChipDef[];
  counts: FilterCounts;
  /** Namespaces to pick from; null for a kind without namespaces (no chip). */
  namespaces: string[] | null;
  columns?: ColumnSpec[];
  pickSource?: Territory[];
  clusters?: Cluster[];
  scope?: string[] | null;
  onScope?: (scope: string[] | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [openColumn, setOpenColumn] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const closeColumn = () => { setOpenColumn(null); menuTrigger.current?.focus(); };
  const updateColumn = (key: string, f: ColumnFilter | null) => onChange({ ...value, columns: [...value.columns.filter(x => x.key !== key), ...(f ? [f] : [])] });

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!pressed("filter", e) || !pageKey(e)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    if (value.text !== "") onChange({ ...value, text: "" });
    e.currentTarget.blur();
  };

  const chip = (status: Filters["status"], label: string, icon?: ChipDef["icon"]) => (
    <button
      key={status}
      type="button"
      className={`${s.fchip}${value.status === status ? ` ${s.on}` : ""}`}
      aria-pressed={value.status === status}
      onClick={() => onChange({ ...value, status })}
    >
      {icon && <i className={s[icon]} aria-hidden="true" />}
      {label}
    </button>
  );

  return (
    <div className={s.filters} role="group" aria-label="Filter rows" data-page-keys>
      {clusters && onScope && <ClusterScope clusters={clusters} scope={scope} onScope={onScope} />}
      {chips.length > 0 && chip("all", "All")}
      {/* No number until a cluster has reported one: never a made-up 0. */}
      {chips.map((c) => chip(c.status, counts[c.status] === undefined ? c.label : `${c.label} ${counts[c.status]}`, c.icon))}
      {namespaces !== null && (
        <NamespacePicker value={value.namespace} namespaces={namespaces} onPick={(namespace) => onChange({ ...value, namespace })} />
      )}
      {value.columns.map(f => { const col = columns.find(c => c.key === f.key); if (!col) return null; const label = chipLabel(f,col); return <div className={s.pick} key={f.key}><span className={`${s.fchip} ${s.on}`}><button type="button" className={s.chipButton} onClick={e => { menuTrigger.current = e.currentTarget; setOpenColumn(openColumn === f.key ? null : f.key); }}>{label}</button><button type="button" className={s.chipButton} aria-label={`Remove filter ${label}`} onClick={() => updateColumn(f.key,null)}>×</button></span>{openColumn === f.key && <ColumnFilterMenu col={col} filter={f} source={pickSource} onApply={next => updateColumn(f.key,next)} onClose={closeColumn} />}</div>; })}
      {value.columns.length >= 2 && <button type="button" className={s.fchip} onClick={() => onChange({...value, columns: []})}>Clear all</button>}
      {columns.some(c => filterUiFor(c)) && <div className={s.pick}><button type="button" className={s.fchip} aria-expanded={adding} onClick={() => setAdding(!adding)}>Add filter</button>{adding && <div className={s.menu}>{columns.filter(c => filterUiFor(c)).map(c => <button type="button" className={s.addOption} key={c.key} onClick={e => { menuTrigger.current = e.currentTarget.parentElement?.previousElementSibling as HTMLElement | null; setAdding(false); setOpenColumn(c.key); }}>{c.label}</button>)}</div>}{openColumn && !value.columns.some(f => f.key === openColumn) && (() => { const col = columns.find(c => c.key === openColumn); return col && <ColumnFilterMenu col={col} source={pickSource} onApply={f => updateColumn(col.key,f)} onClose={closeColumn} />; })()}</div>}
      <label className={s.search}>
        <span className={k.k} aria-hidden="true">{capsOf("filter")[0]}</span>
        <input
          ref={inputRef}
          type="text"
          className={s.input}
          placeholder={PLACEHOLDER}
          aria-label={PLACEHOLDER}
          aria-keyshortcuts="/"
          maxLength={500}
          spellCheck={false}
          autoComplete="off"
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
          onKeyDown={onInputKey}
        />
      </label>
    </div>
  );
}
