import { useEffect, useRef, useState } from "react";
import { applyMessages, emptyWatchState, resetForReconnect, type WatchState } from "./watchState";
import type { WatchMessage } from "./types";

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
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/watch?kind=${encodeURIComponent(kind)}`;
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

export function useWatch(kind: string, opts: WatchOptions = {}): WatchState {
  const [state, setState] = useState<WatchState>(emptyWatchState);
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  // Unknown ids already reported during this hook's lifetime; an id leaves when its cluster is removed.
  const reported = useRef(new Set<string>());

  useEffect(() => {
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

    const flush = () => {
      const batch = takeQueue();
      if (batch.length > 0) setState((s) => applyMessages(s, batch));
    };

    const notice = (msg: WatchMessage) => {
      const { onUnknownCluster, onClusterRemoved, knownClusterIds } = optsRef.current;
      const id = msg.cluster_id;
      if (msg.type === "cluster_removed") {
        reported.current.delete(id);
        onClusterRemoved?.(id);
      } else if (
        CLUSTER_MESSAGES.has(msg.type) &&
        knownClusterIds !== undefined &&
        !knownClusterIds.has(id) &&
        !reported.current.has(id)
      ) {
        reported.current.add(id);
        onUnknownCluster?.(id);
      }
    };

    const connect = () => {
      const ws = new WebSocket(watchUrl(kind));
      socket = ws;
      ws.onmessage = (ev) => {
        if (disposed) return;
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
        notice(msg);
        queue.push(msg);
        if (cancelFrame === null) cancelFrame = scheduleFrame(flush);
      };
      ws.onclose = (ev) => {
        if (disposed) return;
        socket = null;
        const batch = takeQueue();
        if (ev.code === 4404) {
          if (batch.length > 0) setState((s) => applyMessages(s, batch));
          return;
        }
        setState((s) => resetForReconnect(applyMessages(s, batch)));
        const delay = DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)];
        attempt += 1;
        timer = setTimeout(() => {
          timer = null;
          connect();
        }, delay);
      };
    };

    setState(emptyWatchState());
    connect();

    return () => {
      disposed = true;
      takeQueue();
      if (timer !== null) clearTimeout(timer);
      if (socket) {
        socket.onmessage = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, [kind]);

  return state;
}
