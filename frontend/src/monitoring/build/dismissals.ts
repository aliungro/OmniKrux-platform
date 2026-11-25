export const DISMISSED_KEY = "omnikrux.monitoring.recommendations.dismissed";
const MAX_DISMISSED = 500;

/** Kept when storage is blocked, so a dismissal still holds until the page is closed. */
let memory: string[] = [];

function load(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (raw === null) return memory;
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return memory;
    return data.filter((x): x is string => typeof x === "string");
  } catch {
    return memory;
  }
}

/** The keys dismissed in this scope (a dashboard id, or `explore:{project id}`). */
export function readDismissed(scope: string): Set<string> {
  const prefix = `${scope}|`;
  const out = new Set<string>();
  for (const entry of load()) if (entry.startsWith(prefix)) out.add(entry.slice(prefix.length));
  return out;
}

export function dismiss(scope: string, key: string): void {
  const entry = `${scope}|${key}`;
  const next = [...load().filter((e) => e !== entry), entry].slice(-MAX_DISMISSED);
  memory = next;
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // storage is blocked: the dismissal lives in memory
  }
}
