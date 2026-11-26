// Plain words to candidate panels: "errors by route" finds the 5xx rate split by route. The index
// tokenizes the catalog once, so a keystroke never re-splits thousands of names.
import type { OwnerCatalog } from "../catalog/merge";
import { browseMetrics } from "../catalog/metrics";
import type { BrowseMetric } from "../catalog/metrics";
import type { Candidate } from "./candidates";
import {
  LEVEL_LABELS, STATUS_LABELS, UnwritableQuery, guessUnit, humanTitle, legendFor, writeLogQuery,
  writeMetricQuery, writeVolumeQuery,
} from "./writeQuery";
import { curatedPanels } from "./suggest";

export const FINDER_MAX_RESULTS = 6;

export const STOP_WORDS: ReadonlySet<string> = new Set(
  "a an and the of in on for to with show me my all what is are how many much over last".split(" "),
);

export const SYNONYMS: readonly (readonly string[])[] = [
  ["error", "errors", "err", "fail", "failed", "failing", "failure", "failures", "5xx", "exception", "exceptions"],
  ["latency", "latencies", "duration", "slow", "response"],
  ["request", "requests", "req", "rps", "traffic", "throughput", "calls", "hits"],
  ["restart", "restarts", "restarted", "crash", "crashes", "crashloop"],
  ["cpu", "cores", "processor"],
  ["memory", "mem", "ram", "rss", "working_set"],
  ["disk", "filesystem", "fs", "storage"],
  ["network", "net", "bandwidth", "receive", "transmit", "rx", "tx"],
  ["log", "logs", "line", "lines"],
  ["up", "down", "target", "targets", "health", "healthy", "available"],
];

const ERROR_GROUP = SYNONYMS[0];
const LATENCY_GROUP = SYNONYMS[1];
const LOG_GROUP = SYNONYMS[8];
const PERCENTILES: Record<string, number> = { p50: 0.5, p90: 0.9, p95: 0.95, p99: 0.99 };
const ERROR_LINES = '|~ "(?i)(error|fatal|panic)"';

type Kind = "rate" | "errors" | "quantile" | "value" | "volume" | "lines";
const KIND_RANK: Record<Kind, number> = { rate: 0, errors: 1, quantile: 2, value: 3, volume: 4, lines: 5 };

type Entry = {
  metric: BrowseMetric | null;
  label: string;
  value: string;
  sourceId: string | null;
  labels: string[];
};

export type FinderIndex = {
  entries: Entry[];
  tokens: Map<string, number[]>;
  tokenList: string[];
  labels: Map<string, number[]>;
  help: Map<string, number[]>;
  levelLabel: string | null;
  /** The curated suggestions this catalog supports, with the words of their titles and metric names. */
  curated: { candidate: Candidate; words: string[] }[];
};

const splitName = (s: string) => s.toLowerCase().split(/[_:]+/).filter(Boolean);
const push = (m: Map<string, number[]>, key: string, i: number) => {
  const list = m.get(key);
  if (list === undefined) m.set(key, [i]);
  else if (list[list.length - 1] !== i) list.push(i);
};

export function buildFinderIndex(catalog: OwnerCatalog): FinderIndex {
  const entries: Entry[] = [];
  const tokens = new Map<string, number[]>();
  const labels = new Map<string, number[]>();
  const help = new Map<string, number[]>();
  for (const m of browseMetrics(catalog)) {
    const i = entries.length;
    entries.push({ metric: m, label: "", value: "", sourceId: m.sourceId, labels: m.labels });
    for (const t of splitName(m.name)) push(tokens, t, i);
    for (const l of m.labels) push(labels, l.toLowerCase(), i);
    if (m.help) for (const w of m.help.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) if (w) push(help, w, i);
  }
  for (const s of catalog.streams) {
    for (const v of s.values) {
      const i = entries.length;
      entries.push({ metric: null, label: s.name, value: v, sourceId: s.sourceId, labels: [] });
      for (const t of [...splitName(s.name), ...splitName(v), s.name.toLowerCase(), v.toLowerCase()]) push(tokens, t, i);
    }
  }
  const levelLabel = LEVEL_LABELS.find((l) => catalog.streams.some((s) => s.name === l)) ?? null;
  const curated = curatedPanels(catalog).map((candidate) => ({
    candidate, words: `${candidate.title} ${candidate.subtitle}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
  }));
  return { entries, tokens, tokenList: [...tokens.keys()], labels, help, levelLabel, curated };
}

function expand(w: string): Set<string> {
  const out = new Set([w]);
  const stripped = w.length > 1 && w.endsWith("s") ? w.slice(0, -1) : null;
  if (stripped) out.add(stripped);
  for (const g of SYNONYMS) {
    if (g.includes(w) || (stripped !== null && g.includes(stripped))) for (const x of g) out.add(x);
  }
  return out;
}

type Scored = { score: number; kind: Kind; series: number; title: string; entry: Entry; split: string | null };

const statusLabel = (m: BrowseMetric): string | null => STATUS_LABELS.find((l) => m.labels.includes(l)) ?? null;

export function findPanels(index: FinderIndex, text: string, limit = FINDER_MAX_RESULTS): Candidate[] {
  const raw = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_:]+/u)
    .flatMap((w) => w.split("_"))
    .filter((w) => w !== "" && !STOP_WORDS.has(w));
  const content: string[] = [];
  let splitWord: string | null = null;
  let quantile = 0.95;
  let percentile = false;
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    if (w === "by" || w === "per") {
      if (i + 1 < raw.length) { splitWord = raw[i + 1]; i++; }
    } else if (Object.hasOwn(PERCENTILES, w)) {
      quantile = PERCENTILES[w];
      percentile = true;
    } else content.push(w);
  }
  const wants = (group: readonly string[]) => content.some((w) => [...expand(w)].some((x) => group.includes(x)));
  const errorIntent = wants(ERROR_GROUP);
  const latencyIntent = percentile || wants(LATENCY_GROUP);
  const logsIntent = wants(LOG_GROUP);
  const volumeIntent = content.includes("volume") || content.includes("count");

  const points = new Map<number, number>();
  const add = (i: number, n: number) => points.set(i, (points.get(i) ?? 0) + n);
  for (const w of content) {
    const four = new Set<number>();
    for (const x of expand(w)) for (const i of index.tokens.get(x) ?? []) four.add(i);
    for (const i of four) add(i, 4);
    if (w.length >= 3) {
      const two = new Set<number>();
      for (const tok of index.tokenList) {
        if (!tok.startsWith(w)) continue;
        for (const i of index.tokens.get(tok)!) if (!four.has(i)) two.add(i);
      }
      for (const i of two) add(i, 2);
    }
    for (const i of index.labels.get(w) ?? []) add(i, 2);
    for (const i of index.help.get(w) ?? []) add(i, 1);
  }
  const withSplit = new Set<number>(splitWord === null ? [] : (index.labels.get(splitWord) ?? []));
  for (const i of withSplit) add(i, 4);

  // Curated suggestions come first when every typed word is in their title or metric name. A split
  // or a percentile asks for something the curated ones don't say, so they stay out of those.
  const out: Candidate[] = [];
  const seen = new Set<string>();
  if (splitWord === null && !percentile && content.length > 0) {
    const has = (words: string[], w: string) => {
      const plain = w.length > 1 && w.endsWith("s") ? w.slice(0, -1) : w;
      return words.some((t) => t === w || t === plain || (w.length >= 3 && t.startsWith(w)));
    };
    for (const { candidate, words } of index.curated) {
      if (out.length >= limit) break;
      if (content.every((w) => has(words, w)) && !seen.has(candidate.expr)) {
        seen.add(candidate.expr);
        out.push(candidate);
      }
    }
  }

  const scored: Scored[] = [];
  for (const [i, p] of points) {
    if (p <= 0) continue; // no content points: intent bonuses alone never qualify
    const e = index.entries[i];
    const base = p - (splitWord !== null && !withSplit.has(i) ? 3 : 0);
    const split = withSplit.has(i) ? (e.labels.find((l) => l.toLowerCase() === splitWord) ?? null) : null;
    const by = split === null ? "" : ` by ${split}`;
    const put = (kind: Kind, bonus: number, title: string) =>
      scored.push({ score: base + bonus, kind, series: e.metric?.series ?? 0, title, entry: e, split });
    const m = e.metric;
    if (m) {
      const t = humanTitle(m.name);
      if (m.kind === "counter") {
        put("rate", 0, `${t} per second${by}`);
        if (errorIntent && statusLabel(m) !== null) put("errors", 3, `${t} errors per second${by}`);
      } else if (m.kind === "histogram") {
        const timing = /duration|latency|seconds/.test(m.name);
        put("quantile", latencyIntent && timing ? 3 : 0, `p${Math.round(quantile * 100)} ${t}${by}`);
      } else put("value", 0, `${t}${by}`);
    } else {
      const lv = `${e.label}=${e.value}`;
      put("lines", logsIntent ? 3 : 0, `Logs from ${lv}`);
      put("volume", (logsIntent ? 1 : 0) + (volumeIntent ? 3 : 0), `Log volume of ${lv}`);
      if (errorIntent) put("errors", 3, `Error lines from ${lv}`);
    }
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      b.series - a.series ||
      (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
  );
  for (const s of scored) {
    if (out.length >= limit) break;
    let c: Candidate;
    try {
      c = write(index, s, quantile);
      if (c.panelType !== "logs") c = { ...c, legend: legendFor(c.expr, c.title) };
    } catch (err) {
      if (err instanceof UnwritableQuery) continue; // never offer a query that can't be written
      throw err;
    }
    if (seen.has(c.expr)) continue;
    seen.add(c.expr);
    out.push(c);
  }
  return out;
}

function write(index: FinderIndex, s: Scored, quantile: number): Candidate {
  const e = s.entry;
  const m = e.metric;
  if (m) {
    // Plain CPU seconds by mode add up to the core count: the curated busy share says it right.
    if (m.name === "node_cpu_seconds_total") {
      const busy = index.curated.find((x) => x.candidate.key === "nodeCpu");
      if (!busy) throw new UnwritableQuery("Node CPU can't be written without its mode label.");
      return busy.candidate;
    }
    const from = {
      sourceType: "prometheus" as const,
      sourceId: m.sourceId,
      legend: s.split === null ? "" : `{{${s.split}}}`,
      panelType: "timeseries" as const,
      unit: guessUnit(m),
    };
    const subtitle = `${m.name} · ${m.typeLabel}`;
    if (s.kind === "errors") {
      const t = statusLabel(m)!;
      const expr = writeMetricQuery(m, s.split, {}, 0.95, [{ label: t, op: "=~", value: "5.." }]);
      return { key: `errors:${m.name}`, title: s.title, subtitle: `${subtitle} · ${t}=~"5.."`, expr, ...from };
    }
    const expr = writeMetricQuery(m, s.split, {}, quantile);
    return { key: `${s.kind}:${m.name}`, title: s.title, subtitle, expr, ...from };
  }
  const base = { sourceType: "loki" as const, sourceId: e.sourceId, legend: "" };
  const subtitle = `Loki · ${e.label}=${e.value}`;
  const key = `${s.kind}:${e.label}=${e.value}`;
  const sel = writeLogQuery({ [e.label]: e.value }, []);
  if (s.kind === "lines") return { key, title: s.title, subtitle, panelType: "logs", expr: sel, unit: "none", ...base };
  if (s.kind === "errors") {
    return { key, title: s.title, subtitle, panelType: "logs", expr: `${sel} ${ERROR_LINES}`, unit: "none", ...base };
  }
  const level = index.levelLabel !== e.label ? index.levelLabel : null;
  return {
    key, title: s.title, subtitle, panelType: "timeseries", expr: writeVolumeQuery(sel, level), unit: "short", ...base,
  };
}
