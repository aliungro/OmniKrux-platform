import { useCallback, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import { clusterLifecycle } from "./clusterLifecycle";
import { applyMessages, emptyWatchState, resetForReconnect, type WatchState } from "./watchState";
import type { WatchMessage } from "./types";
import { removeWatchedCluster } from "./useClusters";
import { wsUrl } from "./ws";

const DELAYS_MS = [1000, 2000, 5000, 10000];
/** Without requestAnimationFrame, batch over roughly one frame. */
const FALLBACK_FRAME_MS = 16;
/** Frames don't run in a hidden tab; this bounds how long messages queue up there. */
const MAX_BATCH_WAIT_MS = 1000;

const CLUSTER_MESSAGES: ReadonlySet<string> = new Set(["cluster_status", "snapshot", "upsert", "delete"]);

export interface WatchOptions {
  /** Called the first time a message names a cluster missing from `knownClusterIds`. */
  onUnknownCluster?: (id: string) => void;
  /** Called when the server says a cluster is gone. */
  onClusterRemoved?: (id: string) => void;
  /** The clusters the page knows about; while undefined, no id counts as unknown. */
  knownClusterIds?: Set<string>;
}

export function watchUrl(kind: string): string {
  return wsUrl("/api/watch", new URLSearchParams({ kind }));
}

/** Runs `cb` on the next animation frame (or after ~16 ms), and at the latest after 1 s. Returns a cancel. */
export function scheduleFrame(cb: () => void): () => void {
  let done = false;
  let raf: number | null = null;
  const run = () => {
    if (done) return;
    cancel();
    cb();
  };
  const backstop = setTimeout(run, MAX_BATCH_WAIT_MS);
  const fallback =
    typeof requestAnimationFrame === "function" ? null : setTimeout(run, FALLBACK_FRAME_MS);
  if (fallback === null) raf = requestAnimationFrame(run);
  function cancel() {
    done = true;
    clearTimeout(backstop);
    if (fallback !== null) clearTimeout(fallback);
    if (raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
  }
  return cancel;
}

/** One immutable snapshot per kind, shared while it has subscribers. */
const EMPTY: WatchState = emptyWatchState();

interface Subscriber {
  changed(): void;
  observe(id: string, removed: boolean): void;
}

interface SharedWatch {
  state: WatchState;
  subscribers: Set<Subscriber>;
  close(): void;
}

const standaloneWatches = new Map<string, SharedWatch>();
const clientWatches = new WeakMap<QueryClient, Map<string, SharedWatch>>();

function watchesFor(client: QueryClient | undefined): Map<string, SharedWatch> {
  if (!client) return standaloneWatches;
  let watches = clientWatches.get(client);
  if (!watches) {
    watches = new Map();
    clientWatches.set(client, watches);
  }
  return watches;
}

function startWatch(kind: string, client: QueryClient | undefined): SharedWatch {
  const lifecycle = client && clusterLifecycle(client);
  const removed = new Set<string>();
  const ignored = new Set<string>();
  const isRemoved = (id: string) => lifecycle?.isRemoved(id) ?? removed.has(id);
  let disposed = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let queue: WatchMessage[] = [];
  let cancelFrame: (() => void) | null = null;

  const takeQueue = () => {
    cancelFrame?.();
    cancelFrame = null;
    const batch = queue;
    queue = [];
    return batch;
  };

  const publish = (next: WatchState) => {
    if (next === watch.state) return;
    watch.state = next;
    for (const subscriber of watch.subscribers) subscriber.changed();
  };

  const flush = () => publish(applyMessages(watch.state, takeQueue()));

  const forget = (id: string) => {
    if (disposed) return;
    queue = queue.filter(message => message.cluster_id !== id);
    publish(applyMessages(watch.state, [{ type: "cluster_removed", cluster_id: id }]));
    for (const subscriber of watch.subscribers) subscriber.observe(id, true);
  };
  const closeSocket = () => {
    if (!socket) return;
    socket.onmessage = null;
    socket.onclose = null;
    socket.close();
    socket = null;
  };

  const connect = () => {
    const ws = new WebSocket(watchUrl(kind));
    socket = ws;
    ws.onmessage = (ev) => {
      if (disposed || socket !== ws) return;
      attempt = 0;
      let msg: WatchMessage;
      try {
        const parsed: unknown = JSON.parse(ev.data as string);
        if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
        msg = parsed as WatchMessage;
      } catch {
        console.warn("useWatch: ignoring malformed frame");
        return;
      }
      if (msg.type === "cluster_removed") {
        if (isRemoved(msg.cluster_id)) return;
        if (client) removeWatchedCluster(client, msg.cluster_id);
        else {
          removed.add(msg.cluster_id);
          forget(msg.cluster_id);
        }
        return;
      }
      if (CLUSTER_MESSAGES.has(msg.type)) {
        if (isRemoved(msg.cluster_id)) {
          ignored.add(msg.cluster_id);
          return;
        }
        ignored.delete(msg.cluster_id);
        for (const subscriber of watch.subscribers) subscriber.observe(msg.cluster_id, false);
      }
      if (disposed) return;
      queue.push(msg);
      if (cancelFrame === null) cancelFrame = scheduleFrame(flush);
    };
    ws.onclose = (ev) => {
      if (disposed || socket !== ws) return;
      socket = null;
      const next = applyMessages(watch.state, takeQueue());
      if (ev.code === 4404) {
        publish(next);
        return;
      }
      publish(resetForReconnect(next));
      if (disposed) return;
      const delay = DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)];
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
    };
  };

  const unsubscribeRemoval = lifecycle?.subscribe(forget);
  const unsubscribeAdd = lifecycle?.subscribeToAdds(id => {
    // An add can publish its first snapshot before the HTTP reply clears the removal.
    if (!ignored.delete(id)) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    closeSocket();
    publish(resetForReconnect(applyMessages(watch.state, takeQueue())));
    if (!disposed) connect();
  });
  const watch: SharedWatch = {
    state: EMPTY,
    subscribers: new Set(),
    close() {
      disposed = true;
      unsubscribeRemoval?.();
      unsubscribeAdd?.();
      takeQueue();
      if (timer !== null) clearTimeout(timer);
      closeSocket();
    },
  };
  connect();
  return watch;
}

/** Live rows of one kind from every cluster; `null` watches nothing. */
export function useWatch(kind: string | null, opts: WatchOptions = {}): WatchState {
  const client = useContext(QueryClientContext);
  const watches = watchesFor(client);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const reported = useRef(new Set<string>());

  const subscribe = useCallback((changed: () => void) => {
    if (kind === null) return () => {};
    let shared = watches.get(kind);
    if (!shared) {
      shared = startWatch(kind, client);
      watches.set(kind, shared);
    }
    const watch = shared;
    const subscriber: Subscriber = {
      changed,
      observe(id, removed) {
        const { knownClusterIds, onClusterRemoved, onUnknownCluster } = optsRef.current;
        if (removed) {
          reported.current.delete(id);
          onClusterRemoved?.(id);
        } else if (knownClusterIds && !knownClusterIds.has(id) && !reported.current.has(id)) {
          reported.current.add(id);
          onUnknownCluster?.(id);
        }
      },
    };
    watch.subscribers.add(subscriber);
    // A late subscriber can join after a cluster's initial status and snapshot.
    const { clusters, rows, pending } = watch.state;
    const ids = new Set([...Object.keys(clusters), ...Object.keys(rows), ...Object.keys(pending)]);
    for (const id of ids) subscriber.observe(id, false);
    return () => {
      watch.subscribers.delete(subscriber);
      if (watch.subscribers.size === 0) {
        watches.delete(kind);
        watch.close();
      }
    };
  }, [client, kind, watches]);

  const snapshot = useCallback(() => (kind === null ? EMPTY : watches.get(kind)?.state ?? EMPTY), [kind, watches]);
  return useSyncExternalStore(subscribe, snapshot);
}
