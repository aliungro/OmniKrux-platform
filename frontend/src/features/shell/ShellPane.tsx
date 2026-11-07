import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ShellSession } from "../../api/types";
import { ProviderBadge, knownProvider } from "../territories/ProviderBadge";
import pc from "../territories/provider.module.css";
import { useExec } from "./useExec";
import s from "./ShellPane.module.css";

/** The dark palette of the Territories terminal. */
const THEME = {
  background: "#0C0A12",
  foreground: "#D4D0E6",
  cursor: "#D4D0E6",
  cursorAccent: "#0C0A12",
  selectionBackground: "rgba(201, 184, 255, 0.28)",
  black: "#15131F",
  red: "#FF4FA0",
  green: "#4FD6A0",
  yellow: "#F2C14E",
  blue: "#2F8BFF",
  magenta: "#C9B8FF",
  cyan: "#7DD3FC",
  white: "#ADA8C4",
  brightBlack: "#77718F",
  brightRed: "#FF8CC0",
  brightGreen: "#7FE8BE",
  brightYellow: "#FFE3A0",
  brightBlue: "#7DB4FF",
  brightMagenta: "#DCD0FF",
  brightCyan: "#B2E6FD",
  brightWhite: "#ECEAF4",
};

/** The server's refusal for a container that isn't running (see backend `running_container`). */
export function isNotRunning(message: string | null): boolean {
  return message !== null && message.startsWith("Can't open a shell:") && message.includes("isn't running");
}

/**
 * An interactive shell for one session. The header and the 2px top border always name and colour
 * the session's own cluster, so you can see where your keystrokes go.
 * `active`: whether the terminal takes keyboard focus (the dock passes it for the focused tab).
 * `onStartDebug`: shown as a button when the container isn't running; the dock starts the debug container.
 */
export function ShellPane({
  session,
  active = true,
  onStartDebug,
}: {
  session: ShellSession;
  active?: boolean;
  onStartDebug?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  const exec = useExec(
    {
      cluster: session.clusterId,
      namespace: session.namespace,
      pod: session.pod,
      container: session.container,
      cleanupPod: session.cleanupPod,
    },
    useCallback((data: string) => termRef.current?.write(data), []),
  );
  const { send, resize, reconnect } = exec;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: '"Geist Mono", ui-monospace, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.45,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    const refit = () => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet (hidden tab); the next resize fits it.
      }
    };
    refit();
    resize(term.cols, term.rows);

    const typed = term.onData((d) => send(d));
    const sized = term.onResize(({ cols, rows }) => resize(cols, rows));
    const watcher = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refit);
    watcher?.observe(host);
    // Cell size depends on the font; fit again once Geist Mono has loaded.
    void document.fonts?.ready.then(refit);

    return () => {
      watcher?.disconnect();
      typed.dispose();
      sized.dispose();
      termRef.current = null;
      term.dispose();
    };
  }, [send, resize]);

  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  const fresh = () => {
    termRef.current?.reset();
    reconnect();
  };

  const target = `${session.clusterName} / ${session.namespace} / ${session.pod}`;
  const provider = knownProvider(session.provider);

  return (
    <section
      className={`${s.pane} ${pc[provider]}`}
      data-provider={provider}
      aria-label={`Shell in ${target}`}
    >
      <header className={s.head}>
        <ProviderBadge provider={session.provider} />
        <span className={s.path}>{target}</span>
        {session.container && <span className={s.one}>({session.container})</span>}
      </header>

      <div className={s.termWrap}>
        <div ref={hostRef} className={`${s.term}${exec.status === "connecting" ? ` ${s.wait}` : ""}`} />
      </div>

      {exec.status === "exited" && (
        <div className={s.note} role="status">
          <span>
            {`Session ended${exec.exitCode === null ? "" : ` (exit ${exec.exitCode})`}`}
            {exec.message ? ` ${exec.message}` : ""}
          </span>
          <button type="button" className={s.btn} onClick={fresh}>Start again</button>
        </div>
      )}
      {exec.status === "disconnected" && (
        <div className={`${s.note} ${s.warn}`} role="status">
          <span>Disconnected</span>
          <button type="button" className={s.btn} onClick={fresh}>Reconnect</button>
        </div>
      )}
      {exec.status === "error" && (
        <div className={`${s.note} ${s.bad}`} role="alert">
          <span>{exec.message ?? "The shell failed."}</span>
          {isNotRunning(exec.message) && onStartDebug && (
            <button type="button" className={s.btn} onClick={onStartDebug}>Start a debug container</button>
          )}
        </div>
      )}
    </section>
  );
}
