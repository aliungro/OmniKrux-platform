import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cluster } from "../../api/types";
import {
  DEFAULT_HEIGHT,
  HEIGHT_KEY,
  MIN_HEIGHT,
  clampHeight,
  dockReducer,
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
  original_server: null,
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
    expect(s).toMatchObject({ sessions: [], focused: null, last: { logs: null, shell: null } });
  });

  it("split shows the focused logs and shell side by side", () => {
    let s = run(
      start(),
      { type: "open", session: session("l1", { pod: "p1" }) },
      { type: "open", session: session("sh", { kind: "shell" }) },
      { type: "open", session: session("l2", { pod: "p2" }) },
    );
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["l2"]);
    s = dockReducer(s, { type: "toggleLayout" });
    expect(s.layout).toBe("split");
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["l2", "sh"]);
    s = dockReducer(s, { type: "focus", id: "l1" });
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["l1", "sh"]);
    s = dockReducer(s, { type: "close", id: "sh" });
    expect(visibleSessions(s).map((x) => x.id)).toEqual(["l1"]);
    expect(dockReducer(s, { type: "toggleLayout" }).layout).toBe("single");
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
    expect(s.last.shell).toBe("n2");
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
    expect(s).toMatchObject({ focused: "l", last: { logs: "l", shell: "n2" } });
    // Still on the old tab: its replacement is where you are, so it takes the focus.
    s = dockReducer(s, { type: "focus", id: "n2" });
    s = dockReducer(s, { type: "replace", id: "n2", focus: false, session: session("n3", { kind: "shell", pod: "node-shell-3", cleanupPod: true, node: "w1" }) });
    expect(s.focused).toBe("n3");
  });

  it("an open without focus adds the tab and leaves the focused one alone", () => {
    let s = run(start(), { type: "open", session: session("a") });
    s = dockReducer(s, { type: "open", session: session("b", { kind: "shell" }), focus: false });
    expect(s.sessions.map((x) => x.id)).toEqual(["a", "b"]);
    expect(s).toMatchObject({ focused: "a", last: { logs: "a", shell: "b" } });
    s = dockReducer(s, { type: "open", session: session("c"), focus: false }); // same target as "a"
    expect(s.sessions).toHaveLength(2);
    // Nothing focused yet (an empty dock): the tab is shown.
    expect(dockReducer(start(), { type: "open", session: session("d"), focus: false }).focused).toBe("d");
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
