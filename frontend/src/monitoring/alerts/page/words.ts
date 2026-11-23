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

/** An instance's labels in a few words: `namespace/pod` when it has both, else its first two. */
export function labelsText(labels: Record<string, string> | null | undefined): string {
  if (!labels) return "";
  if (labels.namespace && labels.pod) return `${labels.namespace}/${labels.pod}`;
  return Object.keys(labels)
    .filter((k) => k !== "alertname")
    .slice(0, 2)
    .map((k) => `${k}=${labels[k]}`)
    .join(", ");
}

/** Seconds since `iso`, never below zero. */
export function secondsSince(iso: string, now: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : 0;
}
