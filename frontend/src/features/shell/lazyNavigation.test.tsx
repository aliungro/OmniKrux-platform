import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Shell } from "./Shell";

const gate = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve, delay: false };
});
vi.mock("../audit/AuditView", async importOriginal => {
  if (gate.delay) await gate.promise;
  return importOriginal();
});

vi.mock("../settings/SettingsView", () => { throw new Error("missing settings chunk"); });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps navigation and the new destination's focus while Audit loads", async () => {
  gate.delay = true;
  vi.stubGlobal("fetch", async () => Response.json([]));
  render(<QueryClientProvider client={new QueryClient()}><Shell /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Audit log" }));
  expect(screen.getByText("Loading the audit log…").getAttribute("role")).toBe("status");
  const home = screen.getByRole("button", { name: "Kubernetes" });
  fireEvent.click(home);
  home.focus();
  await act(async () => { gate.resolve(); await vi.dynamicImportSettled(); });
  expect(screen.getByRole("heading", { name: "Where do you want to look?" })).toBeTruthy();
  expect(document.activeElement).toBe(home);
});

it("keeps the rail usable after the Settings import fails", async () => {
  vi.stubGlobal("fetch", async () => Response.json([]));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(<QueryClientProvider client={new QueryClient()}><Shell /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't load settings. Reload the page.");
    fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
    expect(screen.getByRole("heading", { name: "Where do you want to look?" })).toBeTruthy();
  } finally { log.mockRestore(); }
});
