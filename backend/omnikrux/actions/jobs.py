"""Jobs: work an apply starts and leaves running on the server (a drain), with progress the
browser polls.

The apply writes the audit record and hands its id to the job; the job finishes it, however it
ends: done, failed, cancelled by the user, or stopped because the console is shutting down
(`close`). A job is kept for an hour after it ends, so the browser can read how it ended."""

import asyncio
import logging
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal, Protocol

from pydantic import BaseModel

from omnikrux.exec.debug import finish_even_if_cancelled

log = logging.getLogger(__name__)

JOB_KEEP_SECONDS = 3600
STOPPED = "The console stopped during the {action}."
REMOVED = "The cluster was removed from OmniKrux, so the {action} stopped."
UNEXPECTED = "The {action} stopped: something unexpected went wrong ({error})."

JobState = Literal["running", "succeeded", "failed", "cancelled"]


class JobOut(BaseModel):
    id: str
    action: str
    state: JobState
    message: str
    total: int
    done: int
    blocked: list[dict]  # what holds the job up now, e.g. pods a PodDisruptionBudget protects
    started_at: datetime
    finished_at: datetime | None


class JobFailed(Exception):
    """The job can't go on; `message` says why in plain words."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class AuditFinisher(Protocol):
    async def finish(self, record_id: int, outcome: str, message: str | None = None) -> bool: ...


@dataclass(kw_only=True)
class Job:
    """One job; its work updates `message`, `total`, `done` and `blocked` as it goes."""

    id: str
    action: str
    actor: str
    audit_id: int
    cancelled_message: str
    message: str = ""
    total: int = 0
    done: int = 0
    blocked: list[dict] = field(default_factory=list)
    state: JobState = "running"
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None
    ended: float | None = None  # the runner's clock when it ended
    cluster_id: str | None = None  # the cluster it works on: removing the cluster stops it
    stop: Literal["cancel", "shutdown", "removed"] | None = None  # why it is being stopped
    ending: bool = False  # its outcome is decided and being written to the audit log
    task: asyncio.Task | None = None

    def out(self) -> JobOut:
        return JobOut(
            id=self.id,
            action=self.action,
            state=self.state,
            message=self.message,
            total=self.total,
            done=self.done,
            blocked=[dict(b) for b in self.blocked],
            started_at=self.started_at,
            finished_at=self.finished_at,
        )


JobWork = Callable[[Job], Awaitable[str]]  # returns the message it ends with


class JobRunner:
    def __init__(
        self,
        audit: AuditFinisher,
        *,
        keep: float = JOB_KEEP_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._audit = audit
        self._keep = keep
        self._clock = clock
        self._jobs: dict[str, Job] = {}
        self._closed = False

    @property
    def closed(self) -> bool:
        """Whether `close` was called: no job can start any more."""
        return self._closed

    def start(
        self,
        action: str,
        fn: JobWork,
        *,
        actor: str,
        audit_id: int,
        cancelled_message: str,
        message: str = "",
        cluster_id: str | None = None,
    ) -> str:
        """Run `fn(job)` in the background; it finishes audit record `audit_id`. Returns the
        job's id. `cancelled_message` is what a cancelled job ends with."""
        if self._closed:
            raise RuntimeError("the job runner is closed")
        self._forget_old()
        job = Job(
            id=secrets.token_urlsafe(16),
            action=action,
            actor=actor,
            audit_id=audit_id,
            cancelled_message=cancelled_message,
            message=message,
            cluster_id=cluster_id,
        )
        self._jobs[job.id] = job
        job.task = asyncio.create_task(self._run(job, fn), name=f"omnikrux-{action}-{job.id}")
        return job.id

    def get(self, job_id: str, *, actor: str | None = None) -> JobOut:
        """The job as it is now; KeyError when unknown, forgotten, or another actor's."""
        return self._job(job_id, actor).out()

    async def cancel(self, job_id: str, *, actor: str | None = None) -> JobOut:
        """Stop a running job and wait until it has ended; a job that already ended is left as
        it is. KeyError when unknown."""
        job = self._job(job_id, actor)
        if job.state == "running" and job.stop is None and not job.ending:
            job.stop = "cancel"
            await self._stop([job])
        return job.out()

    async def stop_cluster(self, cluster_id: str) -> None:
        """The cluster was removed: stop its running jobs and finish their audit records."""
        running = [
            j
            for j in self._jobs.values()
            if j.cluster_id == cluster_id and j.state == "running" and not j.ending
        ]
        for job in running:
            job.stop = job.stop or "removed"
        await self._stop(running)

    async def close(self) -> None:
        """At shutdown: stop every running job and finish its audit record."""
        self._closed = True
        running = [j for j in self._jobs.values() if j.state == "running"]
        for job in running:
            job.stop = job.stop or "shutdown"
        await self._stop(running)

    # --- inside ------------------------------------------------------------------------

    def _job(self, job_id: str, actor: str | None) -> Job:
        self._forget_old()
        job = self._jobs[job_id]
        if actor is not None and job.actor != actor:
            raise KeyError(job_id)
        return job

    def _forget_old(self) -> None:
        now = self._clock()
        for job_id in [
            k for k, j in self._jobs.items() if j.ended is not None and now - j.ended > self._keep
        ]:
            del self._jobs[job_id]

    async def _stop(self, jobs: list[Job]) -> None:
        tasks = [j.task for j in jobs if j.task is not None and not j.task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait(tasks)
        for job in jobs:  # cancelled before it ever ran: its work never saw the cancel
            if not job.ending:
                await self._end(job, *self._stopped(job))

    def _stopped(self, job: Job) -> tuple[JobState, str]:
        if job.stop == "cancel":
            return "cancelled", job.cancelled_message
        if job.stop == "removed":
            return "failed", REMOVED.format(action=job.action)
        return "failed", STOPPED.format(action=job.action)

    async def _run(self, job: Job, fn: JobWork) -> None:
        try:
            message = await fn(job)
            state: JobState = "succeeded"
        except JobFailed as exc:
            state, message = "failed", exc.message
        except asyncio.CancelledError:
            if job.stop is None:  # not ours (the loop is closing): the console is stopping
                job.stop = "shutdown"
            state, message = self._stopped(job)
        except Exception as exc:  # noqa: BLE001 (said in words; logged by type)
            log.warning("The %s job %s stopped (%s)", job.action, job.id, type(exc).__name__)
            state = "failed"
            message = UNEXPECTED.format(action=job.action, error=type(exc).__name__)
        await self._end(job, state, message)

    async def _end(self, job: Job, state: JobState, message: str) -> None:
        """Finish the audit record, then show how the job ended: a job the browser sees as
        ended has its record finished."""
        if job.ending:
            return
        job.ending = True  # from here on a cancel changes nothing
        # A cancelled job's record says it failed: what it set out to do wasn't done.
        outcome = "succeeded" if state == "succeeded" else "failed"
        try:
            await finish_even_if_cancelled(self._audit.finish(job.audit_id, outcome, message))
        finally:
            job.state, job.message = state, message
            job.finished_at = datetime.now(UTC)
            job.ended = self._clock()
