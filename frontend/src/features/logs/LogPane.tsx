import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { LogSession } from "../../api/types";
import { ProviderBadge } from "../territories/ProviderBadge";
import { capsOf, inTerminal, isEditable, pressed } from "../chrome/shortcuts";
import k from "../chrome/key.module.css";
import { LOG_CAPACITY, isMarker, type LogItem } from "./logBuffer";
import { splitMatches, stepMatch, useLogSearch } from "./logSearch";
import { formatTs } from "./logTime";
import { useLogStream, type LogStreamStatus } from "./useLogStream";
import s from "./LogPane.module.css";

/** Row heights; keep in step with `.line` and `.sep` in LogPane.module.css. */
const LINE_HEIGHT = 20;
const MARKER_HEIGHT = 30;
const OVERSCAN = 20;
/** How close to the bottom still counts as at the bottom, in pixels. */
const BOTTOM_SLACK = LINE_HEIGHT / 2;
/** The match rail draws at most this many ticks, however many lines match. */
const RAIL_SLOTS = 240;

const count = (n: number) => n.toLocaleString("en-US");

function downloadUrl(session: LogSession, container: string | null, previous: boolean): string | null {
  if (!session.pod) return null;
  const [cluster, ns, pod] = [session.clusterId, session.namespace, session.pod].map(encodeURIComponent);
  const q = new URLSearchParams();
  if (container) q.set("container", container);
  q.set("previous", String(previous));
  return `/api/clusters/${cluster}/pods/${ns}/${pod}/logs/download?${q.toString()}`;
}

function Toggle({
  label,
  on,
  onChange,
  tone,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  tone?: "warn";
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={`${s.tgl}${tone === "warn" ? ` ${s.warn}` : ""}`}
      onClick={() => onChange(!on)}
    >
      {label}
    </button>
  );
}

function Highlighted({ text, query, caseSensitive }: { text: string; query: string; caseSensitive: boolean }) {
  if (query === "") return <>{text}</>;
  const parts = splitMatches(text, query, caseSensitive);
  if (parts.length === 1) return <>{text}</>;
  return <>{parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}</>;
}

const Row = memo(function Row({
  item,
  timestamps,
  showPod,
  query,
  caseSensitive,
}: {
  item: LogItem;
  timestamps: boolean;
  showPod: boolean;
  query: string;
  caseSensitive: boolean;
}) {
  if (isMarker(item)) return <span className={s.sepText}>{item.marker}</span>;
  return (
    <>
      {timestamps && (
        <span className={s.ts} title={item.ts ?? undefined}>
          {item.ts === null ? "" : formatTs(item.ts)}
        </span>
      )}
      {showPod && <span className={s.pod} title={item.pod}>{item.pod}</span>}
      <span className={s.text}>
        <Highlighted text={item.text} query={query} caseSensitive={caseSensitive} />
      </span>
    </>
  );
});

function Rail({ matches, firstSeq, total, currentSeq }: {
  matches: readonly number[];
  firstSeq: number;
  total: number;
  currentSeq: number | null;
}) {
  const slots = useMemo(() => {
    const seen = new Set<number>();
    for (const seq of matches) seen.add(Math.floor(((seq - firstSeq) / total) * RAIL_SLOTS));
    return [...seen];
  }, [matches, firstSeq, total]);
  if (total === 0 || matches.length === 0) return null;
  const at = (slot: number) => ({ top: `${(slot / RAIL_SLOTS) * 100}%` });
  return (
    <div className={s.rail} aria-hidden="true">
      {slots.map((slot) => <span key={slot} className={s.hit} style={at(slot)} />)}
      {currentSeq !== null && (
        <span className={`${s.hit} ${s.hitCur}`} style={at(((currentSeq - firstSeq) / total) * RAIL_SLOTS)} />
      )}
    </div>
  );
}

function StatusLine({ status, message, previous, retry }: {
  status: LogStreamStatus;
  message: string | null;
  previous: boolean;
  retry: (() => void) | null;
}) {
  if (status === "error") {
    return (
      <div className={`${s.foot} ${s.footBad}`} role="alert">
        <span>{message ?? "The log stream failed."}</span>
        {retry && <button type="button" className={s.retry} onClick={retry}>Try again</button>}
      </div>
    );
  }
  if (status === "reconnecting") {
    return <div className={`${s.foot} ${s.footWarn}`} role="status">{message}</div>;
  }
  if (status === "ended") {
    const end = previous ? "End of the previous run's log." : "The log stream ended.";
    return <div className={s.foot} role="status">{message ? `${end} ${message}` : end}</div>;
  }
  return null;
}

function emptyText(status: LogStreamStatus, previous: boolean): string | null {
  switch (status) {
    case "connecting":
      return "Connecting to the log stream…";
    case "streaming":
      return previous ? "Reading the previous run's log…" : "No lines yet. New lines show up here as the container writes them.";
    case "ended":
      return previous ? "The previous run wrote no log lines." : "The log is empty.";
    default:
      return null;
  }
}

/**
 * A live, searchable log for one session. Lines live in a ring buffer outside React; the pane
 * renders only the rows in view, and only when the buffer's version moves.
 * `active`: whether Ctrl F belongs to this pane (the dock passes it for the focused session).
 */
export function LogPane({ session, active = true }: { session: LogSession; active?: boolean }) {
  const [previous, setPrevious] = useState(session.previous ?? false);
  const [container, setContainer] = useState<string | null>(session.container ?? session.containers[0] ?? null);
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [currentSeq, setCurrentSeq] = useState<number | null>(null);

  const { buffer, status, message, retry } = useLogStream({
    cluster: session.clusterId,
    namespace: session.namespace,
    pod: session.pod,
    selector: session.selector,
    container,
    previous,
    follow: !previous, // a previous run has ended: there is nothing to follow
  });
  const version = buffer.version;
  const total = buffer.length;
  const firstSeq = total > 0 ? buffer.get(0)!.seq : 0;
  const matches = useLogSearch(buffer, version, query, caseSensitive);
  const current = currentSeq !== null && currentSeq >= firstSeq ? currentSeq : null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const lastTop = useRef(0);
  /**
   * Set while the view was moved for the reader (to a search match): a scroll that lands at the
   * bottom then is the clamp, not the reader, and mustn't turn follow back on. Cleared as soon as
   * the reader scrolls themselves (wheel, touch, pointer or keys on the log).
   */
  const moved = useRef(false);
  const readerScrolls = () => {
    moved.current = false;
  };

  const getItemKey = useCallback((i: number) => buffer.get(i)?.seq ?? -1 - i, [buffer]);
  const estimateSize = useCallback(
    (i: number) => {
      const item = buffer.get(i);
      return item && isMarker(item) ? MARKER_HEIGHT : LINE_HEIGHT;
    },
    [buffer],
  );
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    paddingStart: 6,
    paddingEnd: 6,
    // A paused reader keeps their lines in view while older ones leave the top of the buffer.
    anchorTo: "end",
    followOnAppend: follow,
  });

  // Wrapped rows are measured; unwrapped ones are all one height again.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, wrap, timestamps]);

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  // Following: the newest line stays in view.
  useLayoutEffect(() => {
    if (follow) toBottom();
  }, [follow, version, wrap, toBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const atBottom = top + el.clientHeight >= el.scrollHeight - BOTTOM_SLACK;
    if (atBottom && !moved.current) setFollow(true);
    else if (top < lastTop.current - 1) setFollow(false); // the reader scrolled up
    lastTop.current = top;
  };

  const jumpToLive = () => {
    moved.current = false;
    setFollow(true);
    toBottom();
  };

  const goToMatch = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    let from = current;
    if (from === null) {
      // Nothing chosen yet: start from what's on screen.
      const shown = virtualizer.getVirtualItems();
      from = dir === 1 ? firstSeq + (shown[0]?.index ?? 0) - 1 : firstSeq + (shown.at(-1)?.index ?? total) + 1;
    }
    const seq = matches[stepMatch(matches, from, dir)];
    setCurrentSeq(seq);
    setFollow(false);
    moved.current = true;
    virtualizer.scrollToIndex(seq - firstSeq, { align: "center" });
  };

  // Ctrl F (Cmd F) searches this log instead of the page; inside a terminal it's the shell's key
  // (readline's forward-char), even with this pane on screen beside it.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (inTerminal(e.target)) return;
      if (pressed("searchLogs", e)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const onPaneKey = (e: KeyboardEvent<HTMLElement>) => {
    if (pressed("jumpLive", e) && !isEditable(e.target)) {
      e.preventDefault();
      jumpToLive();
    }
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (query && !e.shiftKey && !e.nativeEvent.isComposing && pressed("closeLog", e)) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) changeQuery("");
    } else if (e.key === "Enter") {
      e.preventDefault();
      goToMatch(e.shiftKey ? -1 : 1);
    }
  };

  const changeQuery = (q: string) => {
    setQuery(q);
    setCurrentSeq(null);
  };

  const position = useMemo(() => {
    if (current === null) return 0;
    const i = stepMatch(matches, current - 1, 1); // the first match at or after it
    return matches[i] === current ? i + 1 : 0;
  }, [matches, current]);

  const href = downloadUrl(session, container, previous);
  const target = session.pod ?? `pods matching ${session.selector ?? ""}`;
  const empty = total === 0 ? emptyText(status, previous) : null;
  const showPod = !session.pod;

  let body: ReactNode = null;
  if (total > 0) {
    body = virtualizer.getVirtualItems().map((v) => {
      const item = buffer.get(v.index);
      if (!item) return null;
      const marker = isMarker(item);
      const isCurrent = !marker && item.seq === current;
      return (
        <div
          key={v.key}
          ref={wrap ? virtualizer.measureElement : undefined}
          data-index={v.index}
          data-seq={item.seq}
          data-kind={marker ? "marker" : "line"}
          aria-current={isCurrent ? "true" : undefined}
          className={`${marker ? s.sep : s.line}${isCurrent ? ` ${s.cur}` : ""}`}
          style={{ transform: `translateY(${v.start}px)`, height: wrap ? undefined : v.size }}
        >
          <Row
            item={item}
            timestamps={timestamps}
            showPod={showPod}
            query={query}
            caseSensitive={caseSensitive}
          />
        </div>
      );
    });
  }

  return (
    <section className={s.pane} aria-label={`Logs for ${target}`} onKeyDown={onPaneKey}>
      <header className={s.head}>
        <ProviderBadge provider={session.provider} />
        <span className={s.where}>
          <span className={s.path}>{`${session.clusterName} / ${session.namespace} / ${target}`}</span>
          {session.containers.length > 1 ? (
            <select
              aria-label="Container"
              className={s.pick}
              value={container ?? ""}
              onChange={(e) => setContainer(e.target.value)}
            >
              {session.containers.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            container && <span className={s.one}>({container})</span>
          )}
        </span>
        {href && (
          <a className={s.btn} href={href} download>
            Download
          </a>
        )}
      </header>

      <div className={s.bar}>
        <div className={`${s.search}${query ? ` ${s.searching}` : ""}`}>
          <input
            ref={searchRef}
            type="search"
            aria-label="Search logs"
            placeholder="Search logs"
            spellCheck={false}
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {query === "" ? (
            <span className={`${k.k} ${s.k}`} aria-hidden="true">{capsOf("searchLogs")[0]}</span>
          ) : (
            <>
              <span className={s.hits}>{`${count(position)} of ${count(matches.length)}`}</span>
              <button
                type="button"
                className={s.case}
                aria-pressed={caseSensitive}
                title="Match case"
                onClick={() => {
                  setCaseSensitive(!caseSensitive);
                  setCurrentSeq(null);
                }}
              >
                Aa
              </button>
              <span className={s.nav}>
                <button type="button" aria-label="Previous match" disabled={matches.length === 0} onClick={() => goToMatch(-1)}>▲</button>
                <button type="button" aria-label="Next match" disabled={matches.length === 0} onClick={() => goToMatch(1)}>▼</button>
              </span>
            </>
          )}
        </div>
        <Toggle label="Previous" on={previous} onChange={setPrevious} tone="warn" />
        <Toggle label="Follow" on={follow} onChange={(on) => (on ? jumpToLive() : setFollow(false))} />
        <Toggle label="Timestamps" on={timestamps} onChange={setTimestamps} />
        <Toggle label="Wrap" on={wrap} onChange={setWrap} />
      </div>

      {buffer.evicted > 0 && (
        <div className={s.notice}>
          {`Showing the last ${count(LOG_CAPACITY)} lines (${count(buffer.dropped)} older lines not kept)`}
        </div>
      )}

      <div className={s.wrapArea}>
        <div
          ref={scrollRef}
          role="log"
          aria-live="off"
          aria-label="Log lines"
          tabIndex={0}
          className={`${s.logs}${wrap ? ` ${s.wrapped}` : ""}`}
          onScroll={onScroll}
          onWheel={readerScrolls}
          onTouchStart={readerScrolls}
          onPointerDown={readerScrolls}
          onKeyDown={readerScrolls}
        >
          <div className={s.body} style={{ height: virtualizer.getTotalSize() }}>
            {body}
          </div>
        </div>
        <Rail matches={matches} firstSeq={firstSeq} total={total} currentSeq={current} />
        {empty && <div className={s.empty}>{empty}</div>}
        {!follow && total > 0 && (
          <button type="button" className={s.jump} onClick={jumpToLive}>
            Jump to live<span className={`${k.k} ${s.k}`} aria-hidden="true">{capsOf("jumpLive")[0]}</span>
          </button>
        )}
      </div>

      <StatusLine status={status} message={message} previous={previous} retry={retry} />
    </section>
  );
}
