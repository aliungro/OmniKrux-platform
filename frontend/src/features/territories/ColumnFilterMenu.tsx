import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ColumnSpec } from "../../api/types";
import { filterUiFor, pickValues, TIME_STEPS, type ColumnFilter } from "./columnFilters";
import type { Territory } from "./model";
import s from "./ColumnFilterMenu.module.css";
export function ColumnFilterMenu({ col, filter, source, onApply, onClose }: { col: ColumnSpec; filter?: ColumnFilter; source: Territory[]; onApply: (f: ColumnFilter | null) => void; onClose: () => void }) {
 const ui = filterUiFor(col); const [text,setText] = useState(filter?.op === "contains" ? filter.text : ""); const [values,setValues] = useState<string[]>(filter?.op === "oneOf" ? filter.values : []); const [query,setQuery] = useState(""); const [op,setOp] = useState<"within"|"olderThan">(filter?.op === "olderThan" ? "olderThan" : "within"); const [seconds,setSeconds] = useState(filter?.op === "within" || filter?.op === "olderThan" ? filter.seconds : 3600); const [min,setMin] = useState(filter?.op === "between" && filter.min !== null ? String(filter.min) : ""); const [max,setMax] = useState(filter?.op === "between" && filter.max !== null ? String(filter.max) : ""); const ref = useRef<HTMLDivElement>(null); const options = useMemo(() => pickValues(source,col), [source,col]); const [page,setPage] = useState(0); const matching = useMemo(() => options.filter(x => x.value.toLowerCase().includes(query.toLowerCase())), [options,query]); const pageSize = 100; const currentPage = Math.min(page, Math.max(0, Math.ceil(matching.length / pageSize) - 1));
 const displayed = matching.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
 const focusPage = useRef(false);
 const lastOwnedFocus = useRef<HTMLElement | null>(null);
 useLayoutEffect(() => {
   if (page !== currentPage) setPage(currentPage);
   const lostOwnedFocus = page !== currentPage && lastOwnedFocus.current !== null && !lastOwnedFocus.current.isConnected && document.activeElement === document.body;
   if (focusPage.current || lostOwnedFocus) {
     focusPage.current = false;
     (ref.current?.querySelector<HTMLElement>('.' + s.options + ' input:not(:disabled)') ?? ref.current?.querySelector<HTMLElement>('input, button'))?.focus();
   }
 }, [page, currentPage]);
 const movePage = (next: number) => { focusPage.current = true; setPage(next); };
 useEffect(() => { ref.current?.querySelector<HTMLElement>("input, button")?.focus(); }, []);
 const apply = (e: FormEvent) => { e.preventDefault(); let f: ColumnFilter | null = null; if (ui === "contains" && text) f = {key:col.key,op:"contains",text}; else if (ui === "pick" && values.length) f = {key:col.key,op:"oneOf",values}; else if (ui === "time") f = {key:col.key,op,seconds}; else if (ui === "number" && (min !== "" || max !== "")) f = {key:col.key,op:"between",min:min === "" ? null : Number(min),max:max === "" ? null : Number(max)}; onApply(f); onClose(); };
 const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
 return <div ref={ref} className={s.menu} onFocusCapture={e=>{lastOwnedFocus.current=e.target as HTMLElement;}} onBlurCapture={e=>{if (!e.relatedTarget || !e.currentTarget.contains(e.relatedTarget)) lastOwnedFocus.current=null;}} role="dialog" aria-label={`Filter by ${col.label}`} onKeyDown={key}><form onSubmit={apply}>
 {ui === "contains" && <input placeholder="Contains…" value={text} onChange={e=>setText(e.target.value)} maxLength={500} />}
 {ui === "pick" && <>{options.length > 12 && <input placeholder="Find a value" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}} />}<div className={s.options}>{displayed.map(x=><label key={x.value}><input type="checkbox" disabled={!values.includes(x.value) && values.length >= 200} checked={values.includes(x.value)} onChange={e=>setValues(e.target.checked ? [...values,x.value] : values.filter(v=>v!==x.value))} /> {x.value || "(none)"} <span>{x.count}</span></label>)}</div>{matching.length > pageSize && <div className={s.actions}><button type="button" disabled={currentPage === 0} onClick={() => movePage(currentPage - 1)}>Previous values</button><span>{currentPage + 1} / {Math.ceil(matching.length / pageSize)}</span><button type="button" disabled={(currentPage + 1) * pageSize >= matching.length} onClick={() => movePage(currentPage + 1)}>Next values</button></div>}{values.length >= 200 && <p>Select up to 200 values.</p>}</>}
 {ui === "time" && (["within","olderThan"] as const).map(mode=><fieldset key={mode}><legend>{mode === "within" ? "Within the last" : "Older than"}</legend>{TIME_STEPS.map(step=><label key={step.seconds}><input type="radio" name="time" checked={op===mode && seconds===step.seconds} onChange={()=>{setOp(mode);setSeconds(step.seconds);}} /> {step.label}</label>)}</fieldset>)}
 {ui === "number" && <div className={s.numbers}><label>Min<input type="number" value={min} onChange={e=>setMin(e.target.value)} /></label><label>Max<input type="number" value={max} onChange={e=>setMax(e.target.value)} /></label></div>}
 <div className={s.actions}><button type="submit">Apply</button><button type="button" onClick={()=>{onApply(null);onClose();}}>Clear</button></div></form></div>;
}
