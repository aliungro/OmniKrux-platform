// Times of silences and deliveries in a few words: `14:05` for today, `3 Dec 14:05` for another day.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const two = (n: number) => String(n).padStart(2, "0");

/** `HH:MM` when `iso` is today (local time), else `D Mon HH:MM`; "" for a time that can't be read. */
export function whenShort(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? clock : `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock}`;
}

/** The matchers of a silence one by one: commas inside a quoted value don't split. */
export function splitMatchers(text: string): string[] {
  let body = text.trim();
  if (body.startsWith("{") && body.endsWith("}")) body = body.slice(1, -1);
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "\\" && quoted) {
      current += c + (body[i + 1] ?? "");
      i += 1;
    } else if (c === '"') {
      quoted = !quoted;
      current += c;
    } else if (c === "," && !quoted) {
      parts.push(current.trim());
      current = "";
    } else current += c;
  }
  parts.push(current.trim());
  return parts.filter((p) => p !== "");
}
