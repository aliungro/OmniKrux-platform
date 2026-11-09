import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { Cluster, KindInfo, Link, ResourceRow } from "../../api/types";
import type { WatchState } from "../../api/watchState";
import { fallbackKind, matchesFilter, NO_FILTER, type Filters, type Selection } from "../territories/model";
import s from "./navigation.module.css";

/** Where a link goes: the object, on the cluster the link was read from. */
export type Target = Link & { clusterId: string };
export type GoTo = (target: Target) => void;

/** How long the "isn't there any more" line stays above the table. */
export const MISSING_FOR_MS = 6_000;
/** How long a jump waits for its cluster's rows before it gives up. */
export const WAIT_FOR_MS = 6_000;
/** A jump that lands quicker than this never shows "Waiting for …". */
const QUIET_FOR_MS = 300;

const NOWHERE: GoTo = () => {};
const NavigationContext = createContext<GoTo | null>(null);

/** Hands `goTo` to every link below it (the inspector's, the table's object cells). */
export function NavigationProvider({ goTo, children }: { goTo: GoTo; children: ReactNode }) {
  return <NavigationContext.Provider value={goTo}>{children}</NavigationContext.Provider>;
}

/** Jumps to a link's object. Outside a NavigationProvider (a view rendered on its own) it does nothing. */
export function useGoTo(): GoTo {
  return useContext(NavigationContext) ?? NOWHERE;
}

/** Ruling R20: a cluster-scoped object is named without a namespace. */
export function missingCopy(kind: string, namespace: string | null, name: string, cluster: string): string {
  return `${kind} ${namespace ? `${namespace}/` : ""}${name} isn't on ${cluster} any more.`;
}

/** Global Constraints: the kind isn't served on the link's cluster. */
export function notServedCopy(key: string): string {
  return `This cluster doesn't serve ${key}.`;
}

/** The link's cluster never got ready (it errors, or is still syncing after WAIT_FOR_MS). */
export function notReadyCopy(kind: string, namespace: string | null, name: string, cluster: string): string {
  return `${kind} ${namespace ? `${namespace}/` : ""}${name} wasn't opened: ${cluster} isn't ready. Try the link again once it is.`;
}

/** "Deployment", "Helm release"; for a kind no cluster lists, its key read as a word ("secrets" → "Secret"). */
function kindLabel(kinds: KindInfo[] | undefined, key: string): string {
  const known = kinds?.find((k) => k.key === key)?.label;
  if (known) return known;
  const word = key.split(".")[0].replace(/s$/, "");
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Filters that would hide `row`, reset; filters that already show it, kept. */
function showing(row: ResourceRow, kind: Pick<KindInfo, "key" | "columns">) {
  return (f: Filters): Filters => {
    const now = new Date();
    const status = matchesFilter(row, { ...NO_FILTER, status: f.status }, now, kind) ? f.status : "all";
    // A cluster-scoped kind ignores the namespace filter (and keeps it for later).
    const namespace = f.namespace === null || row.namespace === null || f.namespace === row.namespace ? f.namespace : null;
    const text = matchesFilter(row, { ...NO_FILTER, text: f.text }, now, kind) ? f.text : "";
    const columns = f.columns.filter(column => matchesFilter(row, { ...NO_FILTER, columns: [column] }, now, kind));
    return status === f.status && namespace === f.namespace && text === f.text && columns.length === f.columns.length ? f : { ...f, status, namespace, text, columns };
  };
}

export interface NavigatorOptions {
  /** The kind on screen, and the watch of that kind. */
  kindKey: string;
  watch: WatchState;
  clusters: Cluster[];
  kinds: KindInfo[] | undefined;
  /** Switch the view to another kind. */
  onKind: (key: string) => void;
  setFilters: Dispatch<SetStateAction<Filters>>;
  setSelection: Dispatch<SetStateAction<Selection>>;
}

export interface Navigator {
  /** Stable: switches to the link's kind, then selects and opens its row once the watch has it. */
  goTo: GoTo;
  /**
   * The line above the table: "Waiting for {cluster}…" while a jump waits, then for MISSING_FOR_MS
   * why a link opened nothing.
   */
  notice: string | null;
  /** The notice is the waiting note. */
  waiting: boolean;
  /** Goes up by one each time a link lands on its row: the table scrolls that row into view. */
  reveal: number;
  /** Forget a jump still waiting for its row (you picked a row, a kind or a filter meanwhile). */
  cancel: () => void;
}

/**
 * Console's side of the links. A jump waits for the target cluster's watch of the link's kind to
 * be ready with its rows; then it either selects the row (matched by namespace and name) or says
 * the object isn't there. It waits WAIT_FOR_MS at most, and not at all once the cluster reports an
 * error; it says what it waits for. Moving to another kind while it waits drops it.
 */
export function useNavigator(opts: NavigatorOptions): Navigator {
  const { kindKey, watch, clusters, kinds, setFilters, setSelection } = opts;
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });
  /** `arrived`: the view has been on the link's kind since the jump. */
  const pending = useRef<{ target: Target; arrived: boolean } | null>(null);
  const [asked, setAsked] = useState(0);
  const [notice, setNotice] = useState<{ text: string; waiting: boolean } | null>(null);
  const [reveal, setReveal] = useState(0);
  /** Clears a said notice; ends a jump that waited too long; shows the waiting note. */
  const timers = useRef<{ said?: ReturnType<typeof setTimeout>; expiry?: ReturnType<typeof setTimeout>; quiet?: ReturnType<typeof setTimeout> }>({});

  const stop = (name: "said" | "expiry" | "quiet") => {
    clearTimeout(timers.current[name]);
    timers.current[name] = undefined;
  };
  const say = useCallback((text: string | null) => {
    stop("said");
    if (text !== null) timers.current.said = setTimeout(() => setNotice(null), MISSING_FOR_MS);
    setNotice(text === null ? null : { text, waiting: false });
  }, []);
  /** The jump is over (landed, missing, given up or dropped): no more waiting note or timers. */
  const settle = useCallback(() => {
    pending.current = null;
    stop("expiry");
    stop("quiet");
    setNotice((n) => (n?.waiting ? null : n));
  }, []);
  useEffect(() => () => {
    stop("said");
    stop("expiry");
    stop("quiet");
  }, []);

  /** What a jump to `t` is called in words: its kind's label and its cluster's name. */
  const words = (t: Target) => {
    const { kinds: k, clusters: c } = latest.current;
    return { kind: kindLabel(k, t.kind_key), cluster: c.find((x) => x.id === t.clusterId)?.name ?? t.clusterId };
  };

  const goTo = useCallback<GoTo>((target) => {
    settle();
    say(null);
    const jump = { target, arrived: false };
    pending.current = jump;
    timers.current.expiry = setTimeout(() => {
      if (pending.current !== jump) return;
      settle();
      const w = words(target);
      say(notReadyCopy(w.kind, target.namespace, target.name, w.cluster));
    }, WAIT_FOR_MS);
    setAsked((n) => n + 1);
    const { kindKey: now, onKind } = latest.current;
    if (target.kind_key !== now) onKind(target.kind_key);
  }, [say, settle]);

  const cancel = settle;

  useEffect(() => {
    const p = pending.current;
    if (p === null) return;
    const t = p.target;
    if (t.kind_key !== kindKey) {
      if (p.arrived) settle(); // you moved on to another kind
      return;
    }
    p.arrived = true;
    const cluster = clusters.find((c) => c.id === t.clusterId);
    const name = cluster?.name ?? t.clusterId;
    const kind = kindLabel(kinds, t.kind_key);
    const end = (text: string) => {
      settle();
      say(text);
    };
    if (!cluster) return end(missingCopy(kind, t.namespace, t.name, name));
    const live = Object.hasOwn(watch.clusters, t.clusterId) ? watch.clusters[t.clusterId] : undefined;
    if (live?.state === "absent") return end(notServedCopy(t.kind_key));
    if (live?.state === "error") return end(notReadyCopy(kind, t.namespace, t.name, name));
    // Only a ready cluster with its whole snapshot in can say the object isn't there.
    if (live?.state !== "ready" || !Object.hasOwn(watch.rows, t.clusterId) || Object.hasOwn(watch.pending, t.clusterId)) {
      // Say what it waits for, unless it lands in a moment.
      if (timers.current.quiet === undefined) {
        timers.current.quiet = setTimeout(() => {
          if (pending.current === p) setNotice({ text: `Waiting for ${name}…`, waiting: true });
        }, QUIET_FOR_MS);
      }
      return;
    }
    let row: ResourceRow | undefined;
    for (const r of watch.rows[t.clusterId].values()) {
      if (r.name === t.name && (r.namespace ?? null) === (t.namespace ?? null)) {
        row = r;
        break;
      }
    }
    if (!row) return end(missingCopy(kind, t.namespace, t.name, name));
    settle();
    setFilters(showing(row, kinds?.find(k => k.key === kindKey) ?? fallbackKind(kindKey)));
    setSelection({ selected: { clusterId: row.cluster_id, uid: row.uid }, open: true });
    setReveal((n) => n + 1);
  }, [asked, kindKey, watch, clusters, kinds, say, settle, setFilters, setSelection]);

  return { goTo, notice: notice?.text ?? null, waiting: notice?.waiting ?? false, reveal, cancel };
}

/**
 * The status line above the table: what a link waits for, or why it opened nothing. Always
 * mounted, so it is announced.
 */
export function NavigationNotice({ text, waiting = false }: { text: string | null; waiting?: boolean }) {
  return (
    <div className={s.notice} role="status" aria-live="polite">
      {text !== null && (
        <span className={`${s.line}${waiting ? ` ${s.waiting}` : ""}`}>
          <span className={s.ring} aria-hidden="true" />
          {text}
        </span>
      )}
    </div>
  );
}

/**
 * A link to another object: a quiet button in the focus colour. It never toggles the row it sits in.
 * `tabIndex={-1}` keeps the table's one-tab-stop rule; the inspector's links are tabbable.
 */
export function LinkButton({
  link,
  onLink,
  children,
  title,
  tabIndex,
  className,
}: {
  link: Link;
  onLink: (link: Link) => void;
  children: ReactNode;
  title?: string;
  tabIndex?: number;
  className?: string;
}) {
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onLink(link);
  };
  return (
    <button
      type="button"
      className={`${s.link}${className ? ` ${className}` : ""}`}
      title={title}
      tabIndex={tabIndex}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
