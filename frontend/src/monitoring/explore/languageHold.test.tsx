import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { LinkOut } from "../api/types";
import { linkTo } from "../test/dashboardSeeds";
import { useLanguageHold } from "./languageHold";

type Props = { source: LinkOut | null; expr: string };

describe("the language hold", () => {
  const prom = linkTo("s1");
  const loki = linkTo("l1", "loki");

  it("holds a text when the source's language changes under it, and lets it go when the text fits", () => {
    const { result, rerender } = renderHook((p: Props) => useLanguageHold(p.source, p.expr), { initialProps: { source: null, expr: "up" } as Props });
    // A source arriving (a project loading) is no change of language.
    rerender({ source: prom, expr: "up" });
    expect(result.current.holding).toBe(false);
    rerender({ source: loki, expr: "up" });
    expect(result.current).toMatchObject({ holding: true, held: { expr: "up", from: "PromQL" } });
    // Back to a source of its language.
    rerender({ source: prom, expr: "up" });
    expect(result.current.holding).toBe(false);
    expect(result.current.held).toBeNull();
  });

  it("a new text and a new language in one render hold the new text", () => {
    const { result, rerender } = renderHook((p: Props) => useLanguageHold(p.source, p.expr), { initialProps: { source: prom, expr: "up" } as Props });
    rerender({ source: loki, expr: "up" });
    expect(result.current.held).toEqual({ expr: "up", from: "PromQL" });
    // The old hold is stale (another text), and the new text was written for Loki: it is held now.
    rerender({ source: prom, expr: '{a="b"} |= "x"' });
    expect(result.current).toMatchObject({ holding: true, held: { expr: '{a="b"} |= "x"', from: "LogQL" } });
  });

  it("a text a trail chip brought with its own source is never held, and a pick can hold one itself", () => {
    const { result, rerender } = renderHook((p: Props) => useLanguageHold(p.source, p.expr), { initialProps: { source: prom, expr: "up" } as Props });
    act(() => result.current.bring('{a="b"}'));
    rerender({ source: loki, expr: '{a="b"}' });
    expect(result.current.holding).toBe(false);
    // The pick sets the text and the hold together, as one update.
    act(() => {
      result.current.hold("rate(x[5m])", "PromQL");
      rerender({ source: loki, expr: "rate(x[5m])" });
    });
    expect(result.current).toMatchObject({ holding: true, held: { expr: "rate(x[5m])", from: "PromQL" } });
    // Any other text ends it.
    rerender({ source: loki, expr: "" });
    expect(result.current.held).toBeNull();
  });
});
