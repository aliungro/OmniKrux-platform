// Two dashboard documents side by side, the older on the left. CodeMirror's merge view loads with
// the first diff (the kit stays out of the startup bundle). Reused by Review changes and Versions.
import { useEffect, useRef, useState } from "react";
import { loadCodeMirror } from "../../features/actions/lazyCodeMirror";
import s from "./JsonDiff.module.css";

export const JSON_DIFF_LOADING = "Loading the diff…";
export const JSON_DIFF_FAILED = "Couldn't load the diff. Reload the page to see it.";

export function JsonDiff({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let mounted: { destroy(): void } | null = null;
    let gone = false;
    setState("loading");
    loadCodeMirror().then(
      (cm) => {
        if (gone || !host.current) return;
        mounted = cm.mergeView(host.current, before, after);
        setState("ready");
      },
      () => { if (!gone) setState("failed"); },
    );
    return () => {
      gone = true;
      mounted?.destroy();
    };
  }, [before, after]);

  return (
    <figure className={s.diff} aria-label={`${beforeLabel} and ${afterLabel}`}>
      <div className={s.heads}>
        <span className={s.head}>{beforeLabel}</span>
        <span className={s.head}>{afterLabel}</span>
      </div>
      {state === "loading" && <p className={s.note} role="status">{JSON_DIFF_LOADING}</p>}
      {state === "failed" && <p className={`${s.note} ${s.bad}`} role="alert">{JSON_DIFF_FAILED}</p>}
      <div ref={host} className={s.view} hidden={state !== "ready"} />
    </figure>
  );
}
