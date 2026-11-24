// An install or uninstall as it runs on the server: the step it is on (the job's own words), a bar
// of the steps done, what it waits for, Cancel (asked first) and Close. It is shown in the review
// dialog once the apply started the job, and the job carries on if the dialog closes.
//
// Honest state only. Numbers come from the latest answer: a failed poll says so instead (and keeps
// asking, a little slower each time), a job the server no longer knows reads as unknown with a
// pointer to Monitoring tools and Audit. The job id comes back with the apply a moment before the
// jobs endpoint knows it, so a 404 in the first few seconds reads as starting. Polling stops when
// the job ends and when this closes.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { failure, getJson, HttpError } from "../../api/http";
import type { Job } from "../../api/types";
import { cancelJob, JOB_POLL_MS, type ActionOutcome } from "../../features/actions/useActions";
import s from "./InstallProgress.module.css";

/** How long a just-started job may be unknown to the jobs endpoint before that means it's lost. */
export const START_GRACE_MS = 5000;
/** The slowest a failing poll asks again. */
const MAX_RETRY_MS = 8000;

export type InstallJobState = "running" | Job["state"] | "lost";

const jobKey = (jobId: string) => ["install-job", jobId] as const;

/** Said after the server's own words when it no longer knows the job (jobs live in its memory). */
export const LOST = "How it ended isn't known here: check Monitoring tools and Audit.";

const COPY = {
  install: {
    starting: "Starting the install…",
    carriesOn: "The install carries on if you close this. Follow it on Monitoring tools.",
    cancel: "Cancel install",
    ask: "Stop the install? What Helm already applied stays.",
    stop: "Stop install",
    stopping: "Stopping the install…",
  },
  uninstall: {
    starting: "Starting the uninstall…",
    carriesOn: "The uninstall carries on if you close this.",
    cancel: "Cancel uninstall",
    ask: "Stop the uninstall? What was already removed stays removed.",
    stop: "Stop uninstall",
    stopping: "Stopping the uninstall…",
  },
} as const;

export function InstallProgress({
  jobId,
  action,
  onClose,
  onOutcome,
  onState,
}: {
  jobId: string;
  action: "install" | "uninstall";
  onClose(): void;
  onOutcome(o: ActionOutcome | null): void;
  /** Hears where the job stands (for whoever opened the review: how to say it ended). */
  onState?(state: InstallJobState): void;
}) {
  const id = useId();
  const copy = COPY[action];
  const queryClient = useQueryClient();
  const openedAt = useRef(Date.now());
  const job = useQuery<Job | null>({
    queryKey: jobKey(jobId),
    queryFn: async () => {
      try {
        return await getJson<Job>(`/api/actions/jobs/${encodeURIComponent(jobId)}`);
      } catch (err) {
        // Not known yet: the job was handed out a moment before the jobs endpoint has it.
        if (err instanceof HttpError && err.status === 404 && Date.now() - openedAt.current < START_GRACE_MS) return null;
        throw err;
      }
    },
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => {
      const { data, error, fetchFailureCount } = query.state;
      if (error instanceof HttpError && error.status === 404) return false; // forgotten: nothing to wait for
      if (error) return Math.min(JOB_POLL_MS * 2 ** Math.max(0, fetchFailureCount - 1), MAX_RETRY_MS);
      return data === undefined || data === null || data.state === "running" ? JOB_POLL_MS : false;
    },
  });

  const [asking, setAsking] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    closeRef.current?.focus();
    return () => { alive.current = false; };
  }, []);

  const gone = job.isError && job.error instanceof HttpError && job.error.status === 404;
  const pollFailed = job.isError && !gone;
  // The last answer is shown only while it is the latest: never old numbers as live.
  const data = job.isError ? undefined : job.data ?? undefined;
  const known = job.data ?? undefined;
  const running = !gone && (known === undefined || known.state === "running");
  const lostMessage = gone ? `${failure(job.error)} ${LOST}` : null;
  const state: InstallJobState = gone ? "lost" : known === undefined ? "running" : known.state;

  useEffect(() => { onState?.(state); }, [state, onState]);
  useEffect(() => {
    if (lostMessage !== null) onOutcome({ message: lostMessage, tone: "warn" });
    else if (known && known.state !== "running") onOutcome({ message: known.message, tone: known.state === "succeeded" ? "ok" : "warn" });
  }, [lostMessage, known, onOutcome]);

  // Once it has ended: the tools page and the audit log have news.
  const endedOnce = useRef(false);
  useEffect(() => {
    if (running || endedOnce.current) return;
    endedOnce.current = true;
    void queryClient.invalidateQueries({ queryKey: ["monitoring", "install"] });
    void queryClient.invalidateQueries({ queryKey: ["audit"] });
  }, [running, queryClient]);

  // What held the keyboard may have gone with the job's end (Cancel, the question): Close takes it.
  useEffect(() => {
    if (running) return;
    setAsking(false);
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) closeRef.current?.focus();
  }, [running]);

  const ask = () => {
    setCancelError(null);
    setAsking(true);
    queueMicrotask(() => keepRef.current?.focus());
  };
  const keepGoing = () => {
    setAsking(false);
    queueMicrotask(() => (cancelRef.current ?? closeRef.current)?.focus());
  };
  // Esc in the question answers "Keep going"; it never closes the dialog from there.
  const onAskKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    keepGoing();
  };

  const stop = async () => {
    setAsking(false);
    setStopping(true);
    setCancelError(null);
    // The buttons of the question go away: the keyboard waits on Close meanwhile.
    closeRef.current?.focus();
    try {
      // No time limit here: the server waits for Helm to stop (up to its grace) before it answers.
      const out = await cancelJob(jobId);
      // A poll still on its way would show the job running again: drop it, keep how it ended.
      await queryClient.cancelQueries({ queryKey: jobKey(jobId) });
      queryClient.setQueryData(jobKey(jobId), out);
    } catch (err) {
      if (alive.current) setCancelError(failure(err));
    } finally {
      if (alive.current) setStopping(false);
    }
  };

  let shown;
  if (gone) {
    shown = <p className={s.end} data-tone="bad" role="alert">{lostMessage}</p>;
  } else if (pollFailed) {
    shown = (
      <p className={s.end} data-tone="bad" role="alert">
        Can't read the progress: {failure(job.error)} Trying again…
      </p>
    );
  } else if (data === undefined) {
    shown = <p className={s.step} role="status">{copy.starting}</p>;
  } else {
    const share = data.total > 0 ? Math.min(1, data.done / data.total) : data.state === "running" ? 0 : 1;
    shown = (
      <>
        {data.state === "running" ? (
          <p className={s.step} role="status">{data.message}</p>
        ) : (
          <p className={s.end} data-tone={data.state === "succeeded" ? "ok" : "bad"} role="status">{data.message}</p>
        )}
        <div className={s.meter}>
          <div
            className={s.track}
            role="progressbar"
            aria-labelledby={`${id}-count`}
            aria-valuemin={0}
            aria-valuemax={data.total}
            aria-valuenow={data.done}
          >
            <i className={s.fill} data-state={data.state} style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
          <span id={`${id}-count`} className={s.count}>{data.done} of {data.total}</span>
        </div>
        {data.state === "running" && data.blocked.length > 0 && (
          <ul className={s.blocked} aria-label="Waiting for">
            {data.blocked.map((b) => (
              <li key={`${b.namespace}/${b.name}`}>
                <span className={s.what}>{b.name}</span>
                <span className={s.why}>{b.message}</span>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  // Cancel is offered once the job is known to be running here (not while starting or unreadable).
  const canCancel = running && data !== undefined;
  return (
    <div className={s.progress}>
      {shown}
      {stopping && <p className={s.stopping} role="status">{copy.stopping}</p>}
      {cancelError && <p className={s.error} role="alert">{cancelError}</p>}
      {asking && canCancel && !stopping && (
        <div className={s.ask} role="group" aria-labelledby={`${id}-ask`} onKeyDown={onAskKey}>
          <p id={`${id}-ask`} className={s.question}>{copy.ask}</p>
          <div className={s.askActions}>
            <button ref={keepRef} type="button" className={s.btn} onClick={keepGoing}>Keep going</button>
            <button type="button" className={`${s.btn} ${s.danger}`} onClick={() => void stop()}>{copy.stop}</button>
          </div>
        </div>
      )}
      <div className={s.actions}>
        {running && <span className={s.note}>{copy.carriesOn}</span>}
        {canCancel && !asking && !stopping && (
          <button ref={cancelRef} type="button" className={`${s.btn} ${s.quietDanger}`} onClick={ask}>
            {copy.cancel}
          </button>
        )}
        <button ref={closeRef} type="button" className={s.btn} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
