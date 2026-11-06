// frontend/src/features/chrome/chrome.test.tsx
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { FilterBar } from "./FilterBar";
import { TopBar } from "./TopBar";
import { KindTabs } from "./KindTabs";

afterEach(cleanup);

describe("FilterBar", () => {
  it("slash focuses the filter, escape clears it", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ status: "all", text: "abc" }} onChange={onChange} counts={{ failing: 2, pending: 1, restartedToday: 4 }} />);
    fireEvent.keyDown(document.body, { key: "/" });
    const input = screen.getByPlaceholderText("Filter by name, namespace or node");
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).toHaveBeenCalledWith({ status: "all", text: "" });
  });
  it("chips show counts and select status", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ status: "all", text: "" }} onChange={onChange} counts={{ failing: 2, pending: 1, restartedToday: 4 }} />);
    fireEvent.click(screen.getByRole("button", { name: /Failing 2/ }));
    expect(onChange).toHaveBeenCalledWith({ status: "failing", text: "" });
  });
});

describe("FilterBar details", () => {
  const counts = { failing: 2, pending: 1, restartedToday: 4 };
  it("escape blurs the filter", () => {
    render(<FilterBar value={{ status: "all", text: "abc" }} onChange={() => {}} counts={counts} />);
    const input = screen.getByPlaceholderText("Filter by name, namespace or node");
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);
  });
  it("slash is ignored while typing in another field", () => {
    render(<><input aria-label="other" /><FilterBar value={{ status: "all", text: "" }} onChange={() => {}} counts={counts} /></>);
    const other = screen.getByLabelText("other");
    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(document.activeElement).toBe(other);
  });
  it("marks the active chip and keeps the text when switching status", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ status: "pending", text: "pay" }} onChange={onChange} counts={counts} />);
    expect(screen.getByRole("button", { name: "Pending 1" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Restarted today 4" }));
    expect(onChange).toHaveBeenCalledWith({ status: "restartedToday", text: "pay" });
  });
  it("typing updates the text", () => {
    const onChange = vi.fn();
    render(<FilterBar value={{ status: "failing", text: "" }} onChange={onChange} counts={counts} />);
    fireEvent.change(screen.getByPlaceholderText("Filter by name, namespace or node"), { target: { value: "api" } });
    expect(onChange).toHaveBeenCalledWith({ status: "failing", text: "api" });
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
  it("shows only pods with the live count", () => {
    render(<KindTabs active="pods" counts={{ pods: 131 }} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0].textContent).toBe("Pods131");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });
  it("shows no count while no cluster has reported", () => {
    render(<KindTabs active="pods" counts={{ pods: null }} />);
    expect(screen.getByRole("tab").textContent).toBe("Pods");
  });
});
