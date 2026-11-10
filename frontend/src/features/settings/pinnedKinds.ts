import { useSyncExternalStore } from "react";
import { isKindKey } from "../../route";
import { storageProblem } from "../shell/storage";

export const DEFAULT_PINNED: readonly string[] = [
  "pods", "deployments.apps", "statefulsets.apps", "daemonsets.apps", "jobs.batch",
  "services", "ingresses.networking.k8s.io", "secrets", "nodes", "events", "helm-releases",
];
export const PINNED_KEY = "omnikrux.pinnedKinds";
const MAX_PINNED = 40;

export function loadPinned(storage: Storage | null): string[] {
  try {
    const raw = storage?.getItem(PINNED_KEY);
    if (raw == null) return [...DEFAULT_PINNED];
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
      !("kinds" in value) || !Array.isArray(value.kinds) ||
      !value.kinds.every((k: unknown) => typeof k === "string" && isKindKey(k))) return [...DEFAULT_PINNED];
    return [...new Set<string>(value.kinds)].slice(0, MAX_PINNED);
  } catch { return [...DEFAULT_PINNED]; }
}

export function savePinned(storage: Storage | null, kinds: readonly string[]): string | null {
  try { storage?.setItem(PINNED_KEY, JSON.stringify({ version: 1, kinds })); return null; }
  catch (error) { return storageProblem(error); }
}

type Snapshot = { pinned: readonly string[]; saveProblem: string | null };
let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();
function getSnapshot(): Snapshot {
  if (snapshot === null) {
    let pinned: string[];
    try { pinned = loadPinned(window.localStorage); } catch { pinned = [...DEFAULT_PINNED]; }
    snapshot = { pinned, saveProblem: null };
  }
  return snapshot;
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function update(pinned: readonly string[]) {
  let saveProblem: string | null;
  try { saveProblem = savePinned(window.localStorage, pinned); } catch (error) { saveProblem = storageProblem(error); }
  snapshot = { pinned, saveProblem };
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
const reset = () => update([...DEFAULT_PINNED]);

export function usePinnedKinds() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...state, pin, unpin, move, reset };
}

/** Clears the browser-backed snapshot between test cases or a simulated page reload. */
export function resetPinnedKinds() { snapshot = null; }
