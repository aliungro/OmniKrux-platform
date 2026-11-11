import { useSyncExternalStore } from "react";
import { isKindKey } from "../../route";
import { storageProblem } from "../shell/storage";

export const DEFAULT_PINNED: readonly string[] = [
  "pods", "deployments.apps", "statefulsets.apps", "daemonsets.apps", "jobs.batch",
  "services", "ingresses.networking.k8s.io", "secrets", "nodes", "events", "helm-releases",
];
export const PINNED_KEY = "omnikrux.pinnedKinds";
const MAX_PINNED = 40;

type Loaded = { pinned: string[]; loadProblem: string | null };
function fallback(reason: string): Loaded {
  return { pinned: [...DEFAULT_PINNED], loadProblem: `Your saved pinned kinds couldn't be read (${reason}), so Omnikrux restored the default pinned kinds.` };
}
function readPinned(storage: Storage | null): Loaded {
  try {
    const raw = storage?.getItem(PINNED_KEY);
    if (raw == null) return { pinned: [...DEFAULT_PINNED], loadProblem: null };
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return fallback("they aren't valid JSON"); }
    if (value === null || typeof value !== "object") return fallback("the saved list isn't valid");
    if (!("version" in value) || value.version !== 1) return fallback("they're from another version of Omnikrux");
    if (!("kinds" in value) || !Array.isArray(value.kinds)) return fallback("the saved list isn't valid");
    if (!value.kinds.every((k: unknown) => typeof k === "string" && isKindKey(k))) return fallback("the saved list contains an invalid kind");
    return { pinned: [...new Set<string>(value.kinds)].slice(0, MAX_PINNED), loadProblem: null };
  } catch (error) { return fallback(storageProblem(error)); }
}
export function loadPinned(storage: Storage | null): string[] { return readPinned(storage).pinned; }

export function savePinned(storage: Storage | null, kinds: readonly string[]): string | null {
  try { storage?.setItem(PINNED_KEY, JSON.stringify({ version: 1, kinds })); return null; }
  catch (error) { return storageProblem(error); }
}

type Snapshot = { pinned: readonly string[]; saveProblem: string | null; loadProblem: string | null };
let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();
function getSnapshot(): Snapshot {
  if (snapshot === null) {
    let loaded: Loaded;
    try { loaded = readPinned(window.localStorage); } catch (error) { loaded = fallback(storageProblem(error)); }
    snapshot = { ...loaded, saveProblem: null };
  }
  return snapshot;
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function update(pinned: readonly string[]) {
  let saveProblem: string | null;
  try { saveProblem = savePinned(window.localStorage, pinned); } catch (error) { saveProblem = storageProblem(error); }
  snapshot = { ...getSnapshot(), pinned, saveProblem };
  listeners.forEach(listener => listener());
}
const pin = (key: string) => {
  const { pinned } = getSnapshot();
  if (isKindKey(key) && !pinned.includes(key) && pinned.length < MAX_PINNED) update([...pinned, key]);
};
const unpin = (key: string) => {
  const { pinned } = getSnapshot();
  if (pinned.includes(key)) update(pinned.filter(k => k !== key));
};
const move = (key: string, by: -1 | 1) => {
  const pinned = [...getSnapshot().pinned], at = pinned.indexOf(key), to = at + by;
  if (at < 0 || to < 0 || to >= pinned.length) return;
  [pinned[at], pinned[to]] = [pinned[to], pinned[at]];
  update(pinned);
};
const reorder = (key: string, target: string, placement: "before" | "after"): void => {
  const { pinned } = getSnapshot();
  const from = pinned.indexOf(key);
  if (from < 0 || key === target) return;
  const next = pinned.filter(pin => pin !== key);
  const targetIndex = next.indexOf(target);
  if (targetIndex < 0) return;
  const to = targetIndex + (placement === "after" ? 1 : 0);
  if (to === from) return;
  next.splice(to, 0, key);
  update(next);
};
const reset = () => update([...DEFAULT_PINNED]);
const dismissLoadProblem = () => {
  snapshot = { ...getSnapshot(), loadProblem: null };
  listeners.forEach(listener => listener());
};

export function usePinnedKinds() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...state, pin, unpin, move, reorder, reset, dismissLoadProblem };
}

/** Clears the browser-backed snapshot between test cases or a simulated page reload. */
export function resetPinnedKinds() { snapshot = null; }
