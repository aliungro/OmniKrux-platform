// Min/max decimation: per pixel column the first, lowest, highest and last point, in time order, so a
// spike never disappears and a long series never costs more than four points per column.

type Point = [number, number | null];

export function decimate(points: Point[], start: number, end: number, columns: number): Point[] {
  const n = points.length;
  const span = end - start;
  if (n === 0 || !(span > 0) || columns < 1 || n <= 2) return points.slice();
  const scale = columns / span;
  const out: Point[] = [];
  let col = -1;
  let first = -1;
  let lo = -1;
  let hi = -1;
  let last = -1;

  // Emit the column's kept points in index order, without repeats.
  const flush = () => {
    if (first < 0) return;
    let a = first;
    let b = lo;
    let c = hi;
    let d = last;
    // Sort the four indices (tiny network), then skip repeats.
    if (a > b) [a, b] = [b, a];
    if (c > d) [c, d] = [d, c];
    if (a > c) [a, c] = [c, a];
    if (b > d) [b, d] = [d, b];
    if (b > c) [b, c] = [c, b];
    out.push(points[a]);
    if (b !== a) out.push(points[b]);
    if (c !== b) out.push(points[c]);
    if (d !== c) out.push(points[d]);
    first = -1;
  };

  for (let i = 0; i < n; i++) {
    const p = points[i];
    const t = p[0];
    if (t < start || t > end) continue;
    const v = p[1];
    if (v === null) {
      flush();
      col = -1;
      out.push(p); // a gap marker stays between the columns' points
      continue;
    }
    let c = Math.floor((t - start) * scale);
    if (c >= columns) c = columns - 1;
    if (c !== col) {
      flush();
      col = c;
      first = lo = hi = last = i;
      continue;
    }
    last = i;
    if (v < (points[lo][1] as number)) lo = i;
    if (v > (points[hi][1] as number)) hi = i;
  }
  flush();
  return out;
}
