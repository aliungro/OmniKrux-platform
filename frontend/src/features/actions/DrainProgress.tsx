import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { failure } from "../../api/http";
import { cancelJob, useJob } from "./useActions";
import s from "./DrainProgress.module.css";

/**
 * A drain as it runs on the server: how many pods are evicted, which ones a PodDisruptionBudget
 * holds up for now, and Cancel. It ends with the job's own message. Closing this leaves the
 * drain running; the audit log records how it ends.
 */
export function DrainProgress({ jobId, onClose }: { jobId: string; onClose: () => void }) {
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
      const ended = await cancelJob(jobId);
      // A poll still on its way would show the job running again: drop it, keep how it ended.
      await queryClient.cancelQueries({ queryKey: ["action-job", jobId] });
      queryClient.setQueryData(["action-job", jobId], ended);
    } catch (err) {
      setCancelError(failure(err));
    } finally {
      setCancelling(false);
    }
  };

  const data = job.data;
  const running = data === undefined || data.state === "running";
  const share = data && data.total > 0 ? data.done / data.total : running ? 0 : 1;

  return (
    <div className={s.progress}>
      {data === undefined ? (
        <p className={s.count} role="status">{job.isError ? failure(job.error) : "Starting the drain…"}</p>
      ) : (
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
      )}
      {cancelError && <p className={s.error} role="alert">{cancelError}</p>}
      <div className={s.actions}>
        {running && <span className={s.note}>The drain carries on if you close this.</span>}
        {running && data !== undefined && (
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
