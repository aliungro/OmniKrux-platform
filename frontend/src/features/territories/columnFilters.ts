import type { ColumnSpec, ResourceRow } from "../../api/types";
import type { Territory } from "./model";
export type ColumnFilter = { key: string; op: "contains"; text: string } | { key: string; op: "oneOf"; values: string[] } | { key: string; op: "within" | "olderThan"; seconds: number } | { key: string; op: "between"; min: number | null; max: number | null };
export interface SortSpec { key: string; dir: "asc" | "desc" }
export type FilterUi = "contains" | "pick" | "time" | "number" | null;
export const PICK_KEYS = new Set(["node", "type", "reason", "roles", "version", "storage_class", "ingress_class", "reclaim", "pressure", "ready"]);
export const TIME_STEPS = [{seconds:300,label:"5 min"},{seconds:3600,label:"1 h"},{seconds:86400,label:"24 h"},{seconds:604800,label:"7 d"}];
export function filterUiFor(c: ColumnSpec): FilterUi {
  if (c.key === "namespace" || ["cpu", "memory", "pods"].includes(c.type)) return null;
  if (c.type === "status" || PICK_KEYS.has(c.key)) return "pick";
  if (c.type === "time" || c.type === "age") return "time";
  if (c.type === "number") return "number";
  return "contains";
}
export function columnValue(row: ResourceRow, col: ColumnSpec): string | number | null {
  const v = col.key === "name" ? row.name : col.key === "namespace" ? row.namespace : col.type === "age" ? row.created_at : row.columns[col.key];
  if (typeof v === "string") return v === "" ? null : v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v)) { const s = v.filter(x => typeof x === "string" || typeof x === "number").join(", "); return s || null; }
  if (v && typeof v === "object" && "label" in v && typeof v.label === "string") return v.label || null;
  return null;
}
export function compileColumnFilters(filters: readonly ColumnFilter[], columns: readonly ColumnSpec[], now: Date): (row: ResourceRow) => boolean {
  const tests = filters.flatMap(f => { const col = columns.find(c => c.key === f.key); if (!col) return [];
    if (f.op === "contains") { const q = f.text.toLowerCase(); return [(r: ResourceRow) => { const v = columnValue(r,col); return v !== null && String(v).toLowerCase().includes(q); }]; }
    if (f.op === "oneOf") { const values = new Set(f.values); return [(r: ResourceRow) => values.has(String(columnValue(r,col) ?? ""))]; }
    if (f.op === "between") return [(r: ResourceRow) => { const v = columnValue(r,col); return typeof v === "number" && (f.min === null || v >= f.min) && (f.max === null || v <= f.max); }];
    return [(r: ResourceRow) => { const v = columnValue(r,col); const t = v === null ? NaN : Date.parse(String(v)); const elapsed = (now.getTime()-t)/1000; return Number.isFinite(t) && (f.op === "within" ? elapsed <= f.seconds : elapsed > f.seconds); }];
  }); return row => tests.every(test => test(row));
}
const natural = new Intl.Collator(undefined,{numeric:true}).compare;
export function pickValues(ts: Territory[], col: ColumnSpec): {value:string;count:number}[] { const counts = new Map<string,number>(); for (const t of ts) if (t.state === "ready") for (const row of t.rows) { const v = String(columnValue(row,col) ?? ""); counts.set(v,(counts.get(v) ?? 0)+1); } return Array.from(counts,([value,count])=>({value,count})).sort((a,b)=>a.value === "" ? 1 : b.value === "" ? -1 : natural(a.value,b.value)); }
export function chipLabel(f: ColumnFilter, col: ColumnSpec): string { const label = col.label; if (f.op === "contains") return `${label} contains "${f.text}"`; if (f.op === "oneOf") { const v = f.values.map(x=>x || "(none)"); return `${label}: ${v.length > 2 ? `${v[0]} +${v.length-1}` : v.join(", ")}`; } if (f.op === "between") return f.min === null ? `${label}: ≤ ${f.max}` : f.max === null ? `${label}: ≥ ${f.min}` : `${label}: ${f.min}–${f.max}`; const step = TIME_STEPS.find(x=>x.seconds===f.seconds)?.label ?? `${f.seconds} s`; return `${label}: ${f.op === "within" ? "within" : "older than"} ${step}`; }
export function sortKey(row: ResourceRow, col: ColumnSpec): string | number | null { const v = columnValue(row,col); if (v === null) return null; if (col.type === "time" || col.type === "age") { const t = Date.parse(String(v)); return Number.isFinite(t) ? t : null; } return v; }
export function compareKeys(a: string | number | null,b: string | number | null,dir: SortSpec["dir"]): number { if (a === null) return b === null ? 0 : 1; if (b === null) return -1; const n = typeof a === "number" && typeof b === "number" ? a-b : natural(String(a),String(b)); return dir === "asc" ? n : -n; }
export function compareBy(col: ColumnSpec, dir: SortSpec["dir"]): (a: ResourceRow,b: ResourceRow)=>number { return (a,b)=>compareKeys(sortKey(a,col),sortKey(b,col),dir) || natural(a.name,b.name); }
export function validColumnFilter(x: unknown): ColumnFilter | null { if (!x || typeof x !== "object") return null; const f = x as Record<string,unknown>; if (typeof f.key !== "string" || !f.key || f.key.length > 500) return null; if (f.op === "contains" && typeof f.text === "string" && f.text.length <= 500) return {key:f.key,op:f.op,text:f.text}; if (f.op === "oneOf" && Array.isArray(f.values) && f.values.length <= 200 && f.values.every(v=>typeof v === "string" && v.length <= 500)) return {key:f.key,op:f.op,values:f.values}; if ((f.op === "within" || f.op === "olderThan") && typeof f.seconds === "number" && Number.isFinite(f.seconds) && f.seconds >= 0) return {key:f.key,op:f.op,seconds:f.seconds}; if (f.op === "between" && (f.min === null || typeof f.min === "number" && Number.isFinite(f.min)) && (f.max === null || typeof f.max === "number" && Number.isFinite(f.max)) && (f.min !== null || f.max !== null)) return {key:f.key,op:f.op,min:f.min as number|null,max:f.max as number|null}; return null; }
export function validSort(x: unknown): SortSpec | null { if (!x || typeof x !== "object") return null; const s = x as Record<string,unknown>; return typeof s.key === "string" && s.key.length > 0 && s.key.length <= 500 && (s.dir === "asc" || s.dir === "desc") ? {key:s.key,dir:s.dir} : null; }
