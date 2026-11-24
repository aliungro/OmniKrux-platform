// The uninstall review's one choice: whether the stored data goes too. Off unless asked for; a
// change plans the review again (so the review's lines say what will be removed). If planning fails
// the dialog says why and the box goes back to what the review on screen is.

import { useState } from "react";
import s from "./UninstallOptions.module.css";

export function UninstallOptions({ checked, busy, onChange }: { checked: boolean; busy: boolean; onChange(next: boolean): Promise<boolean> }) {
  const [shown, setShown] = useState(checked);
  const [was, setWas] = useState(checked);
  // A new review brought another answer (or the dialog re-rendered with it): follow it.
  if (was !== checked) {
    setWas(checked);
    setShown(checked);
  }
  return (
    <label className={s.option}>
      <input
        type="checkbox"
        checked={shown}
        aria-disabled={busy || undefined}
        onChange={(e) => {
          // While a review is being made the box keeps the keyboard but takes no change.
          if (busy) return;
          const next = e.target.checked;
          setShown(next);
          void onChange(next).then((ok) => { if (!ok) setShown(!next); });
        }}
      />
      <span>Also delete the stored data (metrics, logs and alerts history on the volumes)</span>
    </label>
  );
}
