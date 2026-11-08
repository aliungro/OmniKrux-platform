import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure, HttpError } from "../../api/http";
import { cancelJob, invalidateAfterChange, useJob, type ActionOutcome } from "./useActions";
import s from "./DrainProgress.module.css";

/** Said after the server's own words when it no longer knows the job (jobs live in its memory). */
export const LOST = "How the drain ended isn't known here: check the audit log.";

/**
 * A drain as it runs on the server: how many pods are evicted, which ones a PodDisruptionBudget
 * holds up for now, and Cancel. It ends with the job's own message. Numbers are shown only from the
 * latest answer: a failed poll says so instead (and keeps asking), and a job the server no longer
 * knows says its outcome is unknown here. Closing this leaves the drain running; the audit log
 * records how it ends. `onOutcome` hears how it ended, for the details once the dialog closes.
 */
export function DrainProgress({
  jobId,
  onClose,
  onOutcome,
}: {
  jobId: string;
  onClose: () => void;
  onOutcome?: (outcome: ActionOutcome | null) => void;
}) {
  const queryClient = useQueryClient();
  const job = useJob(jobId);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => closeRef.current?.focus(), []);

  const cancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      const out = await cancelJob(jobId);
      // A poll still on its way would show the job running again: drop it, keep how it ended.
      await queryClient.cancelQueries({ queryKey: ["action-job", jobId] });
      queryClient.setQueryData(["action-job", jobId], out);
    } catch (err) {
      setCancelError(failure(err));
    } finally {
      setCancelling(false);
    }
  };

  const gone = job.isError && job.error instanceof HttpError && job.error.status === 404;
  const pollFailed = job.isError && !gone;
  // The last answer is shown only while it is the latest: never old numbers as live.
  const data = job.isError ? undefined : job.data;
  // Running as far as anyone knows: not lost, and the last answer (if any) said so.
  const running = !gone && (job.data === undefined || job.data.state === "running");
  const share = data && data.total > 0 ? data.done / data.total : running ? 0 : 1;
  const lostMessage = gone ? `${failure(job.error)} ${LOST}` : null;

  // Once it has ended: the audit log and the node's details have news; the dialog hears how.
  const endedOnce = useRef(false);
  useEffect(() => {
    if (running || endedOnce.current) return;
    endedOnce.current = true;
    invalidateAfterChange(queryClient);
  }, [running, queryClient]);
  useEffect(() => {
    if (lostMessage !== null) onOutcome?.({ message: lostMessage, tone: "warn" });
    else if (data && data.state !== "running") onOutcome?.({ message: data.message, tone: data.state === "succeeded" ? "ok" : "warn" });
  }, [lostMessage, data, onOutcome]);

  let shown;
  if (gone) {
    shown = <p className={s.end} data-tone="bad" role="alert">{lostMessage}</p>;
  } else if (pollFailed) {
    shown = (
      <p className={s.end} data-tone="bad" role="alert">
        Can't read the drain's progress: {failure(job.error)} Trying again…
      </p>
    );
  } else if (data === undefined) {
    shown = <p className={s.count} role="status">Starting the drain…</p>;
  } else {
    shown = (
      <>
        <p className={s.count} role="status">
          {data.done} of {data.total} pods evicted
        </p>
        <div className={s.track} aria-hidden="true">
          <i className={s.fill} data-state={data.state} style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
        {data.blocked.length > 0 && (
          <ul className={s.blocked} aria-label="Waiting for">
            {data.blocked.map((b) => (
              <li key={`${b.namespace}/${b.name}`}>
                <span className={s.pod}>{`${b.namespace}/${b.name}`}</span>
                <span className={s.why}>{b.message}</span>
              </li>
            ))}
          </ul>
        )}
        {!running && (
          <p className={s.end} data-tone={data.state === "succeeded" ? "ok" : "bad"} role="status">
            {data.message}
          </p>
        )}
      </>
    );
  }

  return (
    <div className={s.progress}>
      {shown}
      {cancelError && <p className={s.error} role="alert">{cancelError}</p>}
      <div className={s.actions}>
        {running && <span className={s.note}>The drain carries on if you close this.</span>}
        {running && job.data !== undefined && (
          <button type="button" className={`${s.btn} ${s.danger}`} onClick={() => void cancel()} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel drain"}
          </button>
        )}
        <button ref={closeRef} type="button" className={s.btn} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
