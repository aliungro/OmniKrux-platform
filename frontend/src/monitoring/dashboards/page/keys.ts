// Which key presses the dashboard page may take.
import { pageKey } from "../../../features/chrome/shortcuts";

/** Letter keys belong to the page only outside fields, dialogs and the page's own menus and pickers. */
export function pageLetter(e: KeyboardEvent): boolean {
  if (!pageKey(e)) return false;
  const t = e.target;
  return !(t instanceof Element && t.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-dashboard-popup]'));
}
