import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AllShortcuts } from "./ShortcutBar";
import { CommandPalette } from "../palette/CommandPalette";
import { onDialogOpened, onLastDialogClosed, registerDialogRoot } from "./dialogLifecycle";

afterEach(cleanup);
const flush = () => act(async () => { await Promise.resolve(); });
const help = <AllShortcuts groups={[]} onClose={() => {}} />;
const palette = <CommandPalette mode="all" kinds={[]} selection={null} onKind={() => {}}
  onAudit={() => {}} onClose={() => {}} onRowAction={() => {}} />;

it("strict mode replay does not announce a closed dialog", async () => {
  const closed = vi.fn();
  const stop = onLastDialogClosed(closed);
  const view = render(<StrictMode>{help}</StrictMode>);
  await flush();
  expect(closed).not.toHaveBeenCalled();
  view.unmount();
  await flush();
  expect(closed).toHaveBeenCalledTimes(1);
  stop();
});

it("closing an inner modal waits for the last modal", async () => {
  const closed = vi.fn();
  const stop = onLastDialogClosed(closed);
  const view = render(<>{help}{palette}</>);
  view.rerender(<>{help}</>);
  await flush();
  expect(closed).not.toHaveBeenCalled();
  view.unmount();
  await flush();
  expect(closed).toHaveBeenCalledTimes(1);
  stop();
});

it("replacing a modal does not release pending focus", async () => {
  const closed = vi.fn();
  const opened = vi.fn();
  const stop = onLastDialogClosed(closed);
  const stopOpen = onDialogOpened(opened);
  const view = render(help);
  view.rerender(palette);
  await flush();
  expect(opened).toHaveBeenCalledTimes(2);
  expect(closed).not.toHaveBeenCalled();
  view.unmount();
  await flush();
  expect(closed).toHaveBeenCalledTimes(1);
  stop();
  stopOpen();
  const release = registerDialogRoot(document.createElement("div"));
  release();
  release();
  await flush();
  expect(opened).toHaveBeenCalledTimes(2);
  expect(closed).toHaveBeenCalledTimes(1);
});

it("delivers the close after the palette fallback restores focus", async () => {
  const outside = document.createElement("button");
  document.body.append(outside);
  const closed = vi.fn(() => document.activeElement);
  const stop = onLastDialogClosed(closed);
  const view = render(<CommandPalette mode="all" kinds={[]} selection={null} onKind={() => {}}
    onAudit={() => {}} onClose={() => {}} onRowAction={() => {}}
    onFocusLost={() => queueMicrotask(() => outside.focus())} />);
  view.unmount();
  await flush();
  expect(closed).toHaveReturnedWith(outside);
  stop();
  outside.remove();
});
