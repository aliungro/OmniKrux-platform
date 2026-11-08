import { useEffect, useRef, useState } from "react";
import { loadCodeMirror } from "./lazyCodeMirror";
import s from "./DiffView.module.css";

export const DIFF_UNAVAILABLE = "Couldn't load the diff. Reload the page to see it.";

/**
 * The change as the server rendered it (a Secret's values already masked there), before on the
 * left and after on the right, read-only. CodeMirror loads with the first diff.
 */
export function DiffView({ before, after }: { before: string; after: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let mounted: { destroy: () => void } | null = null;
    let gone = false;
    setState("loading");
    loadCodeMirror().then(
      (cm) => {
        if (gone || !host.current) return;
        mounted = cm.mergeView(host.current, before, after);
        setState("ready");
      },
      () => {
        if (!gone) setState("failed");
      },
    );
    return () => {
      gone = true;
      mounted?.destroy();
    };
  }, [before, after]);

  return (
    <figure className={s.diff} aria-label="Changes">
      <div className={s.heads} aria-hidden="true">
        <span>Now</span>
        <span>After the change</span>
      </div>
      {state === "loading" && <p className={s.note} role="status">Loading the diff…</p>}
      {state === "failed" && <p className={`${s.note} ${s.bad}`} role="alert">{DIFF_UNAVAILABLE}</p>}
      <div ref={host} className={`${s.view} mono`} hidden={state !== "ready"} />
    </figure>
  );
}
