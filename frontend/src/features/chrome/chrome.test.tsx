import { registerSelectedRowFocus, requestSelectedRowFocus } from "./tableFocus";
import { FILE_CLUSTER_METADATA } from "../../test/clusters";
// frontend/src/features/chrome/chrome.test.tsx
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import type { Cluster } from "../../api/types";
import { ShortcutBar } from "./ShortcutBar";
import { FilterBar } from "./FilterBar";
import { TopBar } from "./TopBar";
import { KindTabs } from "./KindTabs";
import { DEFAULT_PINNED, usePinnedKinds } from "../settings/pinnedKinds";
import { pressed, SHORTCUTS, type Shortcut } from "./shortcuts";
import { focusTableRow, keyboardZone, routesPageKeys } from "./pageKeys";
import { chipsFor } from "../territories/model";
import { DEPLOYMENTS, EVENTS, KINDS, NODES, PODS, SECRETS } from "../../test/kinds";

const pinProps = {pinned: DEFAULT_PINNED, onPin: () => {}, onUnpin: () => {}, onMove: () => {}, onEditPinned: () => {}};
const POD_CHIPS = chipsFor(PODS);

afterEach(cleanup);

describe("shortcut modifiers", () => {
  it("pressed requires alt exactly when the shortcut says so", () => {
    const event = { key: "l", code: "KeyL", ctrlKey: false, metaKey: false, altKey: false };
    expect(pressed("logs", { ...event, altKey: true })).toBe(false);
    // Temporarily give a registry entry the future Alt shortcut contract, without registering one.
    const shortcut = SHORTCUTS.find((s) => s.id === "logs")!;
    const original = { ...shortcut };
    try {
      Object.assign(shortcut, { alt: true, code: ["KeyL"] } as Partial<Shortcut>);
      expect(pressed("logs", event)).toBe(false);
      expect(pressed("logs", { ...event, key: "¬", altKey: true })).toBe(true);
      expect(pressed("logs", { ...event, altKey: true, ctrlKey: true })).toBe(false);
      expect(pressed("logs", { ...event, altKey: true, metaKey: true })).toBe(false);
    } finally {
      delete shortcut.alt;
      delete shortcut.code;
      Object.assign(shortcut, original);
    }
  });
});

describe("page key ownership", () => {
  it("routes only the page and marked chrome, respecting nested owners", () => {
    render(<main data-page-keys>
      <button>Page action</button>
      <div role="grid"><button>Row action</button></div>
      <section data-page-keys="off"><button>Dock action</button></section>
      <div role="dialog"><button>Dialog action</button></div>
      <div role="listbox"><span>List option</span></div>
      <div role="menu"><button>Menu action</button></div>
      <input aria-label="Field" />
      <div contentEditable suppressContentEditableWarning><span>Editor text</span></div>
    </main>);
    expect(routesPageKeys(null)).toBe(true);
    expect(routesPageKeys(document.body)).toBe(true);
    expect(routesPageKeys(document.documentElement)).toBe(true);
    expect(routesPageKeys(screen.getByText("Page action"))).toBe(true);
    for (const text of ["Row action", "Dock action", "Dialog action", "List option", "Menu action", "Editor text"]) {
      expect(routesPageKeys(screen.getByText(text))).toBe(false);
    }
    expect(routesPageKeys(screen.getByLabelText("Field"))).toBe(false);
    const unmarked = document.createElement("button");
    expect(routesPageKeys(unmarked)).toBe(false);
  });

  it("focuses the grid's tab-stop row, or reports that no row is available", () => {
    expect(focusTableRow()).toBe(false);
    render(<div role="grid">
      <div data-row-key="first" tabIndex={-1}>First</div>
      <div data-row-key="selected" tabIndex={0}>Selected</div>
    </div>);
    expect(focusTableRow()).toBe(true);
    expect(document.activeElement).toBe(screen.getByText("Selected"));
  });
});

describe("FilterBar", () => {
  it("shows a picker only when choosing between multiple clusters", () => {
    const east: Cluster = {
      id: "c1", name: "East", provider: "aks", context_name: "east", server: "https://east",
      ...FILE_CLUSTER_METADATA, original_server: null, region: null, environment: "development", state: "ready", message: null,
    };
    const west: Cluster = { ...east, id: "c2", name: "West", provider: "gke" };
    const north: Cluster = { ...east, id: "c3", name: "North" };
    const onScope = vi.fn();
    const props = {
      value: { columns: [], sort: null, status: "all" as const, text: "", namespace: null },
      onChange: vi.fn(), chips: [], counts: {}, namespaces: null, onScope,
    };
    const { rerender } = render(<FilterBar {...props} clusters={[east, west]} scope={["c1"]} />);
    expect(screen.getByText("East")).toBeTruthy();
    expect(screen.getByText("AKS")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clusters" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all clusters" }));
    expect(onScope).toHaveBeenCalledExactlyOnceWith(null);

    rerender(<FilterBar {...props} clusters={[east, west]} scope={null} />);
    const picker = screen.getByRole("button", { name: "Clusters" });
    expect(picker.textContent).toBe("All clusters");
    expect(document.activeElement).toBe(picker);
    expect(screen.queryByRole("button", { name: "Show all clusters" })).toBeNull();

    rerender(<FilterBar {...props} clusters={[east]} scope={null} />);
    expect(screen.getByText("East")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clusters" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all clusters" })).toBeNull();

    rerender(<FilterBar {...props} clusters={[east]} scope={["c1"]} />);
    expect(screen.getByText("East")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clusters" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show all clusters" })).toBeNull();

    rerender(<FilterBar {...props} clusters={[east, west, north]} scope={["c1", "c2"]} />);
    expect(screen.getByRole("button", { name: "Clusters" }).textContent).toBe("2 clusters");
    expect(screen.queryByRole("button", { name: "Show all clusters" })).toBeNull();
  });

  it("slash focuses the filter, escape clears it", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ columns: [] as [], sort: null, status: "all", text: "abc", namespace: null }} onChange={onChange} chips={POD_CHIPS} namespaces={[]} counts={{ failing: 2, pending: 1, restartedToday: 4 }} />);
    fireEvent.keyDown(document.body, { key: "/" });
    const input = screen.getByPlaceholderText("Filter by name, label or image");
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).toHaveBeenCalledWith({ columns: [] as [], sort: null, status: "all", text: "", namespace: null });
  });
  it("chips show counts and select status", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ columns: [] as [], sort: null, status: "all", text: "", namespace: null }} onChange={onChange} chips={POD_CHIPS} namespaces={[]} counts={{ failing: 2, pending: 1, restartedToday: 4 }} />);
    fireEvent.click(screen.getByRole("button", { name: /Failing 2/ }));
    expect(onChange).toHaveBeenCalledWith({ columns: [] as [], sort: null, status: "failing", text: "", namespace: null });
  });
});

describe("FilterBar details", () => {
  const counts = { failing: 2, pending: 1, restartedToday: 4 };
  it("escape blurs the filter", () => {
    render(<FilterBar value={{ columns: [] as [], sort: null, status: "all", text: "abc", namespace: null }} onChange={() => {}} chips={POD_CHIPS} namespaces={[]} counts={counts} />);
    const input = screen.getByPlaceholderText("Filter by name, label or image");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);
  });
  it("slash is ignored while typing in another field", () => {
    render(<><input aria-label="other" /><FilterBar value={{ columns: [] as [], sort: null, status: "all", text: "", namespace: null }} onChange={() => {}} chips={POD_CHIPS} namespaces={[]} counts={counts} /></>);
    const other = screen.getByLabelText("other");
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(document.activeElement).toBe(other);
  });
  it("marks the active chip and keeps the text when switching status", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ columns: [] as [], sort: null, status: "pending", text: "pay", namespace: null }} onChange={onChange} chips={POD_CHIPS} namespaces={[]} counts={counts} />);
    expect(screen.getByRole("button", { name: "Pending 1" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Restarted today 4" }));
    expect(onChange).toHaveBeenCalledWith({ columns: [] as [], sort: null, status: "restartedToday", text: "pay", namespace: null });
  });
  it("typing updates the text", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ columns: [] as [], sort: null, status: "failing", text: "", namespace: null }} onChange={onChange} chips={POD_CHIPS} namespaces={[]} counts={counts} />);
    fireEvent.change(screen.getByPlaceholderText("Filter by name, label or image"), { target: { value: "api" } });
    expect(onChange).toHaveBeenCalledWith({ columns: [] as [], sort: null, status: "failing", text: "api", namespace: null });
  });
});

const cluster = (over = {}) => ({ id: "c1", name: "aks-prod-weu", context_name: "x", server: "https://x", ...FILE_CLUSTER_METADATA, original_server: null, provider: "aks", region: null, environment: "production", state: "ready", message: null, ...over }) as any;

describe("TopBar", () => {
  it("shows the wordmark and one scope token per cluster with failing counts", () => {
    render(<TopBar clusters={[
      { cluster: cluster(), state: "ready", message: null, failing: 1 },
      { cluster: cluster({ id: "c2", name: "kind-dev", provider: "kind" }), state: "ready", message: null, failing: 0 },
    ]} />);
    expect(screen.getByText("OmniKrux")).toBeTruthy();
    const tokens = screen.getAllByTestId("scope-token");
    expect(tokens.map((t) => t.textContent)).toEqual(["AKSaks-prod-weu1 failing", "KINDkind-dev"]);
  });
  it("the command box opens the palette, with its colon prompt and Ctrl K keycap", () => {
    const onPalette = vi.fn();
    render(<TopBar clusters={[]} onPalette={onPalette} />);
    const box = screen.getByRole("button", { name: "Commands and kinds" });
    expect(box.textContent).toBe(":pods, deploy, svc, helm…Ctrl K");
    expect(box.getAttribute("aria-keyshortcuts")).toBe("Control+K :");
    fireEvent.click(box);
    expect(onPalette).toHaveBeenCalled();
  });
  it("without a palette the box stays a quiet placeholder", () => {
    render(<TopBar clusters={[]} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("error token carries the message", () => {
    render(<TopBar clusters={[{ cluster: cluster(), state: "error", message: "Can't reach this cluster: timeout", failing: 0 }]} />);
    const token = screen.getByTestId("scope-token");
    expect(token.getAttribute("title")).toBe("Can't reach this cluster: timeout");
    expect(token.getAttribute("data-state")).toBe("error");
  });
  it("cloud scope token adds the account to the tooltip and preserves the status message", () => {
    const cloud = { account_id: "a1", account_name: "Production AWS", resource_id: "prod-east" };
    const active = cluster({ source: "cloud", provider: "eks", server: null, cloud });
    const message = "Can't reach this cluster: timeout";
    const { rerender } = render(<TopBar clusters={[{ cluster: active, state: "ready", message: null, failing: 0 }]} />);
    expect(screen.getByTestId("scope-token").title).toBe(cloud.account_name);
    rerender(<TopBar clusters={[{ cluster: active, state: "error", message, failing: 0 }]} />);
    expect(screen.getByTestId("scope-token").title).toContain(cloud.account_name);
    expect(screen.getByTestId("scope-token").title).toContain(message);
  });
  it("a retrying token carries the last error, a fresh one says Connecting…", () => {
    const message = "Retrying — Can't reach this cluster: timeout";
    render(<TopBar clusters={[
      { cluster: cluster(), state: "syncing", message, failing: 0 },
      { cluster: cluster({ id: "c2" }), state: "syncing", message: null, failing: 0 },
    ]} />);
    const [retrying, fresh] = screen.getAllByTestId("scope-token");
    expect(retrying.getAttribute("title")).toBe(message);
    expect(fresh.getAttribute("title")).toBe("Connecting…");
  });
});

describe("KindTabs", () => {
  const served = KINDS.kinds;
  it("shows the served everyday kinds in order, a count on the active one only, then all kinds", () => {
    const onSelect = vi.fn();
    render(<KindTabs {...pinProps} kinds={served} active="pods" count={131} onSelect={onSelect} />);
    const tabs = screen.getAllByRole("tab");
    // StatefulSets, Services, Nodes, Events, Helm releases and Deployments are served; jobs, daemonsets and ingresses aren't.
    expect(tabs.map((t) => t.textContent)).toEqual(["Pods131", "Deployments", "StatefulSets", "Services", "Nodes", "Events", "Helm releases"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    fireEvent.click(tabs[1]);
    expect(onSelect).toHaveBeenCalledWith("deployments.apps");
  });
  it("all kinds, with its colon keycap, opens the palette's kind mode", () => {
    const onAllKinds = vi.fn();
    const { rerender } = render(<KindTabs {...pinProps} kinds={served} active="pods" count={1} onSelect={() => {}} onAllKinds={onAllKinds} />);
    const all = screen.getByRole("button", { name: "All 8 kinds" });
    expect(all.textContent).toBe("All 8 kinds:");
    fireEvent.click(all);
    expect(onAllKinds).toHaveBeenCalled();
    // Before the kinds load there is no number to show, so no button.
    rerender(<KindTabs {...pinProps} kinds={undefined} active="pods" count={1} onSelect={() => {}} onAllKinds={onAllKinds} />);
    expect(screen.queryByRole("button", { name: /kinds/ })).toBeNull();
  });
  it("shows no count while no cluster has reported", () => {
    render(<KindTabs {...pinProps} kinds={served} active="deployments.apps" count={null} onSelect={() => {}} />);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Deployments");
  });
  it("before the kinds load, only the active kind; a kind outside the tabs gets its own", () => {
    const { rerender } = render(<KindTabs {...pinProps} kinds={undefined} active="pods" count={3} onSelect={() => {}} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Pods3"]);
    rerender(<KindTabs {...pinProps} kinds={served} active="certificates.cert-manager.io" count={2} onSelect={() => {}} />);
    expect(screen.getAllByRole("tab").at(-1)!.textContent).toBe("Certificates2");
  });
  it("arrow keys move between tabs, then show the kind they rest on, replacing history", () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      render(<KindTabs {...pinProps} kinds={[PODS, DEPLOYMENTS, NODES, EVENTS]} active="deployments.apps" count={4} onSelect={onSelect} />);
      const selected = () => screen.getByRole("tab", { selected: true });
      fireEvent.keyDown(selected(), { key: "ArrowRight" });
      // The tab moves at once (and takes focus); the kind waits until the keys rest.
      expect(selected().textContent).toBe("Nodes");
      expect(document.activeElement).toBe(selected());
      fireEvent.keyDown(selected(), { key: "ArrowRight" });
      fireEvent.keyDown(selected(), { key: "ArrowLeft" });
      fireEvent.keyDown(selected(), { key: "ArrowLeft" });
      fireEvent.keyDown(selected(), { key: "ArrowLeft" });
      expect(selected().textContent).toBe("Pods");
      expect(onSelect).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(300));
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith("pods", { replace: false });
      // A click is a choice of its own: at once, with its own history entry.
      fireEvent.click(screen.getByRole("tab", { name: "Events" }));
      expect(onSelect).toHaveBeenLastCalledWith("events");
    } finally {
      vi.useRealTimers();
    }
  });
  it("ignores a consumed arrow and cancels a pending move when the pane is deactivated", () => {
    vi.useFakeTimers();
    try {
      const props = { ...pinProps, kinds: [PODS, DEPLOYMENTS], active: "pods", count: null, onSelect: vi.fn() };
      const { rerender } = render(<KindTabs {...props} paneActive />);
      const pods = screen.getByRole("tab", { name: "Pods", selected: true });
      const consumed = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
      consumed.preventDefault();
      fireEvent(pods, consumed);
      expect(screen.getByRole("tab", { selected: true })).toBe(pods);
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(screen.getByRole("tab", { name: "Deployments", selected: true })).toBeTruthy();
      rerender(<KindTabs {...props} paneActive={false} />);
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      act(() => void vi.advanceTimersByTime(300));
      expect(screen.getByRole("tab", { selected: true })).toBe(pods);
      expect(props.onSelect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("says when the kinds can't be loaded, with Retry", () => {
    const onRetry = vi.fn();
    render(<KindTabs {...pinProps} kinds={undefined} active="pods" count={3} onSelect={() => {}} error="Can't reach the console's server. Check that it's running, then retry." onRetry={onRetry} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Pods3"]);
    expect(screen.getByRole("alert").textContent).toBe("Can't load the list of kinds: Can't reach the console's server. Check that it's running, then retry.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("FilterBar per kind", () => {
  it("namespace chip filters rows", () => {
    const onChange = vi.fn();
    const value = { columns: [] as [], sort: null, status: "failing", text: "api", namespace: null } as const;
    const { rerender } = render(<FilterBar value={value} onChange={onChange} chips={POD_CHIPS} counts={{ failing: 1, pending: 0, restartedToday: 0 }} namespaces={["kube-system", "payments"]} />);
    const chip = screen.getByRole("button", { name: "Namespace: all" });
    expect(chip.getAttribute("aria-haspopup")).toBe("listbox");
    fireEvent.click(chip);
    const list = screen.getByRole("listbox", { name: "Namespace" });
    expect(Array.from(list.querySelectorAll('[role="option"]')).map((o) => o.textContent)).toEqual(["All namespaces", "kube-system", "payments"]);
    expect(document.activeElement?.textContent).toBe("All namespaces");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith({ columns: [] as [], sort: null, status: "failing", text: "api", namespace: "payments" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(chip);

    rerender(<FilterBar value={{ ...value, namespace: "payments" }} onChange={onChange} chips={POD_CHIPS} counts={{ failing: 1, pending: 0, restartedToday: 0 }} namespaces={["kube-system", "payments"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Namespace: payments" }));
    expect(screen.getByRole("option", { name: "payments" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "All namespaces" }));
    expect(onChange).toHaveBeenLastCalledWith({ columns: [] as [], sort: null, status: "failing", text: "api", namespace: null });
    rerender(<FilterBar value={value} onChange={onChange} chips={POD_CHIPS} counts={{ failing: 1, pending: 0, restartedToday: 0 }} namespaces={["kube-system", "payments"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Namespace: all" }));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("chips follow the kind; cluster-wide kinds have no namespace chip", () => {
    const { rerender } = render(<FilterBar value={{ columns: [] as [], sort: null, status: "all", text: "", namespace: null }} onChange={() => {}} chips={chipsFor(EVENTS)} counts={{ warnings: 3 }} namespaces={["default"]} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Warnings 3", "Namespace: all"]);
    rerender(<FilterBar value={{ columns: [] as [], sort: null, status: "all", text: "", namespace: null }} onChange={() => {}} chips={chipsFor(NODES)} counts={{ failing: 0, pending: 1 }} namespaces={null} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Failing 0", "Pending 1"]);
  });
});

describe("FilterBar counts", () => {
  it("chips show no number until a count is real", () => {
    render(<FilterBar value={{ columns: [] as [], sort: null, status: "all", text: "", namespace: null }} onChange={() => {}} chips={POD_CHIPS} counts={{}} namespaces={[]} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Failing", "Pending", "Restarted today", "Namespace: all"]);
  });
});

describe("ShortcutBar per kind", () => {
  const strip = () => Array.from(within(screen.getByRole("navigation", { name: /^Keyboard shortcuts/ })).getAllByRole("listitem")).map((li) => li.textContent);
  it("shortcut bar follows the active kind", () => {
    const { rerender } = render(<ShortcutBar kind="pods" />);
    expect(strip()).toEqual([
      "↑↓ move", "Enter details", "l logs", "Shift L pin a log", "p previous logs", "s shell", "f port-forward", "Alt ↓ into the logs", "Ctrl Del delete", ": kinds", "Ctrl K commands", "/ filter", "? all shortcuts",
    ]);
    rerender(<ShortcutBar kind="deployments.apps" />);
    expect(strip()).toEqual([
      "↑↓ move", "Enter details", "s scale", "r restart", "l logs", "Alt ↓ into the logs", "Ctrl Del delete", ": kinds", "Ctrl K commands", "/ filter", "? all shortcuts",
    ]);
    rerender(<ShortcutBar kind="nodes" />);
    expect(strip()).toEqual(expect.arrayContaining(["c cordon", "r drain", "s node shell"]));
    expect(strip()).not.toContain("s shell");
    rerender(<ShortcutBar kind="secrets" />);
    expect(strip()).toContain("x reveal");
    rerender(<ShortcutBar kind="widgets.example.omnikrux.dev" />);
    expect(strip()).toEqual(["↑↓ move", "Enter details", "Alt ↓ into the logs", "Ctrl Del delete", ": kinds", "Ctrl K commands", "/ filter", "? all shortcuts"]);
  });
  it("the ? sheet lists the active kind's row keys and every other key", () => {
    render(<ShortcutBar kind="deployments.apps" />);
    fireEvent.click(screen.getByRole("button", { name: /all shortcuts/ }));
    const sheet = screen.getByRole("dialog", { name: "All shortcuts" });
    const rows = within(sheet).getByRole("region", { name: "Table" }).textContent;
    expect(rows).toContain("Scale");
    expect(rows).toContain("Delete");
    expect(rows).not.toContain("Shell in the selected pod");
    expect(rows).not.toContain("Reveal");
    const anywhere = within(sheet).getByRole("region", { name: "Anywhere" }).textContent;
    expect(anywhere).toContain("Jump to any kind");
    expect(anywhere).toContain("Ctrl K");
    expect(within(sheet).getByRole("region", { name: "Logs" }).textContent).toContain("Jump to live");
    expect(within(sheet).getByRole("region", { name: "Dock" }).textContent).toContain("Ctrl \\");
  });

  it("the bar shows the logs keys in the logs zone", () => {
    render(<ShortcutBar kind="pods" zone="logs" />);
    const text = screen.getByRole("navigation", { name: "Keyboard shortcuts: logs" }).textContent;
    expect(text).toContain("back to the table");
    expect(text).toContain("close the tab");
    expect(text).not.toContain("previous logs");
  });

  it("the bar shows the table keys with alt down and ctrl delete", () => {
    render(<ShortcutBar kind="pods" zone="table" />);
    const text = screen.getByRole("navigation", { name: "Keyboard shortcuts: table" }).textContent;
    expect(text).toContain("Alt ↓ into the logs");
    expect(text).toContain("Ctrl Del delete");
  });

  it("the bar shows cmd backspace on a mac and ctrl delete elsewhere", () => {
    const platform = vi.spyOn(navigator, "platform", "get");
    try {
      platform.mockReturnValue("MacIntel");
      const { unmount } = render(<ShortcutBar kind="pods" zone="table" />);
      const mac = screen.getByRole("navigation", { name: "Keyboard shortcuts: table" }).textContent;
      expect(mac).toContain("⌘ ⌫");
      expect(mac).not.toContain("Ctrl Del");
      unmount();
      platform.mockReturnValue("Win32");
      render(<ShortcutBar kind="pods" zone="table" />);
      const win = screen.getByRole("navigation", { name: "Keyboard shortcuts: table" }).textContent;
      expect(win).toContain("Ctrl Del");
      expect(win).not.toContain("⌫");
    } finally {
      platform.mockRestore();
    }
  });

  it("help keycaps follow the platform", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      render(<ShortcutBar kind="pods" zone="table" />);
      fireEvent.click(screen.getByRole("button", { name: /all shortcuts/ }));
      const sheet = screen.getByRole("dialog", { name: "All shortcuts" });
      expect(sheet.textContent).toContain("⌘ ⌫");
      expect(within(sheet).getByRole("region", { name: "Logs" }).textContent).toContain("Switch between dock tabs");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("help sheet names the dock", () => {
    render(<ShortcutBar kind="pods" />);
    fireEvent.click(screen.getByRole("button", { name: /all shortcuts/ }));
    const group = within(screen.getByRole("dialog", { name: "All shortcuts" })).getByRole("region", { name: "Dock" });
    expect(group.textContent).toContain("Switch the bottom dock between one pane and side by side");
  });
});


it("chips remove their filter and clear all removes every column filter", () => {
  const filters = { status:"all" as const, text:"", namespace:null, sort:null, columns:[{key:"name",op:"contains" as const,text:"api"},{key:"node",op:"oneOf" as const,values:["n1"]}] };
  const onChange = vi.fn(); render(<FilterBar value={filters} onChange={onChange} chips={[]} counts={{}} namespaces={null} columns={PODS.columns} />);
  fireEvent.click(screen.getByRole("button",{name:'Remove filter Name contains "api"'}));
  expect(onChange.mock.lastCall?.[0].columns).toEqual([filters.columns[1]]);
  fireEvent.click(screen.getByRole("button",{name:"Clear all"})); expect(onChange.mock.lastCall?.[0].columns).toEqual([]);
});
it("add filter reaches filterable columns and Escape restores focus", () => {
  render(<FilterBar value={{status:"all", text:"", namespace:null, columns:[], sort:null}} onChange={()=>{}} chips={[]} counts={{}} namespaces={null} columns={PODS.columns} />);
  const add = screen.getByRole("button",{name:"Add filter"}); fireEvent.click(add);
  fireEvent.click(screen.getByRole("button",{name:"Node"}));
  expect(screen.getByRole("dialog",{name:"Filter by Node"})).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"),{key:"Escape"}); expect(document.activeElement).toBe(add);
});

it("back during a pending arrow kind move wins", () => {
  vi.useFakeTimers();
  try {
    const onSelect = vi.fn();
    const { rerender } = render(<KindTabs {...pinProps} kinds={[PODS, DEPLOYMENTS, NODES]} active="pods" count={0} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("tab", { selected: true }), { key: "ArrowRight" });
    rerender(<KindTabs {...pinProps} kinds={[PODS, DEPLOYMENTS, NODES]} active="nodes" count={0} onSelect={onSelect} />);
    act(() => void vi.advanceTimersByTime(300));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { selected: true }).textContent).toContain("Nodes");
  } finally { vi.useRealTimers(); }
});

it("settled arrow moves preserve the origin as one history entry", () => {
  vi.useFakeTimers();
  try {
    const onSelect = vi.fn();
    const { rerender } = render(<KindTabs {...pinProps} kinds={[PODS, DEPLOYMENTS, NODES]} active="pods" count={0} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("tab", { selected: true }), { key: "ArrowRight" });
    act(() => void vi.advanceTimersByTime(300));
    expect(onSelect).toHaveBeenLastCalledWith("deployments.apps", { replace: false });
    rerender(<KindTabs {...pinProps} kinds={[PODS, DEPLOYMENTS, NODES]} active="deployments.apps" count={0} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("tab", { selected: true }), { key: "ArrowRight" });
    act(() => void vi.advanceTimersByTime(300));
    expect(onSelect).toHaveBeenLastCalledWith("nodes", { replace: true });
  } finally { vi.useRealTimers(); }
});

function PinnedRow({active="pods", onEditPinned=()=>{}}: {active?:string;onEditPinned?:()=>void}) {
  const pins=usePinnedKinds();
  return <KindTabs kinds={[...KINDS.kinds, SECRETS]} active={active} count={null} onSelect={()=>{}} pinned={pins.pinned} onPin={pins.pin} onUnpin={pins.unpin} onMove={pins.move} onEditPinned={onEditPinned}/>;
}
it("the secrets tab shows by default",()=>{
 render(<PinnedRow/>); expect(screen.getByRole("tab",{name:"Secrets"})).toBeTruthy();
});
it("pin button keeps an opened kind in the row",()=>{
 const view=render(<PinnedRow active="certificates.cert-manager.io"/>);
 const pin=screen.getByRole("button",{name:"Pin Certificates"});
 expect(pin.title).toBe("Keep Certificates in the tab row"); fireEvent.click(pin);
 view.rerender(<PinnedRow/>); expect(screen.getByRole("tab",{name:"Certificates"})).toBeTruthy();
});
it("unpin from the tab's menu",()=>{
 render(<PinnedRow/>); fireEvent.contextMenu(screen.getByRole("tab",{name:"Secrets"}));
 fireEvent.click(within(screen.getByRole("menu",{name:"Secrets tab"})).getByRole("menuitem",{name:"Unpin Secrets"}));
 expect(screen.queryByRole("tab",{name:"Secrets"})).toBeNull();
});
it("move left and right from the tab's menu",()=>{
 render(<PinnedRow/>);
 const order=()=>screen.getAllByRole("tab").map(t=>t.textContent);
 fireEvent.contextMenu(screen.getByRole("tab",{name:"Deployments"}));fireEvent.click(screen.getByRole("menuitem",{name:"Move left"}));
 expect(order().slice(0,2)).toEqual(["Deployments","Pods"]);
 fireEvent.contextMenu(screen.getByRole("tab",{name:"Deployments"}));fireEvent.click(screen.getByRole("menuitem",{name:"Move right"}));
 expect(order().slice(0,2)).toEqual(["Pods","Deployments"]);
});
it.each([{key:"F10",shiftKey:true},{key:"ContextMenu"}])("the tab menu opens from the keyboard: %s",key=>{
 render(<PinnedRow/>); const tab=screen.getByRole("tab",{name:"Pods"}); tab.focus(); fireEvent.keyDown(tab,key);
 expect(screen.getByRole("menu",{name:"Pods tab"})).toBeTruthy();
 fireEvent.keyDown(document.activeElement!,{key:"ArrowDown"});
 expect(document.activeElement?.textContent).toBe("Unpin Pods");
 fireEvent.keyDown(document.activeElement!,{key:"Escape"});expect(screen.queryByRole("menu")).toBeNull();expect(document.activeElement).toBe(tab);
});
it("edit pinned kinds invokes the settings section action",()=>{
 const edit=vi.fn(); render(<PinnedRow onEditPinned={edit}/>);
 fireEvent.contextMenu(screen.getByRole("tab",{name:"Pods"}));fireEvent.click(screen.getByRole("menuitem",{name:"Edit pinned kinds…"}));expect(edit).toHaveBeenCalledOnce();
});
it("a pinned kind no cluster serves is hidden from the row",()=>{
 render(<KindTabs {...pinProps} pinned={["pods","missing.example.io"]} kinds={KINDS.kinds} active="pods" count={null} onSelect={()=>{}}/>);
 expect(screen.getAllByRole("tab").map(t=>t.textContent)).toEqual(["Pods"]);
});
it("an active pinned kind disappears from the row when no cluster serves it",()=>{
 render(<KindTabs {...pinProps} pinned={["pods","secrets"]} kinds={[PODS, {...SECRETS,clusters:[]}]} active="secrets" count={null} onSelect={()=>{}}/>);
 expect(screen.getAllByRole("tab").map(t=>t.textContent)).toEqual(["Pods"]);
});
it("unpinning an inactive tab leaves focus on the active tab",()=>{
 render(<PinnedRow/>); fireEvent.contextMenu(screen.getByRole("tab",{name:"Secrets"}));
 fireEvent.click(screen.getByRole("menuitem",{name:"Unpin Secrets"}));
 expect(document.activeElement).toBe(screen.getByRole("tab",{name:"Pods"}));
});

describe("keyboard zone", () => {
  it("keyboard zone follows focus", () => {
    render(
      <div>
        <div role="grid"><div role="row" data-row-key="a" tabIndex={0}>row</div></div>
        <section data-dock data-page-keys="off"><button>dock button</button><input aria-label="dock search" /></section>
        <input aria-label="filter" />
        <div role="dialog"><button>in dialog</button></div>
      </div>,
    );
    expect(keyboardZone(null)).toBe("table");
    expect(keyboardZone(document.body)).toBe("table");
    expect(keyboardZone(screen.getByText("row"))).toBe("table");
    expect(keyboardZone(screen.getByText("dock button"))).toBe("logs");
    expect(keyboardZone(screen.getByLabelText("dock search"))).toBe("logs");
    expect(keyboardZone(screen.getByLabelText("filter"))).toBeNull();
    expect(keyboardZone(screen.getByText("in dialog"))).toBeNull();
  });
  it("keyboard zone is shell inside a terminal", () => {
    render(
      <section data-dock data-page-keys="off">
        <div role="tablist"><button role="tab">shell tab</button></div>
        <div className="xterm"><textarea aria-label="terminal input" /></div>
      </section>,
    );
    expect(keyboardZone(screen.getByLabelText("terminal input"))).toBe("shell");
    expect(keyboardZone(screen.getByRole("tab", { name: "shell tab" }))).toBe("logs");
  });
  it("a modal dialog inside the dock is not the logs zone", () => {
    render(<section data-dock><div aria-modal="true"><button>confirm</button></div></section>);
    expect(keyboardZone(screen.getByText("confirm"))).toBeNull();
  });
});

it("keeps the latest grid registration through stale cleanup and opts in only on reveal", () => {
  render(<main><div role="grid" /></main>);
  const grid = screen.getByRole("grid");
  const handler = vi.fn(() => true);
  const old = registerSelectedRowFocus(grid, handler);
  const current = registerSelectedRowFocus(grid, handler);
  old();
  expect(focusTableRow()).toBe(false);
  expect(focusTableRow(document, { selectedOnly: true })).toBe(false);
  expect(handler).not.toHaveBeenCalled();
  expect(focusTableRow(screen.getByRole("main"), { revealSelected: true })).toBe(true);
  current();
  expect(requestSelectedRowFocus(grid)).toBe(false);
});
