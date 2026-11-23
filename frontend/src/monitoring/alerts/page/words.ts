// Small word helpers of the Alerts page: clock times and an instance's labels.

const two = (n: number) => String(n).padStart(2, "0");

/** `HH:MM:SS` in local time; "" for a time that can't be read. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** `HH:MM` in local time; "" for a time that can't be read. */
export function hourMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Labels OmniKrux or the rule set itself, never the series': its name, severity, rule and project. */
const ownLabel = (key: string) => key === "alertname" || key === "severity" || key.startsWith("omnikrux_");

/** An instance's labels in a few words: `namespace/pod` when it has both, else its first two
 * series labels (never the ones OmniKrux sets, such as the rule's id). */
export function labelsText(labels: Record<string, string> | null | undefined): string {
  if (!labels) return "";
  if (labels.namespace && labels.pod) return `${labels.namespace}/${labels.pod}`;
  return Object.keys(labels)
    .filter((k) => !ownLabel(k))
    .slice(0, 2)
    .map((k) => `${k}=${labels[k]}`)
    .join(", ");
}

/** How many firing alerts a silence mutes, as a state line's tail: "silenced" when all of them,
 * "{n} of {m} silenced" when some, "" when none. They still fire; only the notifications stop. */
export function silencedWords(instances: readonly { state: string; silenced: boolean }[]): string {
  const firing = instances.filter((i) => i.state === "firing");
  const n = firing.filter((i) => i.silenced).length;
  if (n === 0) return "";
  return n === firing.length ? "silenced" : `${n} of ${firing.length} silenced`;
}

/** Seconds since `iso`, never below zero. */
export function secondsSince(iso: string, now: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : 0;
}

/** The engine note's state after a refresh that failed: the last good read (`at`, ms). */
export const staleStateWords = (at: number) => `Couldn't refresh: showing the state from ${clockTime(new Date(at).toISOString())}.`;

/** A refresh that failed: what is shown is the last good read (`at`, ms), and says when that was. */
export const staleWords = (at: number) => `Couldn't refresh: showing the list from ${clockTime(new Date(at).toISOString())}.`;
