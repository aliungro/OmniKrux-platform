// Motion: durations from the design, an easing, a tween on requestAnimationFrame and the
// reduced-motion preference. Reduced motion always jumps.

export { FLASH_MS, usePrefersReducedMotion } from "../dashboards/motion";

export const MORPH_MS = 380;
export const COUNT_MS = 380;

export function easeOutCubic(k: number): number {
  const r = 1 - k;
  return 1 - r * r * r;
}

/** Calls `onFrame(k)` with k from 0 to 1 over the duration (the last call is exactly 1). Returns cancel. */
export function tween(durationMs: number, onFrame: (k: number) => void): () => void {
  let id = 0;
  let stopped = false;
  let t0 = -1;
  const step = (now: number) => {
    if (stopped) return;
    if (t0 < 0) t0 = now;
    const k = durationMs <= 0 ? 1 : Math.min(1, Math.max(0, (now - t0) / durationMs));
    onFrame(k);
    if (k < 1) id = requestAnimationFrame(step);
  };
  id = requestAnimationFrame(step);
  return () => {
    stopped = true;
    cancelAnimationFrame(id);
  };
}

/** `from` to `to` at k; a column that is `NaN` (a gap) in either jumps to the target. */
export function mixColumns(from: Float32Array, to: Float32Array, k: number, out?: Float32Array): Float32Array {
  const n = to.length;
  const result = out && out.length === n ? out : new Float32Array(n);
  if (from.length !== n) {
    result.set(to);
    return result;
  }
  for (let i = 0; i < n; i++) {
    const a = from[i];
    const b = to[i];
    result[i] = a !== a || b !== b ? b : a + (b - a) * k;
  }
  return result;
}
