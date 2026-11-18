import { lazy } from "react";
import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ViewBoundary } from "./lazyView";

it("keeps an import failure in the destination and explains how to recover", async () => {
  let reject!: (error: Error) => void;
  const gate = new Promise<{ default: () => null }>((_, fail) => { reject = fail; });
  const View = lazy(() => gate);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(<ViewBoundary label="settings"><View /></ViewBoundary>);
    expect(screen.getByRole("status").textContent).toBe("Loading settings…");
    await act(async () => reject(new Error("chunk missing")));
    expect(screen.getByRole("alert").textContent).toBe("Couldn't load settings. Reload the page.");
  } finally { log.mockRestore(); }
});
