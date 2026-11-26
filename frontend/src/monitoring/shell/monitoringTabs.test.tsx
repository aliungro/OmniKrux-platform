// Monitoring's tab strip: long names are cut with the full name in the title, the tabs scroll in
// their own list with the active one brought into view, and + stays outside that list.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installFakeMonitoringApi } from "../test/fakeMonitoringApi";
import { renderMonitoringApp, seedProject, tabsWith } from "../test/renderMonitoringApp";
import type { MonitoringView } from "./tabState";

const scrollIntoView = Element.prototype.scrollIntoView;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); Element.prototype.scrollIntoView = scrollIntoView; });

const LONG = "Payments platform production cluster in the eastern region with a very long name";
const tablist = () => screen.getByRole("tablist", { name: "Monitoring tabs" });
const tabs = () => within(tablist()).getAllByRole("tab");

describe("Monitoring tab strip", () => {
  it("a long tab name is cut with its full name in the title", async () => {
    installFakeMonitoringApi({ projects: [seedProject("p1", LONG)] });
    renderMonitoringApp({ tabs: tabsWith({ page: "project", id: "p1" }, { page: "home" }) });
    await waitFor(() => expect(tabs()[0].getAttribute("title")).toBe(LONG));
    // The label sits in its own box inside the tab (cut with an ellipsis by CSS); the name stays whole.
    expect(tabs()[0].querySelector("span:not([aria-hidden])")?.textContent).toBe(LONG);
    expect(tabs()[0].textContent).toBe(LONG);
    expect(screen.getByRole("button", { name: `Close ${LONG}` })).toBeTruthy();
    expect(tabs()[1].getAttribute("title")).toBe("Home");
  });

  it("the active tab is scrolled into view and New tab stays visible", async () => {
    const scrolled: { el: Element; opts: unknown }[] = [];
    // jsdom has no layout: twelve tabs are wider than their list, and what asks to be scrolled into view is recorded.
    Element.prototype.scrollIntoView = vi.fn(function (this: Element, opts?: unknown) { scrolled.push({ el: this, opts }); });
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(2400);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(900);
    installFakeMonitoringApi({ projects: [seedProject("p1", LONG)] });
    const views: MonitoringView[] = Array.from({ length: 11 }, () => ({ page: "home" }));
    renderMonitoringApp({ tabs: tabsWith(...views, { page: "project", id: "p1" }) });
    await waitFor(() => expect(tabs()[11].textContent).toBe(LONG));
    expect(tabs()).toHaveLength(12);

    scrolled.length = 0;
    tabs()[11].focus();
    fireEvent.click(tabs()[11]);
    expect(tabs()[11].getAttribute("aria-selected")).toBe("true");
    const last = scrolled[scrolled.length - 1];
    expect(last.el.contains(tabs()[11])).toBe(true);
    expect(last.el.contains(tabs()[10])).toBe(false);
    expect(last.opts).toEqual({ block: "nearest", inline: "nearest" });
    expect(document.activeElement).not.toBe(document.body);

    // + is outside the list that scrolls, so it never scrolls away; a new tab is brought into view too.
    const add = screen.getByRole("button", { name: "New tab" });
    expect(tablist().contains(add)).toBe(false);
    expect(add.parentElement?.contains(tablist())).toBe(true);
    scrolled.length = 0;
    fireEvent.click(add);
    expect(tabs()).toHaveLength(13);
    const opened = tabs().find((t) => t.getAttribute("aria-selected") === "true")!;
    expect(scrolled.some((x) => x.el.contains(opened) && !x.el.contains(tabs()[0]))).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("the active tab is brought into view again when its name changes or the strip resizes", async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this); });
    vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(2400);
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(900);
    const resized: (() => void)[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(private cb: () => void) {}
      observe() { resized.push(this.cb); }
      disconnect() {}
      unobserve() {}
    });
    installFakeMonitoringApi({ projects: [seedProject("p1", LONG)] });
    const views: MonitoringView[] = Array.from({ length: 12 }, () => ({ page: "home" }));
    renderMonitoringApp({ tabs: tabsWith(...views) });
    await waitFor(() => expect(tabs()).toHaveLength(12));
    fireEvent.click(tabs()[11]);
    expect(tabs()[11].getAttribute("aria-selected")).toBe("true");

    // Home opens the long-named project in the same tab: the tab grows and is brought into view.
    scrolled.length = 0;
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${LONG}`) }));
    await waitFor(() => expect(tabs()[11].textContent).toBe(LONG));
    await waitFor(() => expect(scrolled.some((el) => el.contains(tabs()[11]))).toBe(true));
    expect(document.activeElement).not.toBe(document.body);

    // The strip gets narrower (the window shrinks): the active tab is brought into view again.
    scrolled.length = 0;
    expect(resized.length).toBeGreaterThan(0);
    for (const cb of resized) cb();
    expect(scrolled.some((el) => el.contains(tabs()[11]))).toBe(true);
  });

  it("tabs that fit are never scrolled", async () => {
    const calls = vi.fn();
    Element.prototype.scrollIntoView = calls;
    installFakeMonitoringApi({ projects: [seedProject("p1", "Shop")] });
    renderMonitoringApp({ tabs: tabsWith({ page: "home" }, { page: "project", id: "p1" }) });
    await waitFor(() => expect(tabs()[1].textContent).toBe("Shop"));
    fireEvent.click(tabs()[1]);
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(calls).not.toHaveBeenCalled();
  });
});
