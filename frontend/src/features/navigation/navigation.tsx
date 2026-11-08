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
import { matchesFilter, NO_FILTER, type Filters, type Selection } from "../territories/model";
import s from "./navigation.module.css";

/** Where a link goes: the object, on the cluster the link was read from. */
export type Target = Link & { clusterId: string };
export type GoTo = (target: Target) => void;

/** How long the "isn't there any more" line stays above the table. */
export const MISSING_FOR_MS = 6_000;

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

/** "Deployment", "Helm release"; for a kind no cluster lists, its key read as a word ("secrets" → "Secret"). */
function kindLabel(kinds: KindInfo[] | undefined, key: string): string {
  const known = kinds?.find((k) => k.key === key)?.label;
  if (known) return known;
  const word = key.split(".")[0].replace(/s$/, "");
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Filters that would hide `row`, reset; filters that already show it, kept. */
function showing(row: ResourceRow, kindKey: string) {
  return (f: Filters): Filters => {
    const now = new Date();
    const status = matchesFilter(row, { ...NO_FILTER, status: f.status }, now, kindKey) ? f.status : "all";
    // A cluster-scoped kind ignores the namespace filter (and keeps it for later).
    const namespace = f.namespace === null || row.namespace === null || f.namespace === row.namespace ? f.namespace : null;
    const text = matchesFilter(row, { ...NO_FILTER, text: f.text }, now, kindKey) ? f.text : "";
    return status === f.status && namespace === f.namespace && text === f.text ? f : { status, namespace, text };
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
  /** The "isn't there any more" line, for MISSING_FOR_MS after a link found nothing. */
  notice: string | null;
  /** Goes up by one each time a link lands on its row: the table scrolls that row into view. */
  reveal: number;
  /** Forget a jump still waiting for its row (you picked something else meanwhile). */
  cancel: () => void;
}

/**
 * Console's side of the links. A jump waits for the target cluster's watch of the link's kind to
 * be ready with its rows; then it either selects the row (matched by namespace and name) or says
 * the object isn't there. Moving to another kind while it waits drops it.
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
  const [notice, setNotice] = useState<string | null>(null);
  const [reveal, setReveal] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((text: string | null) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = text === null ? null : setTimeout(() => {
      timer.current = null;
      setNotice(null);
    }, MISSING_FOR_MS);
    setNotice(text);
  }, []);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const goTo = useCallback<GoTo>((target) => {
    pending.current = { target, arrived: false };
    say(null);
    setAsked((n) => n + 1);
    const { kindKey: now, onKind } = latest.current;
    if (target.kind_key !== now) onKind(target.kind_key);
  }, [say]);

  const cancel = useCallback(() => {
    pending.current = null;
  }, []);

  useEffect(() => {
    const p = pending.current;
    if (p === null) return;
    const t = p.target;
    if (t.kind_key !== kindKey) {
      if (p.arrived) pending.current = null; // you moved on to another kind
      return;
    }
    p.arrived = true;
    const cluster = clusters.find((c) => c.id === t.clusterId);
    const missing = () => {
      pending.current = null;
      say(missingCopy(kindLabel(kinds, t.kind_key), t.namespace, t.name, cluster?.name ?? t.clusterId));
    };
    if (!cluster) return missing();
    const live = Object.hasOwn(watch.clusters, t.clusterId) ? watch.clusters[t.clusterId] : undefined;
    if (live?.state === "absent") return missing(); // the cluster doesn't serve the kind at all
    // Only a ready cluster with its whole snapshot in can say the object isn't there.
    if (live?.state !== "ready" || !Object.hasOwn(watch.rows, t.clusterId) || Object.hasOwn(watch.pending, t.clusterId)) return;
    let row: ResourceRow | undefined;
    for (const r of watch.rows[t.clusterId].values()) {
      if (r.name === t.name && (r.namespace ?? null) === (t.namespace ?? null)) {
        row = r;
        break;
      }
    }
    if (!row) return missing();
    pending.current = null;
    setFilters(showing(row, kindKey));
    setSelection({ selected: { clusterId: row.cluster_id, uid: row.uid }, open: true });
    setReveal((n) => n + 1);
  }, [asked, kindKey, watch, clusters, kinds, say, setFilters, setSelection]);

  return { goTo, notice, reveal, cancel };
}

/** The status line above the table: where a link found nothing. Always mounted, so it is announced. */
export function NavigationNotice({ text }: { text: string | null }) {
  return (
    <div className={s.notice} role="status" aria-live="polite">
      {text !== null && (
        <span className={s.line}>
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
