"""The job runner: work an apply leaves running on the server (a drain), which the browser polls
and may cancel. Every way a job ends finishes its audit record, the console stopping included."""

import asyncio
from contextlib import AsyncExitStack

import httpx
import pytest

from omnikrux.actions import nodes
from omnikrux.actions.jobs import REMOVED, JobFailed, JobRunner
from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.main import create_app
from tests.actions.clusters import kubeconfig_named
from tests.actions.test_nodes import node, pod
from tests.fakekube import serve_fake_api


class FakeAudit:
    def __init__(self) -> None:
        self.finished: list[tuple[int, str, str | None]] = []

    async def finish(self, record_id: int, outcome: str, message: str | None = None) -> bool:
        self.finished.append((record_id, outcome, message))
        return True


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def settle(runner: JobRunner, job_id: str) -> None:
    for _ in range(100):
        if runner.get(job_id).state != "running":
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the job never ended")


async def test_job_progress_and_outcomes_finish_the_audit_record():
    audit = FakeAudit()
    runner = JobRunner(audit)
    gate = asyncio.Event()

    async def work(job):
        job.total = 2
        job.done = 1
        await gate.wait()
        job.done = 2
        return "All done."

    job_id = runner.start("drain", work, actor="local", audit_id=7, cancelled_message="Stopped.")
    await asyncio.sleep(0)
    running = runner.get(job_id)
    assert (running.state, running.total, running.done, running.finished_at) == (
        "running",
        2,
        1,
        None,
    )
    assert audit.finished == []

    gate.set()
    await settle(runner, job_id)
    out = runner.get(job_id)
    assert (out.state, out.message, out.done) == ("succeeded", "All done.", 2)
    assert out.finished_at is not None and out.started_at <= out.finished_at
    assert audit.finished == [(7, "succeeded", "All done.")]

    async def fails(job):
        raise JobFailed("It didn't work: here is why.")

    job_id = runner.start("drain", fails, actor="local", audit_id=8, cancelled_message="x")
    await settle(runner, job_id)
    assert runner.get(job_id).message == "It didn't work: here is why."
    assert audit.finished[-1] == (8, "failed", "It didn't work: here is why.")

    async def breaks(job):
        raise RuntimeError("secret internals")

    job_id = runner.start("drain", breaks, actor="local", audit_id=9, cancelled_message="x")
    await settle(runner, job_id)
    out = runner.get(job_id)
    assert out.state == "failed" and "secret internals" not in out.message
    assert out.message == "The drain stopped: something unexpected went wrong (RuntimeError)."
    assert audit.finished[-1] == (9, "failed", out.message)
    await runner.close()


async def test_cancel_and_close():
    audit = FakeAudit()
    runner = JobRunner(audit)

    async def forever(job):
        await asyncio.Event().wait()

    job_id = runner.start("drain", forever, actor="local", audit_id=1, cancelled_message="Bye.")
    await asyncio.sleep(0)
    out = await runner.cancel(job_id)
    assert (out.state, out.message) == ("cancelled", "Bye.")
    assert audit.finished == [(1, "failed", "Bye.")]
    assert (await runner.cancel(job_id)).state == "cancelled"  # again: nothing changes
    assert audit.finished == [(1, "failed", "Bye.")]

    other = runner.start("drain", forever, actor="local", audit_id=2, cancelled_message="Bye.")
    await asyncio.sleep(0)
    await runner.close()
    out = runner.get(other)
    assert (out.state, out.message) == ("failed", "The console stopped during the drain.")
    assert audit.finished[-1] == (2, "failed", "The console stopped during the drain.")
    with pytest.raises(RuntimeError):
        runner.start("drain", forever, actor="local", audit_id=3, cancelled_message="Bye.")


async def test_jobs_are_kept_an_hour_after_they_finish_and_only_for_their_actor():
    clock = Clock()
    runner = JobRunner(FakeAudit(), clock=clock)

    async def quick(job):
        return "Done."

    job_id = runner.start("drain", quick, actor="local", audit_id=1, cancelled_message="x")
    await settle(runner, job_id)
    with pytest.raises(KeyError):
        runner.get(job_id, actor="someone-else")
    with pytest.raises(KeyError):
        runner.get("unknown")

    clock.now += 3599
    assert runner.get(job_id).state == "succeeded"
    clock.now += 2
    with pytest.raises(KeyError):
        runner.get(job_id)
    await runner.close()


async def test_jobs_cancelled_on_shutdown_marked_in_audit(tmp_path, monkeypatch):
    monkeypatch.setattr(nodes, "RETRY_SECONDS", 0.01)
    settings = Settings(
        data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False
    )
    async with serve_fake_api() as fake:
        fake.objects["nodes"][("", "worker")] = node()
        fake.pods.clear()
        fake.pods[("demo", "guarded-1")] = pod("guarded-1")
        fake.evictions[("demo", "guarded-1")] = [429]  # the drain never finishes by itself
        app = create_app(settings)
        async with AsyncExitStack() as stack:
            await stack.enter_async_context(app.router.lifespan_context(app))
            [info] = await app.state.registry.upsert_from_kubeconfig(
                kubeconfig_named(fake, "dev-a"), rewrite_loopback=False, source=SOURCE_UPLOAD
            )
            client = await stack.enter_async_context(
                httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://testserver"
                )
            )
            target = {"cluster_id": info.id, "kind_key": "nodes", "name": "worker"}
            r = await client.post("/api/actions/plan", json={"action": "drain", "target": target})
            assert r.status_code == 200, r.text
            r = await client.post(
                f"/api/actions/{r.json()['plan_id']}/apply", json={"confirm_text": "worker"}
            )
            assert r.status_code == 200, r.text
            job_id = r.json()["job_id"]
            while not fake.eviction_requests:
                await asyncio.sleep(0.01)
        # The app stopped with the drain still running.
        out = app.state.jobs.get(job_id)
        assert (out.state, out.message) == ("failed", "The console stopped during the drain.")
        tries = len(fake.eviction_requests)
        await asyncio.sleep(0.05)
        assert len(fake.eviction_requests) == tries

    # The next start finds the record finished, not left open.
    again = create_app(settings)
    async with again.router.lifespan_context(again):
        [record] = (await again.state.audit.list()).records
    assert (record.action, record.outcome) == ("drain", "failed")
    assert record.message == "The console stopped during the drain."


async def test_stop_cluster_ends_only_that_clusters_jobs():
    audit = FakeAudit()
    runner = JobRunner(audit)
    gate = asyncio.Event()

    async def work(job):
        await gate.wait()
        return "All done."

    removed = runner.start(
        "drain", work, actor="local", audit_id=1, cancelled_message="Stopped.", cluster_id="c1"
    )
    other = runner.start(
        "drain", work, actor="local", audit_id=2, cancelled_message="Stopped.", cluster_id="c2"
    )
    await asyncio.sleep(0)
    await runner.stop_cluster("c1")
    out = runner.get(removed)
    assert (out.state, out.message) == ("failed", REMOVED.format(action="drain"))
    assert audit.finished == [(1, "failed", REMOVED.format(action="drain"))]
    assert runner.get(other).state == "running"
    gate.set()
    await settle(runner, other)
    assert runner.get(other).state == "succeeded"


async def test_removing_a_cluster_stops_its_drain(tmp_path, monkeypatch):
    monkeypatch.setattr(nodes, "RETRY_SECONDS", 0.01)
    settings = Settings(
        data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False
    )
    async with serve_fake_api() as fake:
        fake.objects["nodes"][("", "worker")] = node()
        fake.pods.clear()
        fake.pods[("demo", "guarded-1")] = pod("guarded-1")
        fake.evictions[("demo", "guarded-1")] = [429]  # the drain never finishes by itself
        app = create_app(settings)
        async with AsyncExitStack() as stack:
            await stack.enter_async_context(app.router.lifespan_context(app))
            [info] = await app.state.registry.upsert_from_kubeconfig(
                kubeconfig_named(fake, "dev-a"), rewrite_loopback=False, source=SOURCE_UPLOAD
            )
            client = await stack.enter_async_context(
                httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://testserver"
                )
            )
            target = {"cluster_id": info.id, "kind_key": "nodes", "name": "worker"}
            r = await client.post("/api/actions/plan", json={"action": "drain", "target": target})
            r = await client.post(
                f"/api/actions/{r.json()['plan_id']}/apply", json={"confirm_text": "worker"}
            )
            job_id = r.json()["job_id"]
            while not fake.eviction_requests:
                await asyncio.sleep(0.01)
            assert (await client.delete(f"/api/clusters/{info.id}")).status_code == 204
            out = app.state.jobs.get(job_id)
            assert (out.state, out.message) == ("failed", REMOVED.format(action="drain"))
            tries = len(fake.eviction_requests)
            await asyncio.sleep(0.05)
            assert len(fake.eviction_requests) == tries
