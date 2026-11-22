// Explore's trail of past queries, per project, in browser storage. Every access is guarded:
// blocked or damaged storage only loses the trail, never breaks the page.

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

const sameEntry = (a: TrailEntry, b: TrailEntry) => a.expr === b.expr && a.sourceId === b.sourceId;

/** The project's trail, oldest first, at most twenty. Blocked or damaged storage is `[]`. */
export function readTrail(projectId: string): TrailEntry[] {
  try {
    const raw = localStorage.getItem(TRAIL_PREFIX + projectId);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(entry).map(({ expr, sourceId, at }) => ({ expr, sourceId, at })).slice(-TRAIL_MAX);
  } catch {
    return [];
  }
}

/** Adds an entry at the end (an equal text on the same source moves there); the trail as it now is. */
export function pushTrail(projectId: string, item: TrailEntry): TrailEntry[] {
  const next = [...readTrail(projectId).filter((e) => !sameEntry(e, item)), { ...item }].slice(-TRAIL_MAX);
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
