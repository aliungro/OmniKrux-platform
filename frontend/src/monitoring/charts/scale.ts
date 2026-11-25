// Axis maths: round y ticks, clock-aligned x ticks (local time, seconds since the epoch), and labels.

const FLOAT_NOISE = 12;
const clean = (n: number) => Number(n.toPrecision(FLOAT_NOISE));

/** A step of 1, 2, 5 or 10 times a power of ten near `raw`. */
function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const f = raw / 10 ** exp;
  const nice = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return nice * 10 ** exp;
}

/** Ticks that cover `[min, max]` on round numbers, about `count` of them. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max < min) [min, max] = [max, min];
  if (max === min) {
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1;
    min -= pad;
    max += pad;
  }
  // A range that can't be stepped (empty after padding, overflowing, or a step that underflows) gets two ticks.
  const two = (): number[] => (max > min ? [min, max] : [min, min + 1]);
  const range = max - min;
  if (!Number.isFinite(range) || !(range > 0)) return two();
  const raw = range / Math.max(1, count - 1);
  const step = raw > 0 ? niceStep(raw) : 0;
  if (!(step > 0) || !Number.isFinite(step)) return two();
  const first = Math.floor(clean(min / step));
  const last = Math.ceil(clean(max / step));
  if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 1000 || !Number.isFinite(Math.max(Math.abs(first), Math.abs(last)) * step)) return two();
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(clean(i * step));
  return out;
}

const INTERVALS = [60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400];
const DAY = 86400;

/** Ticks inside `[start, end]` on clock marks (1, 5, 15, 30 min, 1, 3, 6, 12 h, 1 d, then whole days). */
export function timeTicks(start: number, end: number, count: number): number[] {
  const range = end - start;
  if (!(range > 0)) return [];
  let interval = INTERVALS.find((i) => range / i <= count);
  if (interval === undefined) interval = Math.ceil(range / count / DAY) * DAY;
  // Marks fall on the local clock: shift by the zone's offset (it can differ across a DST change; the start's is used).
  const offset = -new Date(start * 1000).getTimezoneOffset() * 60;
  const ticks: number[] = [];
  let t = Math.ceil((start + offset) / interval) * interval - offset;
  for (; t <= end; t += interval) ticks.push(t);
  return ticks;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** `HH:MM` under 2 days, `D Mon HH:MM` up to 7 days, `D Mon` beyond; local time. */
export function formatTimeTick(t: number, rangeSeconds: number): string {
  const d = new Date(t * 1000);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (rangeSeconds < 2 * DAY) return clock;
  if (rangeSeconds <= 7 * DAY) return `${day} ${clock}`;
  return day;
}

/** The tooltip's time: day, month and the clock with seconds. */
export function formatTooltipTime(t: number): string {
  const d = new Date(t * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
