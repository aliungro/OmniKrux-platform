// frontend/src/features/chrome/chrome.test.tsx
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { ShortcutBar } from "./ShortcutBar";
import { FilterBar } from "./FilterBar";
import { TopBar } from "./TopBar";
import { KindTabs } from "./KindTabs";
import { chipsFor } from "../territories/model";
import { DEPLOYMENTS, EVENTS, KINDS, NODES, PODS } from "../../test/kinds";

const POD_CHIPS = chipsFor(PODS);

afterEach(cleanup);

describe("FilterBar", () => {
  it("slash focuses the filter, escape clears it", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ status: "all", text: "abc", namespace: null }} onChange={onChange} chips={POD_CHIPS} namespaces={[]} counts={{ failing: 2, pending: 1, restartedToday: 4 }} />);
    fireEvent.keyDown(document.body, { key: "/" });
    const input = screen.getByPlaceholderText("Filter by name, label or image");
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).toHaveBeenCalledWith({ status: "all", text: "", namespace: null });
  });
  it("chips show counts and select status", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ status: "all", text: "", namespace: null }} onChange={onChange} chips={POD_CHIPS} namespaces={[]} counts={{ failing: 2, pending: 1, restartedToday: 4 }} />);
    fireEvent.click(screen.getByRole("button", { name: /Failing 2/ }));
    expect(onChange).toHaveBeenCalledWith({ status: "failing", text: "", namespace: null });
  });
});

describe("FilterBar details", () => {
  const counts = { failing: 2, pending: 1, restartedToday: 4 };
  it("escape blurs the filter", () => {
    render(<FilterBar value={{ status: "all", text: "abc", namespace: null }} onChange={() => {}} chips={POD_CHIPS} namespaces={[]} counts={counts} />);
    const input = screen.getByPlaceholderText("Filter by name, label or image");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);
  });
  it("slash is ignored while typing in another field", () => {
    render(<><input aria-label="other" /><FilterBar value={{ status: "all", text: "", namespace: null }} onChange={() => {}} chips={POD_CHIPS} namespaces={[]} counts={counts} /></>);
    const other = screen.getByLabelText("other");
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(document.activeElement).toBe(other);
  });
  it("marks the active chip and keeps the text when switching status", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ status: "pending", text: "pay", namespace: null }} onChange={onChange} chips={POD_CHIPS} namespaces={[]} counts={counts} />);
    expect(screen.getByRole("button", { name: "Pending 1" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Restarted today 4" }));
    expect(onChange).toHaveBeenCalledWith({ status: "restartedToday", text: "pay", namespace: null });
  });
  it("typing updates the text", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ status: "failing", text: "", namespace: null }} onChange={onChange} chips={POD_CHIPS} namespaces={[]} counts={counts} />);
    fireEvent.change(screen.getByPlaceholderText("Filter by name, label or image"), { target: { value: "api" } });
    expect(onChange).toHaveBeenCalledWith({ status: "failing", text: "api", namespace: null });
  });
});

const cluster = (over = {}) => ({ id: "c1", name: "aks-prod-weu", context_name: "x", server: "https://x", original_server: null, provider: "aks", region: null, environment: "production", state: "ready", message: null, ...over }) as any;

describe("TopBar", () => {
  it("shows the wordmark and one scope token per cluster with failing counts", () => {
    render(<TopBar clusters={[
      { cluster: cluster(), state: "ready", message: null, failing: 1 },
      { cluster: cluster({ id: "c2", name: "kind-dev", provider: "kind" }), state: "ready", message: null, failing: 0 },
    ]} />);
    expect(screen.getByText("Omnikrux")).toBeTruthy();
    const tokens = screen.getAllByTestId("scope-token");
    expect(tokens.map((t) => t.textContent)).toEqual(["AKSaks-prod-weu1 failing", "KINDkind-dev"]);
  });
  it("the command-palette placeholder is quiet: no keycap, no prompt, nothing to focus", () => {
    const { container } = render(<TopBar clusters={[]} />);
    expect(container.textContent).not.toContain("Ctrl K");
    expect(container.querySelector("b")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    const placeholder = container.querySelector('[aria-hidden="true"]:not(svg)');
    expect(placeholder?.textContent).toBe("pods, deploy, svc, helm…");
  });
  it("error token carries the message", () => {
    render(<TopBar clusters={[{ cluster: cluster(), state: "error", message: "Can't reach this cluster: timeout", failing: 0 }]} />);
    const token = screen.getByTestId("scope-token");
    expect(token.getAttribute("title")).toBe("Can't reach this cluster: timeout");
    expect(token.getAttribute("data-state")).toBe("error");
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
    render(<KindTabs kinds={served} active="pods" count={131} onSelect={onSelect} />);
    const tabs = screen.getAllByRole("tab");
    // StatefulSets, Services, Nodes, Events, Helm releases and Deployments are served; jobs, daemonsets and ingresses aren't.
    expect(tabs.map((t) => t.textContent)).toEqual(["Pods131", "Deployments", "StatefulSets", "Services", "Nodes", "Events", "Helm releases"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    // Ruling R35: no "All {n} kinds" or ":" keycap until the palette (Task 15) opens from them.
    expect(screen.queryByTestId("all-kinds")).toBeNull();
    expect(screen.queryByText(/kinds/)).toBeNull();
    fireEvent.click(tabs[1]);
    expect(onSelect).toHaveBeenCalledWith("deployments.apps");
  });
  it("shows no count while no cluster has reported", () => {
    render(<KindTabs kinds={served} active="deployments.apps" count={null} onSelect={() => {}} />);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Deployments");
  });
  it("before the kinds load, only the active kind; a kind outside the tabs gets its own", () => {
    const { rerender } = render(<KindTabs kinds={undefined} active="pods" count={3} onSelect={() => {}} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Pods3"]);
    rerender(<KindTabs kinds={served} active="certificates.cert-manager.io" count={2} onSelect={() => {}} />);
    expect(screen.getAllByRole("tab").at(-1)!.textContent).toBe("Certificates2");
  });
  it("arrow keys move between tabs, then show the kind they rest on, replacing history", () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      render(<KindTabs kinds={[PODS, DEPLOYMENTS, NODES, EVENTS]} active="deployments.apps" count={4} onSelect={onSelect} />);
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
      expect(onSelect).toHaveBeenCalledWith("pods", { replace: true });
      // A click is a choice of its own: at once, with its own history entry.
      fireEvent.click(screen.getByRole("tab", { name: "Events" }));
      expect(onSelect).toHaveBeenLastCalledWith("events");
    } finally {
      vi.useRealTimers();
    }
  });
  it("says when the kinds can't be loaded, with Retry", () => {
    const onRetry = vi.fn();
    render(<KindTabs kinds={undefined} active="pods" count={3} onSelect={() => {}} error="Can't reach the console's server. Check that it's running, then retry." onRetry={onRetry} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Pods3"]);
    expect(screen.getByRole("alert").textContent).toBe("Can't load the list of kinds: Can't reach the console's server. Check that it's running, then retry.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("FilterBar per kind", () => {
  it("namespace chip filters rows", () => {
    const onChange = vi.fn();
    const value = { status: "failing", text: "api", namespace: null } as const;
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
    expect(onChange).toHaveBeenLastCalledWith({ status: "failing", text: "api", namespace: "payments" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(chip);

    rerender(<FilterBar value={{ ...value, namespace: "payments" }} onChange={onChange} chips={POD_CHIPS} counts={{ failing: 1, pending: 0, restartedToday: 0 }} namespaces={["kube-system", "payments"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Namespace: payments" }));
    expect(screen.getByRole("option", { name: "payments" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: "All namespaces" }));
    expect(onChange).toHaveBeenLastCalledWith({ status: "failing", text: "api", namespace: null });
    rerender(<FilterBar value={value} onChange={onChange} chips={POD_CHIPS} counts={{ failing: 1, pending: 0, restartedToday: 0 }} namespaces={["kube-system", "payments"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Namespace: all" }));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("chips follow the kind; cluster-wide kinds have no namespace chip", () => {
    const { rerender } = render(<FilterBar value={{ status: "all", text: "", namespace: null }} onChange={() => {}} chips={chipsFor(EVENTS)} counts={{ warnings: 3 }} namespaces={["default"]} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Warnings 3", "Namespace: all"]);
    rerender(<FilterBar value={{ status: "all", text: "", namespace: null }} onChange={() => {}} chips={chipsFor(NODES)} counts={{ failing: 0, pending: 1 }} namespaces={null} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Failing 0", "Pending 1"]);
  });
});

describe("FilterBar counts", () => {
  it("chips show no number until a count is real", () => {
    render(<FilterBar value={{ status: "all", text: "", namespace: null }} onChange={() => {}} chips={POD_CHIPS} counts={{}} namespaces={[]} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Failing", "Pending", "Restarted today", "Namespace: all"]);
  });
});

describe("ShortcutBar per kind", () => {
  const strip = () => Array.from(within(screen.getByRole("navigation", { name: "Keyboard shortcuts" })).getAllByRole("listitem")).map((li) => li.textContent);
  it("pod-only keys appear only on pods; every kind opens details", () => {
    const { rerender } = render(<ShortcutBar kind="pods" />);
    expect(strip()).toContain("l logs");
    rerender(<ShortcutBar kind="deployments.apps" />);
    expect(strip()).toEqual(["↑↓ move", "Enter details", "Ctrl F search logs", "Ctrl \\ layout", "/ filter", "? all shortcuts"]);
    fireEvent.click(screen.getByRole("button", { name: /all shortcuts/ }));
    const sheet = screen.getByRole("dialog", { name: "All shortcuts" });
    expect(sheet.textContent).not.toContain("Logs for the selected pod");
    expect(sheet.textContent).toContain("Move between rows");
    expect(within(sheet).getByRole("region", { name: "Details" }).textContent).toContain("Reveal the focused secret key");
  });
});
