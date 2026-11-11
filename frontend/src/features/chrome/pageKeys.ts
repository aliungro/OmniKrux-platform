import { isEditable } from "./shortcuts";

/** The page and its chrome hand row keys to the table; nested keyboard owners keep theirs. */
export function routesPageKeys(target: EventTarget | null): boolean {
  if (target === null || target === document.body || target === document.documentElement) return true;
  if (!(target instanceof Element) || isEditable(target)) return false;
  if (target.closest('[role="grid"], [role="dialog"], dialog, [role="listbox"], [role="menu"]')) return false;
  const owner = target.closest("[data-page-keys]");
  return owner !== null && owner.getAttribute("data-page-keys") !== "off";
}

/** Kind arrows also work on a focused resource row that opts in from the console. */
export function routesKindKeys(target: EventTarget | null): boolean {
  if (target instanceof Element) {
    if (target.matches("[data-row-key]") && target.closest("[data-kind-row-keys]")) return true;
    if (target.closest('button, a[href], summary, [role="tablist"], [role="tab"], [role="toolbar"], [role="combobox"], [role="slider"], [role="tree"]')) return false;
  }
  return routesPageKeys(target);
}

/** Give focus back to the visible table's selected row, or its first row before a selection. */
export function focusTableRow(): boolean {
  const row = document.querySelector<HTMLElement>('[role="grid"] [data-row-key][tabindex="0"]');
  if (row === null) return false;
  row.focus({ preventScroll: true });
  return true;
}
