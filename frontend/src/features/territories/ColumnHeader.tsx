import { useRef, useState } from "react";
import type { ColumnSpec } from "../../api/types";
import { filterUiFor, type ColumnFilter, type SortSpec } from "./columnFilters";
import { ColumnFilterMenu } from "./ColumnFilterMenu";
import type { Territory } from "./model";
import s from "./ColumnHeader.module.css";
export function ColumnHeader({ col, filter, sort, source, onFilter, onSort }: { col:ColumnSpec; filter?:ColumnFilter; sort:SortSpec|null; source:Territory[]; onFilter:(f:ColumnFilter|null)=>void; onSort:(s:SortSpec|null)=>void }) {
 const [open,setOpen] = useState(false); const trigger = useRef<HTMLButtonElement>(null); const sortable = !["cpu","memory","pods"].includes(col.type); const dir = sort?.key === col.key ? sort.dir : null;
 const close = () => { setOpen(false); trigger.current?.focus(); };
 return <span role="columnheader" aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"} className={s.header}>{sortable ? <button className={s.sort} title={`Sort by ${col.label}`} onClick={()=>onSort(dir === "asc" ? {key:col.key,dir:"desc"} : dir === "desc" ? null : {key:col.key,dir:"asc"})}>{col.label}{dir && (dir === "asc" ? " ▲" : " ▼")}</button> : col.label}{filterUiFor(col) && <><button ref={trigger} type="button" className={`${s.filter} ${filter ? s.active : ""}`} aria-label={`Filter by ${col.label}`} aria-expanded={open} onClick={()=>setOpen(!open)}><svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M1 2h10L7 6.5V10L5 11V6.5z" fill="currentColor" /></svg></button>{open && <ColumnFilterMenu col={col} filter={filter} source={source} onApply={onFilter} onClose={close} />}</>}</span>;
}
