import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HttpError } from "../../api/http";
import { hasCurrentSnapshot, type WatchState } from "../../api/watchState";
import type { KubeView } from "../shell/workspace";
import { describeQuery } from "../inspector/useDescribe";
import { rowKey, textColumn } from "../territories/model";

type Target = Extract<KubeView, { page: "kind" }>["fromAttention"];
export function useAttentionLanding(target: Target, watch: WatchState, registered: boolean | undefined, paneActive: boolean, tableReady: boolean) {
  const client = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement | null>(null);
  const ownsFocus = useRef(false);
  const established = useRef<Target>(undefined);
  const [proof, setProof] = useState<{ target: Target; state: "ready" | "missing" | "error" } | null>(null);
  const [attempt, retry] = useState(0);
  const current = !!target && hasCurrentSnapshot(watch, target.clusterId);
  // A ready-state relist retains committed rows. Only a previously proved landing may
  // keep using them while the replacement snapshot is incomplete; new visits still wait.
  const retained = !!target && established.current === target
    && watch.clusters[target.clusterId]?.state === "ready"
    && watch.nextSnapshotPart[target.clusterId] !== undefined;
  const available = current || retained;
  const row = target && available ? watch.rows[target.clusterId]?.get(target.uid) : undefined;
  const name = row?.name;
  const namespace = row?.namespace;
  const rv = row ? textColumn(row, "resource_version") ?? "" : "";
  useLayoutEffect(() => {
    pane.current = root.current?.closest<HTMLElement>("[data-active-pane]") ?? null;
    if (target && paneActive && (document.activeElement === document.body || pane.current === document.activeElement)) root.current?.focus();
    ownsFocus.current = document.activeElement === root.current;
    const track = () => { ownsFocus.current = document.activeElement === root.current; };
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, [target]); // Ownership is claimed only on entry, never on a late update.
  useLayoutEffect(() => {
    if (target && !root.current && paneActive && ownsFocus.current && document.activeElement === document.body) pane.current?.focus();
  });
  useEffect(() => {
    let owned = true;
    // Once this landing proved the UID, the mounted inspector owns version refreshes.
    // Re-gating an ordinary same-UID update would unmount its editor and lose drafts.
    if (target && established.current === target && available && registered !== false && name !== undefined && namespace === target.namespace) return;
    established.current = undefined;
    setProof(null);
    if (!target) return;
    if (registered === false || (current && (name === undefined || namespace !== target.namespace))) {
      setProof({ target, state: "missing" });
      return;
    }
    if (!current || name === undefined) return;
    // staleTime zero forces a current read even after Back/Forward to a cached target.
    void client.fetchQuery({ ...describeQuery(target.clusterId, namespace ?? "", name, rv, target.uid), staleTime: 0 }).then(
      () => { if (owned) { established.current = target; setProof({ target, state: "ready" }); } },
      error => { if (owned) setProof({ target, state: error instanceof HttpError && error.status === 404 ? "missing" : "error" }); },
    );
    return () => { owned = false; };
  }, [target, current, available, registered, name, namespace, rv, client, attempt]);
  const state = !target ? null : proof?.target === target ? proof.state : "waiting";
  const ready = state === "ready" && available && !!row;
  useLayoutEffect(() => {
    const owner = root.current;
    if (!owner || !ready || !tableReady || !paneActive || document.activeElement !== owner || !target) return;
    const key = rowKey(target.clusterId, target.uid);
    const focusRow = () => {
      if (document.activeElement !== owner || !owner.isConnected) return false;
      const match = Array.from(owner.querySelectorAll<HTMLElement>("[data-row-key]")).find(el => el.dataset.rowKey === key);
      match?.focus({ preventScroll: true });
      return !!match;
    };
    if (focusRow()) return;
    // The virtualizer may commit the scrolled window after the table itself mounts.
    const observer = new MutationObserver(() => { if (focusRow()) observer.disconnect(); });
    const cancel = () => observer.disconnect();
    observer.observe(owner, { childList: true, subtree: true });
    owner.addEventListener("blur", cancel, { once: true });
    return () => { cancel(); owner.removeEventListener("blur", cancel); };
  }, [ready, tableReady, paneActive, target]);
  return { root, ready, state, retry: () => retry(n => n + 1) };
}
