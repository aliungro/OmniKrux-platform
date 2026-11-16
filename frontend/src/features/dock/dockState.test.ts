import { FILE_CLUSTER_METADATA } from "../../test/clusters";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cluster } from "../../api/types";
import {
  DEFAULT_HEIGHT,
  HEIGHT_KEY,
  MIN_HEIGHT,
  clampHeight,
  dockReducer,
  followSession,
  identity,
  initialDockState,
  loadHeight,
  saveHeight,
  toLogSession,
  visibleSessions,
  type DockState,
  type Session,
} from "./dockState";

const cluster = (over: Partial<Cluster> = {}): Cluster => ({
  id: "c1",
  name: "aks-prod-weu",
  context_name: "aks-prod-weu",
  server: "https://x",
  ...FILE_CLUSTER_METADATA, original_server: null,
  provider: "aks",
  region: null,
  environment: "production",
  state: "ready",
  message: null,
  ...over,
});

const session = (id: string, over: Partial<Session> = {}): Session => ({
  id,
  kind: "logs",
  cluster: cluster(),
  namespace: "payments",
  pod: "payments-api-xk2pq",
  container: "payments-api",
  containers: ["payments-api"],
  ...over,
});

const start = (): DockState => ({ ...initialDockState(), height: DEFAULT_HEIGHT });
const run = (state: DockState, ...actions: Parameters<typeof dockReducer>[1][]) => actions.reduce(dockReducer, state);

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("dockReducer", () => {
  it("open same session twice focuses existing", () => {
    let s = run(start(), { type: "open", session: session("a") }, { type: "open", session: session("b", { kind: "shell" }) });
    expect(s.focused).toBe("b");
    s = dockReducer(s, { type: "open", session: session("c") }); // same target as "a"
    expect(s.sessions.map((x) => x.id)).toEqual(["a", "b"]);
    expect(s.focused).toBe("a");
    // Previous-run logs, another container or another cluster are different sessions.
    s = run(
      s,
      { type: "open", session: session("d", { previous: true }) },
      { type: "open", session: session("e", { container: "istio-proxy" }) },
      { type: "open", session: session("f", { cluster: cluster({ id: "c2" }) }) },
    );
    expect(s.sessions.map((x) => x.id)).toEqual(["a", "b", "d", "e", "f"]);
  });

  it("closing the focused tab focuses its neighbour", () => {
    let s = run(start(), ...["a", "b", "c"].map((id) => ({ type: "open" as const, session: session(id, { pod: id }) })));
    s = dockReducer(s, { type: "focus", id: "b" });
    s = dockReducer(s, { type: "close", id: "b" });
    expect(s.focused).toBe("c");
    s = run(s, { type: "close", id: "c" });
    expect(s.focused).toBe("a");
    s = run(s, { type: "close", id: "a" });
    expect(s).toMatchObject({ sessions: [], focused: null, previous: null });
  });

  it("side by side shows the focused and the previously focused session", () => {
    let s = run(
      start(),
      { type: "open", session: session("l1", { pod: "p1" }) },
      { type: "open", session: session("sh", { kind: "shell" }) },
      { type: "open", session: session("l2", { pod: "p2" }) },
    );
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["l2"]);
    s = dockReducer(s, { type: "toggleLayout" });
    expect(s.layout).toBe("split");
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["sh", "l2"]);
    s = dockReducer(s, { type: "focus", id: "l1" });
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["l1", "l2"]);
    s = dockReducer(s, { type: "focus", id: "l1" }); // same focus keeps the previous session
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["l1", "l2"]);
    s = dockReducer(s, { type: "close", id: "l2" });
    expect(s).toMatchObject({ focused: "l1", previous: "sh" });
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["l1", "sh"]);
    expect(dockReducer(s, { type: "toggleLayout" }).layout).toBe("single");
  });

  it("cannot toggle side by side until two sessions are open", () => {
    expect(dockReducer(start(), { type: "toggleLayout" }).layout).toBe("single");
    const one = dockReducer(start(), { type: "open", session: session("a") });
    expect(dockReducer(one, { type: "toggleLayout" }).layout).toBe("single");
  });

  it("closing the focused session keeps an open previous session distinct from focus", () => {
    let s = run(start(), ...["a", "b", "c"].map((id) => ({ type: "open" as const, session: session(id, { pod: id }) })));
    s = run(s, { type: "focus", id: "a" }, { type: "close", id: "a" }, { type: "toggleLayout" });
    expect(s).toMatchObject({ focused: "b", previous: "c" });
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["b", "c"]);
    s = dockReducer(s, { type: "close", id: "b" });
    expect(s).toMatchObject({ focused: "c", previous: null });
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["c"]);
  });

  it("replace puts the new session in the old one's place and focuses it", () => {
    let s = run(
      start(),
      { type: "open", session: session("n1", { kind: "shell", pod: "node-shell-1", cleanupPod: true, node: "w1" }) },
      { type: "open", session: session("l") },
    );
    s = dockReducer(s, { type: "replace", id: "n1", session: session("n2", { kind: "shell", pod: "node-shell-2", cleanupPod: true, node: "w1" }) });
    expect(s.sessions.map((x) => x.id)).toEqual(["n2", "l"]);
    expect(s.focused).toBe("n2");
    expect(s.previous).toBe("l");
    // The old tab closed while the new pod was being made: the session is added, never lost.
    s = dockReducer(s, { type: "replace", id: "gone", session: session("n3", { kind: "shell", pod: "node-shell-3", cleanupPod: true, node: "w1" }) });
    expect(s.sessions.map((x) => x.id)).toEqual(["n2", "l", "n3"]);
    expect(s.focused).toBe("n3");
  });

  it("a replace without focus takes the old tab's place and leaves the focused one alone", () => {
    let s = run(
      start(),
      { type: "open", session: session("n1", { kind: "shell", pod: "node-shell-1", cleanupPod: true, node: "w1" }) },
      { type: "open", session: session("l") },
    );
    s = dockReducer(s, { type: "replace", id: "n1", focus: false, session: session("n2", { kind: "shell", pod: "node-shell-2", cleanupPod: true, node: "w1" }) });
    expect(s.sessions.map((x) => x.id)).toEqual(["n2", "l"]);
    expect(s).toMatchObject({ focused: "l", previous: "n2" });
    // Still on the old tab: its replacement is where you are, so it takes the focus.
    s = dockReducer(s, { type: "focus", id: "n2" });
    s = dockReducer(s, { type: "replace", id: "n2", focus: false, session: session("n3", { kind: "shell", pod: "node-shell-3", cleanupPod: true, node: "w1" }) });
    expect(s.focused).toBe("n3");
    expect(s.previous).toBe("l");
  });

  it("an open without focus adds the tab and leaves the focused one alone", () => {
    let s = run(start(), { type: "open", session: session("a") });
    s = dockReducer(s, { type: "open", session: session("b", { kind: "shell" }), focus: false });
    expect(s.sessions.map((x) => x.id)).toEqual(["a", "b"]);
    expect(s).toMatchObject({ focused: "a", previous: null });
    s = dockReducer(s, { type: "open", session: session("c"), focus: false }); // same target as "a"
    expect(s.sessions).toHaveLength(2);
    // Nothing focused yet (an empty dock): the tab is shown.
    expect(dockReducer(start(), { type: "open", session: session("d"), focus: false }).focused).toBe("d");
  });

  it("closing an unrelated background session does not invent a previous focus", () => {
    const s = run(start(),
      { type: "open", session: session("a") },
      { type: "open", session: session("b", { pod: "b" }), focus: false },
      { type: "open", session: session("c", { pod: "c" }), focus: false },
      { type: "close", id: "b" },
      { type: "toggleLayout" },
    );
    expect(s).toMatchObject({ focused: "a", previous: null });
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["a", "c"]);
  });
});

describe("follow and pinned logs", () => {
  const follow = (id: string, pod: string, over: Partial<Session> = {}) =>
    ({ type: "follow" as const, session: session(id, { pod, follow: true, ...over }) });

  it("follow appends one follow session then retargets it in place", () => {
    let s = run(start(), { type: "open", session: session("x", { pod: "x" }) }, follow("f1", "a"));
    expect(s.sessions.map((x) => x.id)).toEqual(["x", "f1"]);
    expect(s.focused).toBe("f1");
    s = run(s, { type: "focus", id: "x" }, { ...follow("f2", "b", { container: "web", containers: ["web", "helper"] }), focus: false });
    const followed = s.sessions.filter((x) => x.follow);
    expect(followed).toHaveLength(1);
    expect(followed[0]).toMatchObject({ id: "f1", pod: "b", follow: true, container: "web", containers: ["web", "helper"] });
    expect(s.sessions.map((x) => x.id)).toEqual(["x", "f1"]);
    expect(s.focused).toBe("x");
    s = dockReducer(s, follow("f3", "c"));
    expect(followSession(s)).toMatchObject({ id: "f1", pod: "c" });
    expect(s.focused).toBe("f1");
  });

  it("following the same pod again returns the same state", () => {
    const s = run(start(), follow("f1", "a"));
    expect(dockReducer(s, follow("f2", "a"))).toBe(s);
    expect(dockReducer(s, { ...follow("f2", "a"), focus: false })).toBe(s);
    expect(dockReducer(s, { type: "hold", reason: null })).toBe(s);
  });

  it("a follow and a pinned log of the same pod are two tabs", () => {
    const s = run(start(), follow("f", "a"), { type: "open", session: session("p", { pod: "a", pinned: true }) });
    expect(s.sessions.map((x) => x.id)).toEqual(["f", "p"]);
    expect(s.focused).toBe("p");
    // A plain log of that pod is a third.
    expect(dockReducer(s, { type: "open", session: session("l", { pod: "a" }) }).sessions).toHaveLength(3);
  });

  it("pinning a pod that is already pinned focuses its tab", () => {
    let s = run(
      start(),
      { type: "open", session: session("p1", { pod: "a", pinned: true }) },
      { type: "open", session: session("p2", { pod: "b", pinned: true }) },
    );
    expect(s.focused).toBe("p2");
    s = dockReducer(s, { type: "open", session: session("p3", { pod: "a", pinned: true }) });
    expect(s.sessions.map((x) => x.id)).toEqual(["p1", "p2"]);
    expect(s.focused).toBe("p1");
  });

  it("retarget clears the hold", () => {
    let s = run(start(), follow("f", "a"), { type: "hold", reason: "notPod" });
    expect(followSession(s)?.hold).toBe("notPod");
    s = dockReducer(s, { ...follow("g", "b"), focus: false });
    expect(followSession(s)).toMatchObject({ id: "f", pod: "b" });
    expect(followSession(s)?.hold).toBeUndefined();
    // Back on the same pod after a hold: the note goes, the stream stays.
    s = run(s, { type: "hold", reason: "noSelection" });
    const held = s;
    s = dockReducer(s, { ...follow("h", "b"), focus: false });
    expect(s).not.toBe(held);
    expect(followSession(s)).toMatchObject({ id: "f", pod: "b" });
    expect(followSession(s)?.hold).toBeUndefined();
  });

  it("hold sets the reason only on the follow session", () => {
    let s = run(
      start(),
      { type: "open", session: session("p", { pod: "a", pinned: true }) },
      { type: "open", session: session("l", { pod: "a" }) },
    );
    expect(dockReducer(s, { type: "hold", reason: "gone" })).toBe(s); // no follow log: nothing to hold
    s = run(s, follow("f", "a"), { type: "hold", reason: "gone" });
    expect(s.sessions.map((x) => x.hold)).toEqual([undefined, undefined, "gone"]);
    expect(dockReducer(s, { type: "hold", reason: "gone" })).toBe(s);
    s = dockReducer(s, { type: "hold", reason: null });
    expect(s.sessions.map((x) => x.hold)).toEqual([undefined, undefined, undefined]);
  });

  it("closeCluster closes the follow session too", () => {
    let s = run(
      start(),
      { type: "open", session: session("x", { pod: "x", cluster: cluster({ id: "c2" }) }) },
      follow("f", "a"),
      { type: "open", session: session("p", { pod: "a", pinned: true }) },
    );
    s = dockReducer(s, { type: "closeCluster", clusterId: "c1" });
    expect(s.sessions.map((x) => x.id)).toEqual(["x"]);
    expect(followSession(s)).toBeUndefined();
    expect(s.focused).toBe("x");
    // The next follow starts a new one.
    s = dockReducer(s, follow("g", "b"));
    expect(followSession(s)).toMatchObject({ id: "g", pod: "b" });
  });
});

describe("dock height", () => {
  it("dock height clamps and survives storage errors", () => {
    expect(clampHeight(50, 1000)).toBe(MIN_HEIGHT);
    expect(clampHeight(900, 1000)).toBe(700);
    expect(clampHeight(400, 1000)).toBe(400);
    expect(clampHeight(400, 100)).toBe(MIN_HEIGHT); // a tiny window still gets the minimum
    expect(run(start(), { type: "resize", height: 5000, viewport: 800 }).height).toBe(560);
    expect(run(start(), { type: "resize", height: 10, viewport: 800 }).height).toBe(MIN_HEIGHT);

    saveHeight(420);
    expect(window.localStorage.getItem(HEIGHT_KEY)).toBe("420");
    expect(loadHeight()).toBe(420);
    window.localStorage.setItem(HEIGHT_KEY, "40");
    expect(loadHeight()).toBe(MIN_HEIGHT);
    window.localStorage.setItem(HEIGHT_KEY, "not a number");
    expect(loadHeight()).toBe(DEFAULT_HEIGHT);

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    expect(() => saveHeight(300)).not.toThrow();
    expect(loadHeight()).toBe(DEFAULT_HEIGHT);
    expect(initialDockState().height).toBe(DEFAULT_HEIGHT);
  });
});

describe("session views", () => {
  it("names cluster / namespace / pod (container), and a selector session's pods", () => {
    expect(identity(session("a"))).toBe("aks-prod-weu / payments / payments-api-xk2pq (payments-api)");
    const all = session("b", { pod: "payments-api-7f9c4", selector: "app=payments-api", container: null });
    expect(identity(all)).toBe("aks-prod-weu / payments / pods matching app=payments-api");
    expect(toLogSession(all)).toMatchObject({ pod: undefined, selector: "app=payments-api", containers: ["payments-api"] });
  });
});
