// The dry run of a rule as it is being written: asked once typing stops (500 ms), and only for the
// rule as it reads now. A run for an older body is aborted when the body changes (its query loses
// its last observer, and the request carries the query's signal), and while a newer body waits for
// its run nothing older is shown as its answer.

import { useEffect, useMemo, useState } from "react";
import { useDryRun, type AlertRequestError, type DryRunIn, type DryRunOut } from "../api";

export const DRY_RUN_DEBOUNCE_MS = 500;

export type DryRunState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; out: DryRunOut }
  | { kind: "failed"; error: AlertRequestError };

/** `value` once its `key` has held still for `delay` ms, the first one too; the empty key at once. */
export function useSettled<T>(value: T, key: string, delay = DRY_RUN_DEBOUNCE_MS): { value: T; key: string } {
  // A key no value has: the first value waits like any other.
  const [settled, setSettled] = useState(() => ({ value, key: key === "" ? "" : "\u0000" }));
  useEffect(() => {
    if (key === settled.key) return;
    if (key === "") {
      setSettled({ value, key });
      return;
    }
    const timer = setTimeout(() => setSettled({ value, key }), delay);
    return () => clearTimeout(timer);
    // `value` is read through `key`: the same key is the same value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delay]);
  return settled;
}

export function useRuleDryRun(body: DryRunIn | null): DryRunState {
  const key = useMemo(() => (body === null ? "" : JSON.stringify(body)), [body]);
  const settled = useSettled(body, key);
  const waiting = settled.key !== key;
  const query = useDryRun(waiting ? null : settled.value);
  if (body === null) return { kind: "idle" };
  if (waiting || query.isFetching || query.status === "pending") return { kind: "checking" };
  if (query.status === "error") return { kind: "failed", error: query.error };
  return { kind: "done", out: query.data };
}
