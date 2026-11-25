// Explore's trail of past queries, per project, in browser storage. Every access is guarded:
// blocked or damaged storage only loses the trail, never breaks the page. A query is kept once: two
// texts that differ only in spacing outside quotes are the same entry, whatever source they ran on,
// and the newest keeps its source.

export const TRAIL_PREFIX = "omnikrux.monitoring.explore.trail.";
export const TRAIL_MAX = 20;
export const TRAIL_SHOWN = 8;
/** The longest text kept, as the tab's view keeps it. */
const MAX_TEXT = 10000;

export type TrailEntry = { expr: string; sourceId: string; at: number };

const entry = (x: unknown): x is TrailEntry => {
  if (x === null || typeof x !== "object") return false;
  const { expr, sourceId, at } = x as Record<string, unknown>;
  return typeof expr === "string" && expr.length > 0 && expr.length <= MAX_TEXT
    && typeof sourceId === "string" && sourceId.length > 0
    && typeof at === "number" && Number.isFinite(at);
};

/** The text a query is compared by: trimmed, each run of spaces outside quotes one space. */
export function normalizeQuery(expr: string): string {
  const text = expr.trim();
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      out += c;
      if (quote !== "`" && c === "\\" && i + 1 < text.length) out += text[++i];
      else if (c === quote) quote = null;
    } else if (/\s/.test(c)) {
      if (!out.endsWith(" ")) out += " ";
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
    }
  }
  return out;
}

/** Keeps the last of each query, in order: the newest copy (and its source) wins. */
function once(entries: TrailEntry[]): TrailEntry[] {
  const seen = new Set<string>();
  const kept: TrailEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const key = normalizeQuery(entries[i].expr);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entries[i]);
  }
  return kept.reverse();
}

/** The project's trail, oldest first, each query once, at most twenty. Blocked or damaged storage is `[]`. */
export function readTrail(projectId: string): TrailEntry[] {
  try {
    const raw = localStorage.getItem(TRAIL_PREFIX + projectId);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return once(data.filter(entry).map(({ expr, sourceId, at }) => ({ expr, sourceId, at }))).slice(-TRAIL_MAX);
  } catch {
    return [];
  }
}

/** Adds an entry at the end (an equal query, on any source, moves there as this one); the trail as it now is. */
export function pushTrail(projectId: string, item: TrailEntry): TrailEntry[] {
  const key = normalizeQuery(item.expr);
  const next = [...readTrail(projectId).filter((e) => normalizeQuery(e.expr) !== key), { ...item }].slice(-TRAIL_MAX);
  try {
    localStorage.setItem(TRAIL_PREFIX + projectId, JSON.stringify(next));
  } catch {
    // storage is blocked or full: the trail lasts as long as the page
  }
  return next;
}

export function clearTrail(projectId: string): void {
  try {
    localStorage.removeItem(TRAIL_PREFIX + projectId);
  } catch {
    // storage is blocked: nothing was kept
  }
}
