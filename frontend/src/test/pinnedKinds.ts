import { act, fireEvent, screen } from "@testing-library/react";

/** A pinned-kind row in Settings, found by its accessible name ("Pods, position 1 of 11"). */
export function pinnedRow(title: string): HTMLElement {
  return screen.getByRole("listitem", { name: new RegExp(`^${title}, position \\d+ of \\d+$`) });
}

/** Removes a pinned kind the keyboard way: focus its row, Enter for its menu, then Remove. */
export function removePinned(title: string): void {
  const row = pinnedRow(title);
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "Enter" });
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
}
