import { useEffect, useState } from "react";
import { scheduleFrame } from "../../api/useWatch";
import type { LogLine, LogMessage } from "../../api/types";
import { LogBuffer, isMarker, type LogEntry } from "./logBuffer";
import { compareTs, formatTs, tsKey, type TsKey } from "./logTime";

const DELAYS_MS = [1000, 2000, 5000, 10000];

export interface LogStreamParams {
  cluster: string;
  namespace: string;
  /** Exactly one of `pod` and `selector`. */
  pod?: string | null;
  selector?: string | null;
  /** Null or absent: the server picks the pod's first container. */
  container?: string | null;
  previous: boolean;
  follow: boolean;
}

export type LogStreamStatus = "connecting" | "streaming" | "reconnecting" | "ended" | "error";

export interface LogStreamState {
  /** Mutated in place; `buffer.version` says when it changed. */
  buffer: LogBuffer;
  status: LogStreamStatus;
  /** The server's words for an error (or an ended stream), or ours for a lost connection. */
  message: string | null;
}

const LOST_RECONNECTING = "Lost the connection to the log stream. Reconnecting…";
const LOST_FOR_GOOD =
  "Lost the connection to the console's server before the log was complete. Check that it's running, then open the logs again.";

/** Closes that come without a status message, and mean trying again won't help. */
const REFUSED: Record<number, string> = {
  1008: "The console turned down this log request. Open the logs again from the pod.",
  4403: "The console refused the connection from this page. Open the console from its own address.",
  4404: "Unknown cluster. It may have been removed from the kubeconfig; pick it again from the list.",
};

export function logsUrl(p: LogStreamParams, sinceTime: string | null): string {
  const q = new URLSearchParams({ cluster: p.cluster, namespace: p.namespace });
  if (p.pod) q.set("pod", p.pod);
  if (p.selector) q.set("selector", p.selector);
  if (p.container) q.set("container", p.container);
  q.set("previous", String(p.previous));
  q.set("follow", String(p.follow));
  if (sinceTime !== null) q.set("since_time", sinceTime);
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/logs?${q.toString()}`;
}

export function gapMarker(from: string, to: string): string {
  return `Reconnected — lines between ${formatTs(from)} and ${formatTs(to)} may be missing`;
}

export function droppedMarker(count: number): string {
  const n = count.toLocaleString("en-US");
  return `${n} ${count === 1 ? "line" : "lines"} dropped because the page fell behind the stream`;
}

interface PodPoint {
  ts: string;
  key: TsKey;
  /** How many lines shown so far carry exactly this stamp. */
  count: number;
}

/**
 * Where each pod's lines got to. A stream reopened from `sinceTime()` repeats lines already shown
 * (the API server also rounds the time down to the second); `skipper()` drops exactly those.
 */
class ResumePoints {
  private pods = new Map<string, PodPoint>();

  shown(line: LogLine): void {
    const key = line.ts === null ? null : tsKey(line.ts);
    if (key === null || line.ts === null) return;
    const at = this.pods.get(line.pod);
    const order = at === undefined ? 1 : compareTs(key, at.key);
    if (order > 0) this.pods.set(line.pod, { ts: line.ts, key, count: 1 });
    else if (order === 0 && at) {
      at.ts = line.ts;
      at.count += 1;
    }
  }

  /** The stamp of the pod furthest behind (in pod mode, simply the last line's), or null if none. */
  sinceTime(): string | null {
    let min: PodPoint | null = null;
    for (const p of this.pods.values()) if (min === null || compareTs(p.key, min.key) < 0) min = p;
    return min?.ts ?? null;
  }

  /** True for a line of the reopened stream that was already shown. */
  skipper(): (line: LogLine) => boolean {
    const left = new Map([...this.pods].map(([pod, p]) => [pod, { key: p.key, count: p.count }]));
    return (line) => {
      const at = left.get(line.pod);
      if (at === undefined) return false;
      const key = line.ts === null ? null : tsKey(line.ts);
      if (key !== null) {
        const order = compareTs(key, at.key);
        if (order < 0) return true;
        if (order === 0 && at.count > 0) {
          at.count -= 1;
          return true;
        }
      }
      left.delete(line.pod); // past the resume point: everything from here on is new
      return false;
    };
  }
}

/**
 * Streams a pod's (or a selector's) log into a `LogBuffer` and re-renders at most once a frame.
 * While following, an unexpected close reconnects after 1, 2, 5, then every 10 s, resuming
 * from the last stamp shown and marking the gap. An ended stream, a server error, or a refused
 * connection stays closed.
 */
export function useLogStream(params: LogStreamParams): LogStreamState {
  const [buffer] = useState(() => new LogBuffer());
  const [, setVersion] = useState(0);
  const [state, setState] = useState<{ status: LogStreamStatus; message: string | null }>({
    status: "connecting",
    message: null,
  });
  const { cluster, namespace, pod, selector, container, previous, follow } = params;

  useEffect(() => {
    const p: LogStreamParams = { cluster, namespace, pod, selector, container, previous, follow };
    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelFrame: (() => void) | null = null;
    let attempt = 0;
    const resume = new ResumePoints();
    let skip: ((line: LogLine) => boolean) | null = null;
    /** Set on reconnect: the stamp the gap starts at, until the first new line says where it ends. */
    let gapFrom: string | null = null;

    const setStatus = (status: LogStreamStatus, message: string | null) =>
      setState((s) => (s.status === status && s.message === message ? s : { status, message }));
    const changed = () => {
      cancelFrame ??= scheduleFrame(() => {
        cancelFrame = null;
        setVersion(buffer.version);
      });
    };

    const take = (entries: readonly LogEntry[]) => {
      const out: LogEntry[] = [];
      for (const entry of entries) {
        if (isMarker(entry)) {
          out.push(entry);
          continue;
        }
        if (skip?.(entry)) continue;
        if (gapFrom !== null) {
          out.push({ marker: gapMarker(gapFrom, entry.ts ?? new Date().toISOString()) });
          gapFrom = null;
        }
        resume.shown(entry);
        out.push(entry);
      }
      buffer.push(out);
    };

    const connect = () => {
      const since = resume.sinceTime();
      if (since !== null) {
        skip = resume.skipper();
        gapFrom ??= since;
      }
      const ws = new WebSocket(logsUrl(p, since));
      socket = ws;
      let finished = false;
      ws.onmessage = (ev: MessageEvent) => {
        if (disposed) return;
        attempt = 0;
        let msg: LogMessage;
        try {
          msg = JSON.parse(ev.data as string) as LogMessage;
          if (msg === null || typeof msg !== "object") throw new Error("not an object");
        } catch {
          console.warn("useLogStream: ignoring malformed frame");
          return;
        }
        switch (msg.type) {
          case "lines":
            take(msg.lines);
            changed();
            break;
          case "dropped":
            buffer.addDropped(msg.count);
            buffer.push([{ marker: droppedMarker(msg.count) }]);
            changed();
            break;
          case "status":
            if (msg.state !== "streaming") finished = true;
            setStatus(msg.state, msg.message);
            break;
        }
      };
      ws.onclose = (ev: CloseEvent) => {
        if (disposed) return;
        socket = null;
        if (finished) return;
        if (Object.hasOwn(REFUSED, ev.code)) {
          setStatus("error", REFUSED[ev.code]);
          return;
        }
        if (!follow) {
          setStatus("error", LOST_FOR_GOOD);
          return;
        }
        setStatus("reconnecting", LOST_RECONNECTING);
        const delay = DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)];
        attempt += 1;
        timer = setTimeout(() => {
          timer = null;
          connect();
        }, delay);
      };
    };

    buffer.clear();
    setVersion(buffer.version);
    setStatus("connecting", null);
    connect();

    return () => {
      disposed = true;
      cancelFrame?.();
      if (timer !== null) clearTimeout(timer);
      if (socket) {
        socket.onmessage = null;
        socket.onclose = null;
        socket.close();
      }
    };
  }, [buffer, cluster, namespace, pod, selector, container, previous, follow]);

  return { buffer, status: state.status, message: state.message };
}
