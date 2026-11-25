export const RECENT_KEY = "omnikrux.monitoring.recent";
const MAX_RECENT = 8;

export type RecentItem = { kind: "project" | "group" | "dashboard"; id: string; at: number };

const KINDS = new Set(["project", "group", "dashboard"]);

/** The saved items, newest first, at most eight, each kind and id once. Blocked or damaged storage is `[]`. */
export function readRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    const items: RecentItem[] = [];
    for (const x of data) {
      if (x === null || typeof x !== "object") continue;
      const { kind, id, at } = x as Record<string, unknown>;
      if (typeof kind !== "string" || !KINDS.has(kind) || typeof id !== "string" || !id || typeof at !== "number" || !Number.isFinite(at)) continue;
      const key = `${kind}\n${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ kind: kind as RecentItem["kind"], id, at });
    }
    return items.sort((a, b) => b.at - a.at).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function recordRecent(item: Omit<RecentItem, "at">, now = Date.now()): void {
  try {
    const rest = readRecent().filter((r) => !(r.kind === item.kind && r.id === item.id));
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ ...item, at: now }, ...rest].slice(0, MAX_RECENT)));
  } catch {
    // storage is blocked: nothing is remembered
  }
}
