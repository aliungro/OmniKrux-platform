import { useCallback, useEffect, useRef, useState } from "react";
import type { ExecMessage } from "../../api/types";

export interface ExecTarget {
  cluster: string;
  namespace: string;
  pod: string;
  /** Null or absent: the server picks the pod's first container. */
  container?: string | null;
  /** Node shells: the server deletes the pod when the session ends. */
  cleanupPod?: boolean;
}

export type ExecStatus = "connecting" | "open" | "exited" | "disconnected" | "error";

export interface ExecState {
  status: ExecStatus;
  /** The server's words for an error, or ours for a refused connection. */
  message: string | null;
  /** The shell's exit code once `status` is "exited"; null when the server didn't know it. */
  exitCode: number | null;
  /** Sends keystrokes. Dropped unless the session is open. */
  send: (data: string) => void;
  /** Tells the remote terminal its size. Held until the session opens, then sent. */
  resize: (cols: number, rows: number) => void;
  /** Opens a new session: a fresh shell, with none of the old output replayed. */
  reconnect: () => void;
}

/** Closes that come without a message, and mean trying again won't help. */
const REFUSED: Record<number, string> = {
  1008: "The console turned down this shell request. Open the shell again from the pod.",
  4403: "The console refused the connection from this page. Open the console from its own address.",
  4404: "Unknown cluster. It may have been removed from the kubeconfig; pick it again from the list.",
};

/** No `command`: the server picks bash or sh, or a shell on the node for a node-shell pod. */
export function execUrl(t: ExecTarget): string {
  const q = new URLSearchParams({ cluster: t.cluster, namespace: t.namespace, pod: t.pod });
  if (t.container) q.set("container", t.container);
  if (t.cleanupPod) q.set("cleanup_pod", "true");
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/exec?${q.toString()}`;
}

/**
 * One shell session over `WS /api/exec`. Output goes straight to `onOutput` (the terminal), never
 * through React state. A close the server didn't explain is "disconnected": the hook never
 * reconnects by itself, since a new connection is a new shell.
 */
export function useExec(target: ExecTarget, onOutput: (data: string) => void): ExecState {
  const [state, setState] = useState<{ status: ExecStatus; message: string | null; exitCode: number | null }>({
    status: "connecting",
    message: null,
    exitCode: null,
  });
  const [generation, setGeneration] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const openRef = useRef(false);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const outputRef = useRef(onOutput);
  outputRef.current = onOutput;
  const { cluster, namespace, pod, container, cleanupPod } = target;

  useEffect(() => {
    let disposed = false;
    let finished = false;
    openRef.current = false;
    setState({ status: "connecting", message: null, exitCode: null });
    let ws: WebSocket | null = null;
    const connect = () => {
      const socket = new WebSocket(execUrl({ cluster, namespace, pod, container, cleanupPod }));
      ws = socket;
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        openRef.current = true;
        setState((s) => (s.status === "connecting" ? { ...s, status: "open" } : s));
        const size = sizeRef.current;
        if (size) socket.send(JSON.stringify({ type: "resize", ...size }));
      };
      socket.onmessage = (ev: MessageEvent) => {
        if (disposed) return;
        let msg: ExecMessage;
        try {
          msg = JSON.parse(ev.data as string) as ExecMessage;
          if (msg === null || typeof msg !== "object") throw new Error("not an object");
        } catch {
          console.warn("useExec: ignoring malformed frame");
          return;
        }
        switch (msg.type) {
          case "stdout":
          case "stderr":
            outputRef.current(msg.data);
            break;
          case "exit":
            finished = true;
            openRef.current = false;
            setState({ status: "exited", message: msg.message, exitCode: msg.code });
            break;
          case "error":
            finished = true;
            openRef.current = false;
            setState({ status: "error", message: msg.message, exitCode: null });
            break;
        }
      };
      socket.onclose = (ev: CloseEvent) => {
        if (disposed) return;
        openRef.current = false;
        if (finished) return;
        if (Object.hasOwn(REFUSED, ev.code)) {
          setState({ status: "error", message: REFUSED[ev.code], exitCode: null });
          return;
        }
        setState({ status: "disconnected", message: null, exitCode: null });
      };
    };
    // A node shell's pod is deleted when its socket closes, so a mount that's undone at once
    // (React StrictMode in development) must not connect: wait until this commit has settled.
    if (cleanupPod) queueMicrotask(() => !disposed && connect());
    else connect();

    return () => {
      disposed = true;
      openRef.current = false;
      const socket = ws as WebSocket | null;
      if (!socket) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      if (socketRef.current === socket) socketRef.current = null;
      socket.close();
    };
  }, [cluster, namespace, pod, container, cleanupPod, generation]);

  const send = useCallback((data: string) => {
    if (openRef.current) socketRef.current?.send(JSON.stringify({ type: "stdin", data }));
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    sizeRef.current = { cols, rows };
    if (openRef.current) socketRef.current?.send(JSON.stringify({ type: "resize", cols, rows }));
  }, []);

  const reconnect = useCallback(() => setGeneration((g) => g + 1), []);

  return { ...state, send, resize, reconnect };
}
