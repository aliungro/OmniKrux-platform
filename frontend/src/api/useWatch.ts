import { useEffect, useState } from "react";
import { applyMessage, emptyWatchState, resetForReconnect, type WatchState } from "./watchState";
import type { WatchMessage } from "./types";

const DELAYS_MS = [1000, 2000, 5000, 10000];

export function watchUrl(kind: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/watch?kind=${encodeURIComponent(kind)}`;
}

export function useWatch(kind: string): WatchState {
  const [state, setState] = useState<WatchState>(emptyWatchState);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = () => {
      const ws = new WebSocket(watchUrl(kind));
      socket = ws;
      ws.onmessage = (ev) => {
        if (disposed) return;
        attempt = 0;
        const msg = JSON.parse(ev.data as string) as WatchMessage;
        setState((s) => applyMessage(s, msg));
      };
      ws.onclose = (ev) => {
        if (disposed) return;
        socket = null;
        if (ev.code === 4404) return;
        setState(resetForReconnect);
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
