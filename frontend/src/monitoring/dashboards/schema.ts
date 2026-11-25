// The dashboard document (schemaVersion 1) and its validation, a field-for-field port of the
// server's walker (backend/omnikrux/monitoring/dashboards/schema.py). Both run the shared case
// file, so the problems, their order, their copy and the normalised output are identical.
//
// Order of problems: each object's fields in the schema table's order (a nested object's
// problems come at its field's place), then that object's unknown keys in code-point order.
// Output objects are built literally in schema order, so no integer-like key can reorder them.
//
// Only dashboard code imports this module; it must stay out of the startup bundle.

import {
  ALERT_PANEL_TYPES,
  CONTACT_ID,
  EVERY_SECONDS,
  LOG_QUERY_COPY,
  MAX_CHANNEL_LABELS,
  MAX_FOR_SECONDS,
  MAX_NOTIFY,
  SEVERITIES,
  defaultsExpr,
  isLogQuery,
  parseDuration,
} from "../alerts/limits";

export { ALERT_PANEL_TYPES };

export type OwnerKind = "project" | "group";
export type PanelType = "timeseries" | "stat" | "gauge" | "bar" | "table" | "logs";
export type Unit =
  | "none"
  | "short"
  | "percent"
  | "percentunit"
  | "s"
  | "ms"
  | "bytes"
  | "Bps"
  | "reqps"
  | "cores";
export type ThresholdColor = "ok" | "warn" | "bad";

export const SCHEMA_VERSION = 1;
export const GRID_COLUMNS = 24;
export const MAX_PANELS = 100;
export const MAX_QUERIES = 10;
export const MAX_VARIABLES = 20;
export const MAX_THRESHOLDS = 10;
export const MAX_DOCUMENT_BYTES = 1_000_000;
const MAX_PROBLEMS = 50;
const MAX_VARIABLE_VALUES = 100;

export const PANEL_TYPES: readonly PanelType[] = [
  "timeseries",
  "stat",
  "gauge",
  "bar",
  "table",
  "logs",
];
export const UNITS: readonly Unit[] = [
  "none",
  "short",
  "percent",
  "percentunit",
  "s",
  "ms",
  "bytes",
  "Bps",
  "reqps",
  "cores",
];
export const REFRESH_CHOICES: readonly (RefreshSpec)[] = [
  null,
  "10s",
  "30s",
  "1m",
  "5m",
  "15m",
  "1h",
];
export const DEFAULT_SIZES: Readonly<Record<PanelType, { w: number; h: number }>> = {
  timeseries: { w: 12, h: 8 },
  stat: { w: 6, h: 4 },
  gauge: { w: 6, h: 6 },
  bar: { w: 12, h: 8 },
  table: { w: 12, h: 8 },
  logs: { w: 24, h: 10 },
};
export const BUILTIN_VARIABLES: readonly string[] = ["__interval", "__rate_interval", "__range"];

const SOURCE_TYPES = ["prometheus", "loki"] as const;
const THRESHOLD_COLORS: readonly ThresholdColor[] = ["ok", "warn", "bad"];
const CALCS = ["last", "mean", "max", "min", "sum"] as const;
const LEGENDS = ["bottom", "hidden"] as const;

export interface Threshold {
  value: number;
  color: ThresholdColor;
}
export interface SourceRef {
  type: "prometheus" | "loki";
  id: string | null;
}
export interface QuerySpec {
  ref: string;
  source: SourceRef;
  expr: string;
  legend: string;
  hidden: boolean;
}
export interface Layout {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface CommonOptions {
  unit: Unit;
  decimals: number | null;
  thresholds: Threshold[];
}
export interface TimeseriesOptions extends CommonOptions {
  min: number | null;
  max: number | null;
  legend: "bottom" | "hidden";
  style: "lines" | "area" | "stacked" | "bars";
}
export interface StatOptions extends CommonOptions {
  calc: "last" | "mean" | "max" | "min" | "sum";
  sparkline: boolean;
}
export interface GaugeOptions extends CommonOptions {
  min: number | null;
  max: number | null;
  calc: "last" | "mean" | "max" | "min" | "sum";
}
export interface BarOptions extends CommonOptions {
  min: number | null;
  legend: "bottom" | "hidden";
  orientation: "horizontal" | "vertical";
}
export interface TableOptions extends CommonOptions {
  columns: string[];
  sort: { column: string; descending: boolean } | null;
}
export interface LogsOptions {
  limit: number;
  wrap: boolean;
  order: "newest" | "oldest";
}
interface PanelBase {
  id: string;
  title: string;
  description: string;
  layout: Layout;
  queries: QuerySpec[];
  alert: PanelAlert | null;
}
export interface AlertChannel {
  receiver: string;
  labels: Record<string, string>;
}
export interface PanelAlert {
  name: string;
  query: string;
  of: "each" | "total";
  op: "above" | "below";
  threshold: number;
  for: string;
  every: "30s" | "1m" | "5m";
  severity: "critical" | "warning" | "info";
  message: string;
  notify: string[];
  engine: "omnikrux" | "tool";
  channel: AlertChannel | null;
}
export type PanelSpec =
  | (PanelBase & { type: "timeseries"; options: TimeseriesOptions })
  | (PanelBase & { type: "stat"; options: StatOptions })
  | (PanelBase & { type: "gauge"; options: GaugeOptions })
  | (PanelBase & { type: "bar"; options: BarOptions })
  | (PanelBase & { type: "table"; options: TableOptions })
  | (PanelBase & { type: "logs"; options: LogsOptions });
export interface VariableSpec {
  name: string;
  label: string;
  type: "labelValues";
  source: SourceRef;
  labelName: string;
  match: string;
  multi: boolean;
  includeAll: boolean;
  default: "all" | string[];
}
export interface TimeSpec {
  from: string;
  to: string;
}
export type RefreshSpec = "10s" | "30s" | "1m" | "5m" | "15m" | "1h" | null;
export interface DashboardSpec {
  schemaVersion: 1;
  title: string;
  description: string;
  time: TimeSpec;
  refresh: RefreshSpec;
  variables: VariableSpec[];
  panels: PanelSpec[];
}
export interface Problem {
  path: string;
  message: string;
}
export type Validation = { ok: true; spec: DashboardSpec } | { ok: false; problems: Problem[] };

// --- copy ---------------------------------------------------------------------------------

export const TIME_COPY =
  'Use "now", "now-<number><s|m|h|d|w>", or a UTC time like 2026-11-19T10:00:00Z.';
const NAME_COPY =
  "Use letters, digits and _, starting with a letter or _, at most 40 characters, " +
  "not starting with __.";
const ID_COPY = "Use 1 to 40 lower-case letters, digits or dashes, starting with a letter or digit.";
const GROUP_ID_COPY = 'In a group dashboard each project uses its own source, so "id" must be null.';

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PANEL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REF = /^[A-Z]$/;
export const REL_TIME = /^now-([0-9]+)([smhdw])$/;
export const ABS_TIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/;
const USED = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const UNIT_SECONDS: Record<string, bigint> = {
  s: 1n,
  m: 60n,
  h: 3600n,
  d: 86400n,
  w: 604800n,
};

// --- the walker ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const MISSING: unique symbol = Symbol("missing");
type Maybe = unknown | typeof MISSING;

class Walk {
  problems: Problem[] = [];
  constructor(readonly ownerKind: OwnerKind) {}
  add(path: string, message: string): void {
    if (this.problems.length < MAX_PROBLEMS) this.problems.push({ path, message });
  }
}

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
const field = (o: Obj, key: string): Maybe => (hasOwn(o, key) ? o[key] : MISSING);
const at = (path: string, key: string | number): string =>
  typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;
const points = (s: string): number => [...s].length;

function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function number(w: Walk, raw: unknown, path: string): number | null {
  if (typeof raw !== "number") {
    w.add(path, "Expected a number.");
    return null;
  }
  if (!Number.isFinite(raw)) {
    w.add(path, "Expected a finite number.");
    return null;
  }
  return raw === 0 ? 0 : raw; // -0 is 0, as on the server
}

function whole(
  w: Walk,
  raw: unknown,
  path: string,
  lo: number,
  hi: number,
  message: string,
): number | null {
  const n = number(w, raw, path);
  if (n === null) return null;
  if (!Number.isInteger(n) || n < lo || n > hi) {
    w.add(path, message);
    return null;
  }
  return n;
}

function text(w: Walk, raw: unknown, path: string): string | null {
  if (typeof raw !== "string") {
    w.add(path, "Expected text.");
    return null;
  }
  return raw;
}

function boolean(w: Walk, raw: unknown, path: string): boolean | null {
  if (typeof raw !== "boolean") {
    w.add(path, "Expected true or false.");
    return null;
  }
  return raw;
}

function list(w: Walk, raw: unknown, path: string): unknown[] | null {
  if (!Array.isArray(raw)) {
    w.add(path, "Expected a list.");
    return null;
  }
  return raw;
}

function object(w: Walk, raw: unknown, path: string): Obj | null {
  if (!isObject(raw)) {
    w.add(path, "Expected an object.");
    return null;
  }
  return raw;
}

function enumOf<T extends string>(
  w: Walk,
  raw: unknown,
  path: string,
  choices: readonly T[],
  message?: string,
): T | null {
  const t = text(w, raw, path);
  if (t === null) return null;
  if (!(choices as readonly string[]).includes(t)) {
    w.add(path, message ?? `Use one of: ${choices.join(", ")}.`);
    return null;
  }
  return t as T;
}

function unknownKeys(w: Walk, raw: Obj, path: string, known: readonly string[]): void {
  const extra = Object.keys(raw)
    .filter((k) => !known.includes(k))
    .sort(compareCodePoints);
  for (const key of extra) w.add(at(path, key), `Unknown field "${key}".`);
}

function required(w: Walk, raw: Obj, path: string, key: string): Maybe {
  if (!hasOwn(raw, key)) w.add(at(path, key), "Required.");
  return field(raw, key);
}

// Python's str.strip() once control characters are excluded: Zs plus the line and paragraph
// separators. JS trim() would also drop U+FEFF, which the server keeps.
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const STRIP = new RegExp(String.raw`^[\p{Zs}${SEPARATORS}]+|[\p{Zs}${SEPARATORS}]+$`, "gu");
const pyStrip = (t: string): string => t.replace(STRIP, "");

function shortText(w: Walk, raw: unknown, path: string, lo: number, message: string): string | null {
  const t = text(w, raw, path);
  if (t === null) return null;
  if (/\p{Cc}/u.test(t)) {
    w.add(path, message);
    return null;
  }
  const trimmed = pyStrip(t);
  const n = points(trimmed);
  if (n < lo || n > 120) {
    w.add(path, message);
    return null;
  }
  return trimmed;
}

function longText(w: Walk, raw: unknown, path: string, limit: number, message: string) {
  const t = text(w, raw, path);
  if (t === null) return null;
  if (points(t) > limit) {
    w.add(path, message);
    return null;
  }
  return t;
}

/** Names used as $name or ${name}, in order, without duplicates. */
export function variablesUsed(s: string): string[] {
  const seen: string[] = [];
  for (const m of s.matchAll(USED)) {
    const name = m[1] ?? m[2];
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

// --- time ---------------------------------------------------------------------------------

export function validUtc(t: string): boolean {
  const m = ABS_TIME.exec(t);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= days && hour < 24 && minute < 60 && second < 60;
}

function timePoint(w: Walk, raw: unknown, path: string): string | null {
  const t = text(w, raw, path);
  if (t === null) return null;
  if (t === "now" || REL_TIME.test(t) || validUtc(t)) return t;
  w.add(path, TIME_COPY);
  return null;
}

/** Seconds back from now, or null for an absolute time. */
function relativeOffset(t: string): bigint | null {
  if (t === "now") return 0n;
  const m = REL_TIME.exec(t);
  return m ? BigInt(m[1]) * UNIT_SECONDS[m[2]] : null;
}

function time(w: Walk, raw: Maybe, path: string): TimeSpec {
  const fallback = { from: "now-6h", to: "now" };
  if (raw === MISSING) return fallback;
  const obj = object(w, raw, path);
  if (obj === null) return fallback;
  const start = timePoint(w, hasOwn(obj, "from") ? obj.from : fallback.from, at(path, "from"));
  const end = timePoint(w, hasOwn(obj, "to") ? obj.to : fallback.to, at(path, "to"));
  unknownKeys(w, obj, path, ["from", "to"]);
  if (start !== null && end !== null) {
    const a = relativeOffset(start);
    const b = relativeOffset(end);
    let backwards = false;
    if (a !== null && b !== null) backwards = a <= b; // further back in time is earlier
    else if (a === null && b === null) backwards = start >= end; // fixed-width UTC strings sort as times
    if (backwards) w.add(path, "The start has to be before the end.");
  }
  return { from: start, to: end } as TimeSpec;
}

// --- sources, variables -------------------------------------------------------------------

function source(w: Walk, raw: unknown, path: string): SourceRef {
  const obj = object(w, raw, path);
  if (obj === null) return { type: null, id: null } as unknown as SourceRef;
  const typeRaw = required(w, obj, path, "type");
  let kind: SourceRef["type"] | null = null;
  if (typeRaw !== MISSING) {
    kind = enumOf(w, typeRaw, at(path, "type"), SOURCE_TYPES, 'Use "prometheus" or "loki".');
  }
  let id: string | null = null;
  if (hasOwn(obj, "id") && obj.id !== null) {
    id = text(w, obj.id, at(path, "id"));
    if (id !== null && w.ownerKind === "group") {
      w.add(at(path, "id"), GROUP_ID_COPY);
      id = null;
    }
  }
  unknownKeys(w, obj, path, ["type", "id"]);
  return { type: kind, id } as SourceRef;
}

function variableDefault(
  w: Walk,
  raw: Obj,
  path: string,
  multi: boolean | null,
  includeAll: boolean | null,
): "all" | (string | null)[] {
  if (!hasOwn(raw, "default")) return [];
  const p = at(path, "default");
  const value = raw.default;
  if (value === "all") {
    if (includeAll !== true) w.add(p, '"all" needs includeAll: true.');
    return "all";
  }
  const items = list(w, value, p);
  if (items === null) return [];
  if (items.length > MAX_VARIABLE_VALUES) w.add(p, "At most 100 values.");
  if (items.length > 1 && multi !== true) {
    w.add(p, "Only a multi-value variable can start with more than one value.");
  }
  return items.map((item, i) => text(w, item, at(p, i)));
}

function checkUses(
  w: Walk,
  t: string,
  path: string,
  defined: Map<string, number>,
  before: number | null,
): void {
  for (const name of variablesUsed(t)) {
    if (BUILTIN_VARIABLES.includes(name)) continue;
    const index = defined.get(name);
    if (index === undefined) {
      w.add(path, `Uses $${name}, which isn't a variable of this dashboard.`);
    } else if (before !== null && index >= before) {
      w.add(path, `Uses $${name}, which comes after this variable. Move ${name} before it.`);
    }
  }
}

function variable(
  w: Walk,
  raw: unknown,
  path: string,
  index: number,
  seen: Set<string>,
  defined: Map<string, number>,
): unknown {
  const obj = object(w, raw, path);
  if (obj === null) return null;
  const nameRaw = required(w, obj, path, "name");
  let name: string | null = null;
  if (nameRaw !== MISSING) {
    name = text(w, nameRaw, at(path, "name"));
    if (name !== null) {
      if (!NAME.test(name) || name.startsWith("__")) {
        w.add(at(path, "name"), NAME_COPY);
        name = null;
      } else if (seen.has(name)) {
        w.add(at(path, "name"), `Another variable is already named "${name}".`);
      } else {
        seen.add(name);
      }
    }
  }
  let label = name;
  if (hasOwn(obj, "label")) {
    label = shortText(
      w,
      obj.label,
      at(path, "label"),
      1,
      "Use 1 to 120 characters, without line breaks.",
    );
  }
  const typeRaw = required(w, obj, path, "type");
  if (typeRaw !== MISSING) enumOf(w, typeRaw, at(path, "type"), ["labelValues"]);
  const srcRaw = required(w, obj, path, "source");
  const src = srcRaw !== MISSING ? source(w, srcRaw, at(path, "source")) : null;
  const labelRaw = required(w, obj, path, "labelName");
  let labelName: string | null = null;
  if (labelRaw !== MISSING) {
    labelName = text(w, labelRaw, at(path, "labelName"));
    if (labelName !== null && !LABEL.test(labelName)) {
      w.add(
        at(path, "labelName"),
        "Use a label name: letters, digits and _, not starting with a digit.",
      );
    }
  }
  let match = "";
  if (hasOwn(obj, "match")) {
    const t = longText(w, obj.match, at(path, "match"), 1000, "Use at most 1000 characters.");
    if (t !== null) {
      match = t;
      checkUses(w, t, at(path, "match"), defined, index);
    }
  }
  const multi = hasOwn(obj, "multi") ? boolean(w, obj.multi, at(path, "multi")) : false;
  const includeAll = hasOwn(obj, "includeAll")
    ? boolean(w, obj.includeAll, at(path, "includeAll"))
    : false;
  const def = variableDefault(w, obj, path, multi, includeAll);
  unknownKeys(w, obj, path, [
    "name",
    "label",
    "type",
    "source",
    "labelName",
    "match",
    "multi",
    "includeAll",
    "default",
  ]);
  return {
    name,
    label,
    type: "labelValues",
    source: src,
    labelName,
    match,
    multi,
    includeAll,
    default: def,
  };
}

// --- panels -------------------------------------------------------------------------------

function thresholds(w: Walk, raw: unknown, path: string): unknown[] {
  const items = list(w, raw, path);
  if (items === null) return [];
  if (items.length > MAX_THRESHOLDS) w.add(path, "At most 10 thresholds.");
  const out: { value: number | null; color: string | null }[] = [];
  items.forEach((item, i) => {
    const p = at(path, i);
    const obj = object(w, item, p);
    if (obj === null) return;
    const valueRaw = required(w, obj, p, "value");
    const value = valueRaw === MISSING ? null : number(w, valueRaw, at(p, "value"));
    const colorRaw = required(w, obj, p, "color");
    let color: string | null = null;
    if (colorRaw !== MISSING) {
      color = enumOf(w, colorRaw, at(p, "color"), THRESHOLD_COLORS, "Use ok, warn or bad.");
    }
    unknownKeys(w, obj, p, ["value", "color"]);
    out.push({ value, color });
  });
  return out.sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
}

function optNumber(w: Walk, obj: Obj, path: string, key: string, dflt: number | null) {
  if (!hasOwn(obj, key)) return dflt;
  if (obj[key] === null) return null;
  return number(w, obj[key], at(path, key));
}

function optEnum<T extends string>(
  w: Walk,
  obj: Obj,
  path: string,
  key: string,
  choices: readonly T[],
): T | null {
  if (!hasOwn(obj, key)) return choices[0];
  return enumOf(w, obj[key], at(path, key), choices);
}

function optBool(w: Walk, obj: Obj, path: string, key: string, dflt: boolean) {
  return hasOwn(obj, key) ? boolean(w, obj[key], at(path, key)) : dflt;
}

function commonOptions(w: Walk, obj: Obj, path: string): Obj {
  const unit = hasOwn(obj, "unit")
    ? enumOf(w, obj.unit, at(path, "unit"), UNITS, `Use one of: ${UNITS.join(", ")}.`)
    : "none";
  const decimals =
    hasOwn(obj, "decimals") && obj.decimals !== null
      ? whole(w, obj.decimals, at(path, "decimals"), 0, 6, "Use null or a whole number from 0 to 6.")
      : null;
  const th = hasOwn(obj, "thresholds") ? thresholds(w, obj.thresholds, at(path, "thresholds")) : [];
  return { unit, decimals, thresholds: th };
}

const COMMON_KEYS = ["unit", "decimals", "thresholds"];
const OPTION_KEYS: Record<PanelType, readonly string[]> = {
  timeseries: [...COMMON_KEYS, "min", "max", "legend", "style"],
  stat: [...COMMON_KEYS, "calc", "sparkline"],
  gauge: [...COMMON_KEYS, "min", "max", "calc"],
  bar: [...COMMON_KEYS, "min", "legend", "orientation"],
  table: [...COMMON_KEYS, "columns", "sort"],
  logs: ["limit", "wrap", "order"],
};

function tableSort(w: Walk, raw: unknown, path: string): unknown {
  if (raw === null) return null;
  const obj = object(w, raw, path);
  if (obj === null) return null;
  const columnRaw = required(w, obj, path, "column");
  const column = columnRaw === MISSING ? null : text(w, columnRaw, at(path, "column"));
  const descending = optBool(w, obj, path, "descending", false);
  unknownKeys(w, obj, path, ["column", "descending"]);
  return { column, descending };
}

function options(w: Walk, raw: unknown, path: string, kind: PanelType): Obj {
  const obj = object(w, raw, path);
  if (obj === null) return {};
  const out: Obj = kind === "logs" ? {} : commonOptions(w, obj, path);
  if (kind === "timeseries") {
    out.min = optNumber(w, obj, path, "min", null);
    out.max = optNumber(w, obj, path, "max", null);
    out.legend = optEnum(w, obj, path, "legend", LEGENDS);
    out.style = optEnum(w, obj, path, "style", ["lines", "area", "stacked", "bars"] as const);
  } else if (kind === "stat") {
    out.calc = optEnum(w, obj, path, "calc", CALCS);
    out.sparkline = optBool(w, obj, path, "sparkline", true);
  } else if (kind === "gauge") {
    out.min = optNumber(w, obj, path, "min", 0);
    out.max = optNumber(w, obj, path, "max", null);
    out.calc = optEnum(w, obj, path, "calc", CALCS);
  } else if (kind === "bar") {
    out.min = optNumber(w, obj, path, "min", null);
    out.legend = optEnum(w, obj, path, "legend", LEGENDS);
    out.orientation = optEnum(w, obj, path, "orientation", ["horizontal", "vertical"] as const);
  } else if (kind === "table") {
    let columns: (string | null)[] = [];
    if (hasOwn(obj, "columns")) {
      const items = list(w, obj.columns, at(path, "columns"));
      if (items !== null) {
        columns = items.map((c, i) => text(w, c, at(at(path, "columns"), i)));
      }
    }
    out.columns = columns;
    out.sort = hasOwn(obj, "sort") ? tableSort(w, obj.sort, at(path, "sort")) : null;
  } else {
    out.limit = hasOwn(obj, "limit")
      ? whole(w, obj.limit, at(path, "limit"), 1, 1000, "Use a whole number from 1 to 1000.")
      : 100;
    out.wrap = optBool(w, obj, path, "wrap", true);
    out.order = optEnum(w, obj, path, "order", ["newest", "oldest"] as const);
  }
  unknownKeys(w, obj, path, OPTION_KEYS[kind]);
  return out;
}

type Placed = [string, Layout];

function layout(
  w: Walk,
  raw: unknown,
  path: string,
  placed: Placed[],
  panelId: string,
): Obj | null {
  const obj = object(w, raw, path);
  if (obj === null) return null;
  const specs: [string, number, number, string][] = [
    ["x", 0, 22, "Use a whole number from 0 to 22."],
    ["y", 0, 999, "Use a whole number from 0 to 999."],
    ["w", 2, 24, "Use a whole number from 2 to 24."],
    ["h", 2, 40, "Use a whole number from 2 to 40."],
  ];
  const values: Record<string, number | null> = {};
  for (const [key, lo, hi, message] of specs) {
    const value = required(w, obj, path, key);
    values[key] = value === MISSING ? null : whole(w, value, at(path, key), lo, hi, message);
  }
  let clean = Object.values(values).every((v) => v !== null);
  if (values.x !== null && values.w !== null && values.x + values.w > GRID_COLUMNS) {
    w.add(path, "x + w can't be more than 24 (the grid is 24 columns wide).");
    clean = false;
  }
  unknownKeys(w, obj, path, ["x", "y", "w", "h"]);
  if (clean) {
    const x = values.x!;
    const y = values.y!;
    const ww = values.w!;
    const h = values.h!;
    for (const [otherId, o] of placed) {
      if (x < o.x + o.w && o.x < x + ww && y < o.y + o.h && o.y < y + h) {
        w.add(path, `Panel "${panelId}" overlaps panel "${otherId}". Move one of them.`);
        break;
      }
    }
    placed.push([panelId, { x, y, w: ww, h }]);
  }
  return values;
}

function query(
  w: Walk,
  raw: unknown,
  path: string,
  refs: Set<string>,
  defined: Map<string, number>,
): unknown {
  const obj = object(w, raw, path);
  if (obj === null) return null;
  const refRaw = required(w, obj, path, "ref");
  let ref: string | null = null;
  if (refRaw !== MISSING) {
    ref = text(w, refRaw, at(path, "ref"));
    if (ref !== null) {
      if (!REF.test(ref) || refs.has(ref)) {
        w.add(at(path, "ref"), "Use a capital letter A to Z, different for each query.");
        ref = null;
      } else {
        refs.add(ref);
      }
    }
  }
  const srcRaw = required(w, obj, path, "source");
  const src = srcRaw !== MISSING ? source(w, srcRaw, at(path, "source")) : null;
  const exprRaw = required(w, obj, path, "expr");
  let expr: string | null = null;
  if (exprRaw !== MISSING) {
    expr = text(w, exprRaw, at(path, "expr"));
    if (expr !== null) {
      const n = points(expr);
      if (n < 1 || n > 10000) {
        w.add(at(path, "expr"), "Use 1 to 10000 characters.");
        expr = null;
      } else {
        checkUses(w, expr, at(path, "expr"), defined, null);
      }
    }
  }
  let legend: string | null = "";
  if (hasOwn(obj, "legend")) {
    legend = longText(w, obj.legend, at(path, "legend"), 200, "Use at most 200 characters.");
  }
  const hidden = hasOwn(obj, "hidden") ? boolean(w, obj.hidden, at(path, "hidden")) : false;
  unknownKeys(w, obj, path, ["ref", "source", "expr", "legend", "hidden"]);
  return { ref, source: src, expr, legend, hidden };
}

function isLokiQuery(raw: unknown): boolean {
  return isObject(raw) && isObject(raw.source) && raw.source.type === "loki";
}

function queries(
  w: Walk,
  raw: unknown,
  path: string,
  kind: PanelType | null,
  defined: Map<string, number>,
): unknown[] {
  const items = list(w, raw, path);
  if (items === null) return [];
  if (kind === "logs") {
    if (items.length !== 1 || !isLokiQuery(items[0])) {
      w.add(path, "A logs panel has exactly one Loki query.");
    }
  } else if (items.length < 1 || items.length > MAX_QUERIES) {
    w.add(path, "A panel has 1 to 10 queries.");
  }
  const refs = new Set<string>();
  return items.map((item, i) => query(w, item, at(path, i), refs, defined));
}

// --- the alert on a panel -----------------------------------------------------------------

/** Why an alert can't run this query text, or null. */
function alertQueryProblem(expr: string, variables: unknown[], everySeconds: number): string | null {
  const out = defaultsExpr(expr, variables, everySeconds);
  return "problem" in out ? out.problem : null;
}

function alertQuery(
  w: Walk,
  raw: unknown,
  path: string,
  qs: unknown[],
  variables: unknown[],
  every: number,
): string | null {
  const ref = text(w, raw, path);
  if (ref === null) return null;
  const q = qs.find((x) => isObject(x) && x.ref === ref) as Obj | undefined;
  if (q === undefined) {
    w.add(path, "Use the ref of one of this panel's queries, like A.");
    return null;
  }
  const expr = q.expr;
  if (typeof expr !== "string") return ref;
  const src = q.source;
  if (isObject(src) && src.type === "loki" && isLogQuery(expr)) {
    w.add(path, LOG_QUERY_COPY);
    return ref;
  }
  const problem = alertQueryProblem(expr, variables, every);
  if (problem !== null) w.add(path, problem);
  return ref;
}

function alertChannel(w: Walk, raw: unknown, path: string, engine: string | null): unknown {
  if (raw === null) return null;
  const obj = object(w, raw, path);
  if (obj === null) return null;
  if (engine !== null && engine !== "tool") {
    w.add(path, "A channel is only for alerts that run in the tool.");
  }
  const receiverRaw = required(w, obj, path, "receiver");
  let receiver: string | null = null;
  if (receiverRaw !== MISSING) {
    receiver = text(w, receiverRaw, at(path, "receiver"));
    if (receiver !== null && (points(receiver) < 1 || points(receiver) > 200)) {
      w.add(at(path, "receiver"), "Use 1 to 200 characters.");
      receiver = null;
    }
  }
  const labels: Obj = {};
  if (hasOwn(obj, "labels")) {
    const lp = at(path, "labels");
    const items = object(w, obj.labels, lp);
    if (items !== null) {
      const keys = Object.keys(items).sort(compareCodePoints);
      if (keys.length > MAX_CHANNEL_LABELS) w.add(lp, "At most 10 labels.");
      for (const key of keys) {
        if (!LABEL.test(key)) {
          w.add(at(lp, key), "Use a label name: letters, digits and _, not starting with a digit.");
          continue;
        }
        labels[key] = longText(w, items[key], at(lp, key), 200, "Use at most 200 characters.");
      }
    }
  }
  unknownKeys(w, obj, path, ["receiver", "labels"]);
  return { receiver, labels };
}

function alertNotify(w: Walk, raw: unknown, path: string): string[] {
  const items = list(w, raw, path);
  if (items === null) return [];
  if (items.length > MAX_NOTIFY) w.add(path, "At most 10 contact points.");
  const out: string[] = [];
  items.forEach((item, i) => {
    const p = at(path, i);
    const t = text(w, item, p);
    if (t === null) return;
    if (!CONTACT_ID.test(t)) w.add(p, "Use a contact point id.");
    else if (out.includes(t)) w.add(p, "Each contact point only once.");
    else out.push(t);
  });
  return out;
}

function alertDuration(w: Walk, raw: unknown, path: string): string | null {
  const t = text(w, raw, path);
  if (t === null) return null;
  const seconds = parseDuration(t) ?? -1;
  if (!(seconds >= 0 && seconds <= MAX_FOR_SECONDS)) {
    w.add(path, "Use a duration from 0s to 24h, like 5m.");
    return null;
  }
  return t;
}

function alert(
  w: Walk,
  raw: unknown,
  path: string,
  kind: PanelType | null,
  qs: unknown[],
  variables: unknown[],
): unknown {
  if (kind !== null && !ALERT_PANEL_TYPES.includes(kind)) {
    w.add(path, `A ${kind} panel can't have an alert. Use a time series, stat, gauge or bar panel.`);
    return null;
  }
  const obj = object(w, raw, path);
  if (obj === null) return null;
  const nameRaw = required(w, obj, path, "name");
  const name =
    nameRaw === MISSING
      ? null
      : shortText(w, nameRaw, at(path, "name"), 1, "Use 1 to 120 characters, without line breaks.");
  const everyRaw = hasOwn(obj, "every") ? obj.every : "1m";
  const every =
    typeof everyRaw === "string" && Object.hasOwn(EVERY_SECONDS, everyRaw)
      ? EVERY_SECONDS[everyRaw]
      : 60;
  const queryRaw = required(w, obj, path, "query");
  const query =
    queryRaw === MISSING ? null : alertQuery(w, queryRaw, at(path, "query"), qs, variables, every);
  const of = optEnum(w, obj, path, "of", ["each", "total"] as const);
  const opRaw = required(w, obj, path, "op");
  const op = opRaw === MISSING ? null : enumOf(w, opRaw, at(path, "op"), ["above", "below"] as const);
  const thresholdRaw = required(w, obj, path, "threshold");
  const threshold = thresholdRaw === MISSING ? null : number(w, thresholdRaw, at(path, "threshold"));
  const forText = hasOwn(obj, "for") ? alertDuration(w, obj.for, at(path, "for")) : "5m";
  const everyText = hasOwn(obj, "every")
    ? enumOf(w, obj.every, at(path, "every"), ["30s", "1m", "5m"] as const, "Use 30s, 1m or 5m.")
    : "1m";
  const severity = hasOwn(obj, "severity")
    ? enumOf(w, obj.severity, at(path, "severity"), SEVERITIES)
    : "warning";
  const message = hasOwn(obj, "message")
    ? longText(w, obj.message, at(path, "message"), 500, "Use at most 500 characters.")
    : "";
  const notify = hasOwn(obj, "notify") ? alertNotify(w, obj.notify, at(path, "notify")) : [];
  const engine = optEnum(w, obj, path, "engine", ["omnikrux", "tool"] as const);
  const channel = hasOwn(obj, "channel")
    ? alertChannel(w, obj.channel, at(path, "channel"), engine)
    : null;
  unknownKeys(w, obj, path, [
    "name",
    "query",
    "of",
    "op",
    "threshold",
    "for",
    "every",
    "severity",
    "message",
    "notify",
    "engine",
    "channel",
  ]);
  return {
    name,
    query,
    of,
    op,
    threshold,
    for: forText,
    every: everyText,
    severity,
    message,
    notify,
    engine,
    channel,
  };
}

function panel(
  w: Walk,
  raw: unknown,
  path: string,
  ids: Set<string>,
  placed: Placed[],
  defined: Map<string, number>,
  variables: unknown[],
): unknown {
  const obj = object(w, raw, path);
  if (obj === null) return null;
  const idRaw = required(w, obj, path, "id");
  const shownId = typeof idRaw === "string" ? idRaw : "";
  let id: string | null = null;
  if (idRaw !== MISSING) {
    id = text(w, idRaw, at(path, "id"));
    if (id !== null) {
      if (!PANEL_ID.test(id)) {
        w.add(at(path, "id"), ID_COPY);
        id = null;
      } else if (ids.has(id)) {
        w.add(at(path, "id"), `Another panel already has the id "${id}".`);
      } else {
        ids.add(id);
      }
    }
  }
  const typeRaw = required(w, obj, path, "type");
  let kind: PanelType | null = null;
  if (typeRaw !== MISSING) {
    kind = enumOf(
      w,
      typeRaw,
      at(path, "type"),
      PANEL_TYPES,
      `Use one of: ${PANEL_TYPES.join(", ")}.`,
    );
  }
  const titleRaw = required(w, obj, path, "title");
  const title =
    titleRaw === MISSING
      ? null
      : shortText(w, titleRaw, at(path, "title"), 0, "Use at most 120 characters, without line breaks.");
  const description = hasOwn(obj, "description")
    ? longText(w, obj.description, at(path, "description"), 2000, "Use at most 2000 characters.")
    : "";
  const layoutRaw = required(w, obj, path, "layout");
  const lay = layoutRaw === MISSING ? null : layout(w, layoutRaw, at(path, "layout"), placed, shownId);
  const queriesRaw = required(w, obj, path, "queries");
  const qs = queriesRaw === MISSING ? [] : queries(w, queriesRaw, at(path, "queries"), kind, defined);
  let opts: Obj;
  if (kind === null) {
    opts = {}; // without a valid type there is nothing to check the options against
  } else if (hasOwn(obj, "options")) {
    opts = options(w, obj.options, at(path, "options"), kind);
  } else {
    opts = options(w, {}, at(path, "options"), kind);
  }
  const alertSpec =
    hasOwn(obj, "alert") && obj.alert !== null
      ? alert(w, obj.alert, at(path, "alert"), kind, qs, variables)
      : null;
  unknownKeys(w, obj, path, [
    "id",
    "type",
    "title",
    "description",
    "layout",
    "queries",
    "options",
    "alert",
  ]);
  return {
    id,
    type: kind,
    title,
    description,
    layout: lay,
    queries: qs,
    options: opts,
    alert: alertSpec,
  };
}

// --- the document -------------------------------------------------------------------------

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

function documentBytes(raw: unknown): number {
  try {
    const s = JSON.stringify(raw);
    return s === undefined ? 0 : byteLength(s);
  } catch {
    return 0;
  }
}

// parseDashboardJson skips parsing text above this, so a huge paste is never walked.
const MAX_TEXT_BYTES = 4_000_000;

const TOO_BIG: Problem = { path: "", message: "The dashboard is larger than 1 MB." };

export function validateDashboard(value: unknown, ownerKind: OwnerKind): Validation {
  if (documentBytes(value) > MAX_DOCUMENT_BYTES) return { ok: false, problems: [{ ...TOO_BIG }] };
  const w = new Walk(ownerKind);
  const doc = documentOf(w, value);
  if (w.problems.length) return { ok: false, problems: w.problems };
  return { ok: true, spec: doc as unknown as DashboardSpec };
}

function documentOf(w: Walk, raw: unknown): Obj {
  const obj = object(w, raw, "");
  if (obj === null) return {};
  const version = required(w, obj, "", "schemaVersion");
  if (version !== MISSING && !(typeof version === "number" && version === SCHEMA_VERSION)) {
    w.add("schemaVersion", "This OmniKrux reads dashboards with schemaVersion 1.");
  }
  const titleRaw = required(w, obj, "", "title");
  const title =
    titleRaw === MISSING
      ? null
      : shortText(w, titleRaw, "title", 1, "Use 1 to 120 characters, without line breaks.");
  const description = hasOwn(obj, "description")
    ? longText(w, obj.description, "description", 2000, "Use at most 2000 characters.")
    : "";
  const timeSpec = time(w, field(obj, "time"), "time");
  let refresh: unknown = null;
  if (hasOwn(obj, "refresh")) {
    refresh = obj.refresh;
    if (!(REFRESH_CHOICES as readonly unknown[]).includes(refresh)) {
      w.add("refresh", "Use null or one of 10s, 30s, 1m, 5m, 15m, 1h.");
      refresh = null;
    }
  }

  const defined = new Map<string, number>();
  let varItems: unknown[] = [];
  if (hasOwn(obj, "variables")) {
    const items = list(w, obj.variables, "variables");
    if (items !== null) varItems = items;
  }
  varItems.forEach((item, i) => {
    if (isObject(item) && typeof item.name === "string" && !defined.has(item.name)) {
      defined.set(item.name, i);
    }
  });
  if (varItems.length > MAX_VARIABLES) w.add("variables", "A dashboard has at most 20 variables.");
  const seen = new Set<string>();
  const variables = varItems.map((item, i) => variable(w, item, at("variables", i), i, seen, defined));

  let panelItems: unknown[] = [];
  if (hasOwn(obj, "panels")) {
    const items = list(w, obj.panels, "panels");
    if (items !== null) panelItems = items;
  }
  if (panelItems.length > MAX_PANELS) w.add("panels", "A dashboard has at most 100 panels.");
  const ids = new Set<string>();
  const placed: Placed[] = [];
  const panels = panelItems.map((item, i) => panel(w, item, at("panels", i), ids, placed, defined, variables));
  unknownKeys(w, obj, "", [
    "schemaVersion",
    "title",
    "description",
    "time",
    "refresh",
    "variables",
    "panels",
  ]);
  return {
    schemaVersion: SCHEMA_VERSION,
    title,
    description,
    time: timeSpec,
    refresh,
    variables,
    panels,
  };
}

/**
 * Validate text from an editor. Indented text is larger than the compact document the server
 * measures, so only text above 4 MB is refused here; the 1 MB rule is `validateDashboard`'s.
 */
export function parseDashboardJson(text: string, ownerKind: OwnerKind): Validation {
  if (byteLength(text) > MAX_TEXT_BYTES) return { ok: false, problems: [{ ...TOO_BIG }] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, problems: [{ path: "", message: `Not valid JSON: ${message}` }] };
  }
  return validateDashboard(value, ownerKind);
}

// --- building documents -------------------------------------------------------------------

export function defaultOptions(type: PanelType): PanelSpec["options"] {
  const common = { unit: "none" as const, decimals: null, thresholds: [] as Threshold[] };
  switch (type) {
    case "timeseries":
      return { ...common, min: null, max: null, legend: "bottom", style: "lines" };
    case "stat":
      return { ...common, calc: "last", sparkline: true };
    case "gauge":
      return { ...common, min: 0, max: null, calc: "last" };
    case "bar":
      return { ...common, min: null, legend: "bottom", orientation: "horizontal" };
    case "table":
      return { ...common, columns: [], sort: null };
    case "logs":
      return { limit: 100, wrap: true, order: "newest" };
  }
}

/** A new alert for a panel: named for the panel, on its first visible query, above `threshold`. */
export function newAlert(panel: PanelSpec, threshold: number): PanelAlert {
  const query = panel.queries.find((q) => !q.hidden) ?? panel.queries[0];
  return {
    name: panel.title.trim() === "" ? "New alert" : panel.title,
    query: query?.ref ?? "A",
    of: "each",
    op: "above",
    threshold,
    for: "5m",
    every: "1m",
    severity: "warning",
    message: "",
    notify: [],
    engine: "omnikrux",
    channel: null,
  };
}

/** A new panel is a draft: its empty `expr` is reported by `validateDashboard` until filled. */
export function newPanel(type: PanelType, id: string, layoutOf: Layout): PanelSpec {
  return {
    id,
    type,
    title: "New panel",
    description: "",
    layout: { ...layoutOf },
    queries: [
      {
        ref: "A",
        source: { type: type === "logs" ? "loki" : "prometheus", id: null },
        expr: "",
        legend: "",
        hidden: false,
      },
    ],
    options: defaultOptions(type),
    alert: null,
  } as PanelSpec;
}

export function nextPanelId(spec: DashboardSpec): string {
  const used = new Set(spec.panels.map((p) => p.id));
  let n = 1;
  while (used.has(`p-${n}`)) n++;
  return `p-${n}`;
}

export function emptyDashboard(title: string): DashboardSpec {
  return {
    schemaVersion: SCHEMA_VERSION,
    title: pyStrip(title),
    description: "",
    time: { from: "now-6h", to: "now" },
    refresh: null,
    variables: [],
    panels: [],
  };
}

export function dashboardJson(spec: DashboardSpec): string {
  return JSON.stringify(spec, null, 2);
}
