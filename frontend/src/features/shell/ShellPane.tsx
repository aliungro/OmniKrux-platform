import { useCallback, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { ShellSession } from "../../api/types";
import { pressed } from "../chrome/shortcuts";
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

const FONT_FAMILY = '"Geist Mono", ui-monospace, Consolas, monospace';
const FONT_SIZE = 12.5;

/** Runs `open` once Geist Mono can be drawn (at once if it already can, or there's no font API). */
function whenFontReady(open: () => void): () => void {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  const spec = `${FONT_SIZE}px "Geist Mono"`;
  if (!fonts || fonts.check(spec)) {
    open();
    return () => {};
  }
  let live = true;
  fonts
    .load(spec)
    .catch(() => []) // can't load it: open with the fallback font rather than not at all
    .then(() => {
      if (live) open();
    });
  return () => {
    live = false;
  };
}

/** The server's refusal for a container that isn't running (see backend `running_container`). */
export function isNotRunning(message: string | null): boolean {
  return message !== null && message.startsWith("Can't open a shell:") && message.includes("isn't running");
}

/**
 * An interactive shell for one session. The header and the 2px top border always name and colour
 * the session's own cluster, so you can see where your keystrokes go.
 * `active`: whether the terminal takes keyboard focus (the dock passes it for the focused tab).
 * `onStartDebug`: shown as a button when the container isn't running, or the shell can't run in it (no
 * shell in the image); the dock starts the debug container.
 * `onRestart`: replaces Start again / Reconnect; a node shell needs a new node-shell pod, since the
 * server deleted the old one when its session ended.
 * `note`: a standing line under the terminal, e.g. what a debug container is attached to.
 */
export function ShellPane({
  session,
  active = true,
  onStartDebug,
  onRestart,
  note,
}: {
  session: ShellSession;
  active?: boolean;
  onStartDebug?: () => void;
  onRestart?: () => void;
  note?: string;
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

  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: 1.45,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term; // output written before the terminal opens is kept and shown

    const refit = () => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet (hidden tab); the next resize fits it.
      }
    };
    // Alt+Up leaves the shell for the table: not sent to the shell, so it reaches the dock.
    // Every other key, Esc included (vim, less), is the shell's.
    term.attachCustomKeyEventHandler?.((e) => !(e.type === "keydown" && pressed("leaveLogs", e)));
    const typed = term.onData((d) => send(d));
    const sized = term.onResize(({ cols, rows }) => resize(cols, rows));
    let watcher: ResizeObserver | null = null;

    // xterm measures its cells once, when it opens: open it after Geist Mono has loaded, or the
    // cells take the fallback font's width and the text runs past them.
    const cancelOpen = whenFontReady(() => {
      term.open(host);
      refit();
      resize(term.cols, term.rows);
      if (activeRef.current) term.focus();
      if (typeof ResizeObserver !== "undefined") {
        watcher = new ResizeObserver(refit);
        watcher.observe(host);
      }
    });

    return () => {
      cancelOpen();
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
    if (onRestart) {
      onRestart();
      return;
    }
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

      {note && <div className={s.aside}>{note}</div>}

      {exec.status === "exited" && (
        <div className={s.note} role="status">
          <span>
            {`Session ended${exec.exitCode === null ? "" : ` (exit ${exec.exitCode})`}`}
            {exec.message ? ` ${exec.message}` : ""}
            {exec.cannotRun && onStartDebug ? " A debug container brings its own shell." : ""}
          </span>
          {exec.cannotRun && onStartDebug && (
            <button type="button" className={s.btn} onClick={onStartDebug}>Start a debug container</button>
          )}
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
          {exec.canRetry && (
            <button type="button" className={s.btn} onClick={fresh}>Reconnect</button>
          )}
        </div>
      )}
    </section>
  );
}
