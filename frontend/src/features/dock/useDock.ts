import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { clusterLifecycle } from "../../api/clusterLifecycle";
import { failure, postJson } from "../../api/http";
import type { Cluster, ContainerInfo, DebugContainer, NodeShellPod, OwnerRef, PodDescribe, ResourceRow } from "../../api/types";
import { describeQuery, podPath } from "../inspector/useDescribe";
import { isContainerStates } from "../territories/ContainerBullets";
import { textColumn } from "../territories/model";
import {
  dockReducer,
  followSession,
  initialDockState,
  type DockAction,
  type DockState,
  type FollowHold,
  type Session,
  type SessionKind,
} from "./dockState";
import { prefetchShellPane } from "./lazyShell";

export const DEBUG_CONFIRM =
  "Ephemeral debug containers can't be removed. This one stays in the pod until the pod is deleted.";

/** Ruling R15's wording. */
export function nodeShellConfirm(node: string): string {
  return `This starts a privileged pod on ${node} with full access to the node. It is deleted when you close the session, and stops on its own after 1 hour.`;
}

/** Something that needs a yes before it changes the cluster. */
export interface Ask {
  kind: "debug" | "node";
  title: string;
  body: string;
  confirmLabel: string;
  cluster: Cluster;
  /** Where it happens, "cluster / namespace / pod" or "cluster / node". */
  where: string;
  busy: boolean;
  error: string | null;
  run: () => Promise<void>;
}

export type ShellChoice = {
  request: number;
  cluster: Cluster;
  where: string;
} & (
  | { stage: "loading" }
  | { stage: "choose"; containers: ContainerInfo[]; selected: string; open: (container: string) => void }
  | { stage: "error"; error: string; retry: () => void; openDefault: (() => void) | null }
);

export interface DockApi {
  state: DockState;
  /** A focus choice or closing the focused tab cancels pending opens' focus. */
  dispatch: Dispatch<DockAction>;
  /** Logs (optionally the previous run) or a shell for a pod row. */
  openPod: (row: ResourceRow, kind: SessionKind, opts?: { previous?: boolean }) => void;
  /** L, the row menu's "Logs" and the palette: open the one follow log on this pod, or retarget it. */
  openFollow: (row: ResourceRow) => void;
  /** The settled selection: retarget the follow log, if one is open, without taking focus. */
  followRow: (row: ResourceRow) => void;
  /** Keep the follow log on its last pod and say why (null: clear the note). */
  holdFollow: (reason: FollowHold | null) => void;
  /** Shift+L: the pod's log in its own pinned tab, which never retargets. */
  openPinned: (row: ResourceRow) => void;
  /** Shift+L in the follow log: pin its current pod in a tab of its own, leaving the focus where it is. */
  pinFollow: () => void;
  /** Logs of every pod the row's owner selects. */
  openOwnerLogs: (row: ResourceRow, owner: OwnerRef) => void;
  /**
   * Logs of every pod a workload row (a deployment, stateful set, daemon set) selects. `focus: false`
   * opens it without taking focus (asked a while ago, and you've moved on since).
   */
  openWorkloadLogs: (row: ResourceRow, selector: string, opts?: { focus?: boolean }) => void;
  askNodeShell: (clusterId: string, node: string) => void;
  /** For a shell whose container isn't running: a debug container targeting it. */
  askDebug: (session: Session) => void;
  /** Start again for a shell: a node shell gets a new node-shell pod (the old one was deleted). */
  askRestart: (session: Session) => void;
  ask: Ask | null;
  shellChoice: ShellChoice | null;
  confirm: () => void;
  cancel: () => void;
}

/** Every container whose logs can be read, init first, as the pod lists them. */
export function allContainers(d: PodDescribe): string[] {
  return [...d.init_containers, ...d.containers, ...d.ephemeral_containers].map((c) => c.name);
}

/** kubectl's choice: the default-container annotation, else the first regular container. */
export function defaultContainer(d: PodDescribe): string | null {
  const named = d.annotations["kubectl.kubernetes.io/default-container"];
  if (named && d.containers.some((c) => c.name === named)) return named;
  return d.containers[0]?.name ?? null;
}

/** Logs open on the container that's failing, since that's the one worth reading. */
function logsContainer(d: PodDescribe): string | null {
  return d.containers.find((c) => c.state_class === "bad")?.name ?? defaultContainer(d);
}

/** The pod a follow request is for. */
function followKey(clusterId: string, namespace: string, pod: string): string {
  return `${clusterId}|${namespace}|${pod}`;
}

function regularContainerCount(row: ResourceRow): number {
  const states = row.columns.containers;
  if (isContainerStates(states) && states.length > 0) return states.filter((c) => !c.init).length;
  // Ready counts reported statuses, which may be incomplete while a pod is starting.
  const reported = Number(textColumn(row, "ready")?.match(/^\d+\/(\d+)$/)?.[1]);
  return reported > 1 ? reported : 0;
}

/** The dock's sessions, and the flows that open them (some ask first, then call the server). */
export function useDock(clusters: Cluster[]): DockApi {
  const [state, dispatchNow] = useReducer(dockReducer, undefined, initialDockState);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [shellChoice, setShellChoice] = useState<ShellChoice | null>(null);
  const queryClient = useQueryClient();
  const lifecycle = clusterLifecycle(queryClient);
  const nextId = useRef(0);
  /**
   * The newest open request, or focus choice of yours. Opens wait for the pod's describe (or the
   * server), so they can finish out of order. A superseded shell lookup is discarded, while logs
   * can still open in the background. An open takes focus only if nothing newer happened
   * meanwhile (another open, a confirmed node shell or debug container, a tab you clicked or
   * closed while focused), or a slow one would pull your keystrokes to another pod (or cluster).
   */
  const latestOpen = useRef(0);
  /**
   * The newest follow request (L or a settled selection). A describe that resolves for an older
   * one is dropped, so a slow pod never retargets the follow log over a newer row.
   */
  const followSeq = useRef(0);
  /** The follow request still waiting on its describe, and the pod it's for. */
  const pendingFollow = useRef<{ seq: number; key: string } | null>(null);

  const shellPending = useRef<string | null>(null);
  const nextOpen = useCallback(() => {
    if (shellPending.current) {
      shellPending.current = null;
      setShellChoice(null);
    }
    return ++latestOpen.current;
  }, []);
  const stateRef = useRef(state);
  stateRef.current = state;
  const dispatch = useCallback((action: DockAction) => {
    if ((action.type === "open" || action.type === "replace" || action.type === "follow") &&
        lifecycle.isRemoved(action.session.cluster.id)) return;
    if (action.type === "focus" || (action.type === "close" && action.id === stateRef.current.focused)) nextOpen();
    dispatchNow(action);
  }, [lifecycle, nextOpen]);
  useEffect(() => lifecycle.subscribe(id => {
    if (shellPending.current === id) nextOpen();
    dispatchNow({ type: "closeCluster", clusterId: id });
    setAsk(current => current?.cluster.id === id ? null : current);
  }), [lifecycle, nextOpen]);
  const newId = useCallback(() => `s${++nextId.current}`, []);
  const clustersRef = useRef(clusters);
  clustersRef.current = clusters;
  const clusterOf = (id: string) => clustersRef.current.find((c) => c.id === id);

  /** The pod's containers, from the inspector's cached describe when it has one. */
  const containersOf = useCallback(
    (row: ResourceRow): Promise<PodDescribe> => {
      const rv = textColumn(row, "resource_version") ?? "";
      return queryClient.ensureQueryData(describeQuery(row.cluster_id, row.namespace ?? "", row.name, rv));
    },
    [queryClient],
  );

  const openPodShell = useCallback((row: ResourceRow, cluster: Cluster) => {
    const namespace = row.namespace ?? "";
    const where = `${cluster.name} / ${namespace} / ${row.name}`;
    const load = () => {
      const request = nextOpen();
      const current = () => request === latestOpen.current;
      const context = { request, cluster, where };
      const open = (container: string | null, containers: string[] = []) => {
        if (!current()) return;
        nextOpen();
        dispatch({
          type: "open",
          session: { id: newId(), kind: "shell", cluster, namespace, pod: row.name, container, containers },
        });
      };
      shellPending.current = cluster.id;
      setShellChoice({ ...context, stage: "loading" });
      void containersOf(row).then(
        (d) => {
          if (!current()) return;
          const selected = defaultContainer(d);
          const containers = allContainers(d);
          if (!selected || d.containers.length < 2) {
            open(selected, containers);
            return;
          }
          setShellChoice({
            ...context,
            stage: "choose",
            selected,
            containers: d.containers,
            open: (name) => {
              if (d.containers.some((c) => c.name === name)) open(name, containers);
            },
          });
        },
        (err: unknown) => {
          if (!current()) return;
          const count = regularContainerCount(row);
          if (count === 1) {
            open(null);
            return;
          }
          setShellChoice({
            ...context,
            stage: "error",
            error: failure(err, "retry"),
            retry: () => { if (current()) load(); },
            openDefault: count === 0 ? () => open(null) : null,
          });
        },
      );
    };
    load();
  }, [containersOf, dispatch, newId, nextOpen]);

  /** A log tab of its own for a pod row: the previous run (p), or pinned (Shift+L). */
  const openLogs = useCallback(
    (row: ResourceRow, opts: { previous?: boolean; pinned?: boolean }) => {
      const cluster = clustersRef.current.find((c) => c.id === row.cluster_id);
      if (!cluster || lifecycle.isRemoved(cluster.id)) return;
      const request = nextOpen();
      const started = lifecycle.startChange();
      void containersOf(row).catch(() => null).then((d) => {
        if (lifecycle.wasRemovedSince(cluster.id, started)) return;
        const session: Session = {
          id: newId(),
          kind: "logs",
          cluster,
          namespace: row.namespace ?? "",
          pod: row.name,
          container: d ? logsContainer(d) : null,
          containers: d ? allContainers(d) : [],
        };
        if (opts.previous) session.previous = true;
        if (opts.pinned) session.pinned = true;
        // The newest open is always selected, as a click's is; the keyboard stays where it is.
        dispatch({ type: "open", session, focus: request === latestOpen.current });
      });
    },
    [containersOf, newId, dispatch, lifecycle, nextOpen],
  );

  const openPod = useCallback(
    (row: ResourceRow, kind: SessionKind, opts: { previous?: boolean } = {}) => {
      if (kind === "shell") {
        const cluster = clustersRef.current.find((c) => c.id === row.cluster_id);
        if (cluster && !lifecycle.isRemoved(cluster.id)) openPodShell(row, cluster);
        return;
      }
      openLogs(row, { previous: opts.previous });
    },
    [lifecycle, openLogs, openPodShell],
  );

  const openPinned = useCallback((row: ResourceRow) => openLogs(row, { pinned: true }), [openLogs]);

  /**
   * Describes the pod, then opens or retargets the follow log on its default container. Each
   * request takes the next follow number, and one overtaken by a newer request is dropped.
   * `request` is L's open number (it takes the focus unless something newer happened meanwhile);
   * null for a settled selection, which never takes the focus.
   */
  const startFollow = useCallback(
    (row: ResourceRow, cluster: Cluster, request: number | null) => {
      const seq = ++followSeq.current;
      pendingFollow.current = { seq, key: followKey(cluster.id, row.namespace ?? "", row.name) };
      const started = lifecycle.startChange();
      void containersOf(row).catch(() => null).then((d) => {
        if (seq !== followSeq.current) return;
        pendingFollow.current = null;
        if (lifecycle.wasRemovedSince(cluster.id, started)) return;
        dispatch({
          type: "follow",
          focus: request !== null && request === latestOpen.current,
          session: {
            id: newId(),
            kind: "logs",
            cluster,
            namespace: row.namespace ?? "",
            pod: row.name,
            container: d ? defaultContainer(d) : null,
            containers: d ? allContainers(d) : [],
            follow: true,
          },
        });
      });
    },
    [containersOf, dispatch, lifecycle, newId],
  );

  const openFollow = useCallback(
    (row: ResourceRow) => {
      const cluster = clustersRef.current.find((c) => c.id === row.cluster_id);
      if (!cluster || lifecycle.isRemoved(cluster.id)) return;
      startFollow(row, cluster, nextOpen());
    },
    [lifecycle, nextOpen, startFollow],
  );

  const followRow = useCallback(
    (row: ResourceRow) => {
      const current = followSession(stateRef.current);
      if (!current) return;
      const key = followKey(row.cluster_id, row.namespace ?? "", row.name);
      // Already on its way (L on this row, or an earlier settle): let that one finish.
      if (pendingFollow.current?.key === key) return;
      if (key === followKey(current.cluster.id, current.namespace, current.pod)) {
        // Back on the followed pod: a retarget still on its way no longer applies, and the note goes.
        followSeq.current++;
        pendingFollow.current = null;
        dispatch({ type: "hold", reason: null });
        return;
      }
      const cluster = clustersRef.current.find((c) => c.id === row.cluster_id);
      if (!cluster || lifecycle.isRemoved(cluster.id)) return;
      startFollow(row, cluster, null);
    },
    [dispatch, lifecycle, startFollow],
  );

  const holdFollow = useCallback((reason: FollowHold | null) => dispatch({ type: "hold", reason }), [dispatch]);

  const pinFollow = useCallback(() => {
    const f = followSession(stateRef.current);
    if (!f) return;
    dispatch({
      type: "open",
      focus: false,
      session: {
        id: newId(),
        kind: "logs",
        cluster: f.cluster,
        namespace: f.namespace,
        pod: f.pod,
        container: f.container,
        containers: f.containers,
        pinned: true,
      },
    });
  }, [dispatch, newId]);

  const openOwnerLogs = useCallback(
    (row: ResourceRow, owner: OwnerRef) => {
      const cluster = clustersRef.current.find((c) => c.id === row.cluster_id);
      if (!cluster || !owner.selector) return;
      const selector = owner.selector;
      const request = nextOpen();
      const started = lifecycle.startChange();
      void containersOf(row).catch(() => null).then((d) => {
        if (lifecycle.wasRemovedSince(cluster.id, started)) return;
        dispatch({
          type: "open",
          focus: request === latestOpen.current,
          session: {
            id: newId(),
            kind: "logs",
            cluster,
            namespace: row.namespace ?? "",
            pod: owner.name,
            selector,
            // Every pod of a workload runs the same containers.
            container: d ? logsContainer(d) : null,
            containers: d ? [...d.init_containers, ...d.containers].map((c) => c.name) : [],
          },
        });
      });
    },
    [containersOf, newId, dispatch, lifecycle, nextOpen],
  );

  const openWorkloadLogs = useCallback(
    (row: ResourceRow, selector: string, opts: { focus?: boolean } = {}) => {
      const cluster = clustersRef.current.find((c) => c.id === row.cluster_id);
      if (!cluster) return;
      const focus = opts.focus ?? true;
      if (focus) nextOpen();
      // Nothing to wait for: the server starts each pod on its first container.
      dispatch({
        type: "open",
        focus,
        session: { id: newId(), kind: "logs", cluster, namespace: row.namespace ?? "", pod: row.name, selector, container: null, containers: [] },
      });
    },
    [newId, dispatch, nextOpen],
  );

  /** Shows the question; `act` runs on yes, and its failure stays in the dialog in plain words. */
  const confirmFirst = (question: Omit<Ask, "busy" | "error" | "run">, act: () => Promise<void>) => {
    if (shellPending.current) nextOpen();
    setAsk({ ...question, busy: false, error: null, run: act });
  };

  const nodeShell = (cluster: Cluster, node: string, replacing?: string) => {
    confirmFirst(
      {
        kind: "node",
        title: `Start a shell on node ${node}?`,
        body: nodeShellConfirm(node),
        confirmLabel: "Start node shell",
        cluster,
        where: `${cluster.name} / ${node}`,
      },
      async () => {
        const request = nextOpen();
        const started = lifecycle.startChange();
        await prefetchShellPane(); // before the pod exists: a terminal that can't load stops here
        if (lifecycle.wasRemovedSince(cluster.id, started)) return;
        const out = await postJson<NodeShellPod>(
          `/api/clusters/${encodeURIComponent(cluster.id)}/nodes/${encodeURIComponent(node)}/shell`,
        );
        if (lifecycle.wasRemovedSince(cluster.id, started)) return;
        const session: Session = {
          id: newId(),
          kind: "shell",
          cluster,
          namespace: out.namespace,
          pod: out.pod,
          container: out.container,
          containers: [out.container],
          cleanupPod: true,
          node,
        };
        const focus = request === latestOpen.current;
        dispatch(replacing ? { type: "replace", id: replacing, session, focus } : { type: "open", session, focus });
      },
    );
  };

  const askNodeShell = (clusterId: string, node: string) => {
    const cluster = clusterOf(clusterId);
    if (cluster) nodeShell(cluster, node);
  };

  const askDebug = (s: Session) => {
    confirmFirst(
      {
        kind: "debug",
        title: s.container ? `Start a debug container for ${s.container}?` : "Start a debug container?",
        body: DEBUG_CONFIRM,
        confirmLabel: "Start debug container",
        cluster: s.cluster,
        where: `${s.cluster.name} / ${s.namespace} / ${s.pod}`,
      },
      async () => {
        const request = nextOpen();
        const started = lifecycle.startChange();
        await prefetchShellPane(); // before the container exists, as it can't be removed
        if (lifecycle.wasRemovedSince(s.cluster.id, started)) return;
        const out = await postJson<DebugContainer>(`${podPath(s.cluster.id, s.namespace, s.pod)}/debug`, {
          target: s.container,
        });
        if (lifecycle.wasRemovedSince(s.cluster.id, started)) return;
        dispatch({
          type: "open",
          focus: request === latestOpen.current,
          session: {
            id: newId(),
            kind: "shell",
            cluster: s.cluster,
            namespace: s.namespace,
            pod: s.pod,
            container: out.container,
            containers: [...s.containers, out.container],
            debug: { requested: s.container, target: out.target },
          },
        });
      },
    );
  };

  const askRestart = (s: Session) => {
    if (s.node) nodeShell(s.cluster, s.node, s.id);
  };

  const confirm = () => {
    const current = ask;
    if (!current || current.busy) return;
    if (lifecycle.isRemoved(current.cluster.id)) return;
    const busy = { ...current, busy: true, error: null };
    setAsk(busy);
    current.run().then(
      () => setAsk(a => a === busy ? null : a),
      (err: unknown) => setAsk(a => a === busy ? { ...a, busy: false, error: failure(err) } : a),
    );
  };

  // Once the request is on its way it can't be called back: the pod or container is being made,
  // and it needs its session (a node-shell pod is only deleted when its session ends).
  const cancel = () => {
    if (shellPending.current && !ask?.busy) nextOpen();
    setAsk((a) => (a?.busy ? a : null));
  };

  // Keep the table's callbacks stable as the dock's sessions and dialogs change.
  const stable = useRef({ askNodeShell, askDebug, askRestart, confirm, cancel });
  stable.current = { askNodeShell, askDebug, askRestart, confirm, cancel };
  const fns = useMemo(
    () => ({
      askNodeShell: (c: string, n: string) => stable.current.askNodeShell(c, n),
      askDebug: (s: Session) => stable.current.askDebug(s),
      askRestart: (s: Session) => stable.current.askRestart(s),
      confirm: () => stable.current.confirm(),
      cancel: () => stable.current.cancel(),
    }),
    [],
  );

  return useMemo(
    () => ({
      state, dispatch, openPod, openFollow, followRow, holdFollow, openPinned, pinFollow, openOwnerLogs, openWorkloadLogs,
      ask, shellChoice, ...fns,
    }),
    [state, dispatch, openPod, openFollow, followRow, holdFollow, openPinned, pinFollow, openOwnerLogs, openWorkloadLogs,
      ask, shellChoice, fns],
  );
}
