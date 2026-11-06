"""The shared fake Kubernetes API: the routes later tasks rely on."""

import asyncio
import json

import aiohttp

POD = {
    "metadata": {"name": "web-1", "namespace": "demo", "uid": "u-web-1"},
    "spec": {"containers": [{"name": "app"}]},
    "status": {"phase": "Running"},
}


async def get(server, path, **params):
    async with (
        aiohttp.ClientSession() as session,
        session.get(server.url + path, params=params) as resp,
    ):
        return resp.status, await resp.text()


async def test_pod_get_and_events(fake_api):
    fake_api.pods[("demo", "web-1")] = POD
    fake_api.events.extend(
        [
            {"metadata": {"name": "e1"}, "involvedObject": {"uid": "u-web-1"}, "reason": "Pulled"},
            {"metadata": {"name": "e2"}, "involvedObject": {"uid": "other"}, "reason": "Killing"},
        ]
    )
    status, text = await get(fake_api, "/api/v1/namespaces/demo/pods/web-1")
    assert status == 200 and '"web-1"' in text
    status, _ = await get(fake_api, "/api/v1/namespaces/demo/pods/missing")
    assert status == 404
    status, text = await get(
        fake_api,
        "/api/v1/namespaces/demo/events",
        fieldSelector="involvedObject.uid=u-web-1",
    )
    assert status == 200
    assert [e["reason"] for e in json.loads(text)["items"]] == ["Pulled"]


async def test_logs_follow_streams_until_none(fake_api):
    fake_api.pods[("demo", "web-1")] = POD
    for line in ("one", "two", "three", None):
        fake_api.follow_lines.put_nowait(line)
    status, text = await asyncio.wait_for(
        get(
            fake_api,
            "/api/v1/namespaces/demo/pods/web-1/log",
            container="app",
            follow="true",
        ),
        5,
    )
    assert status == 200
    assert text.splitlines() == ["one", "two", "three"]


async def test_previous_logs_are_separate(fake_api):
    fake_api.pods[("demo", "web-1")] = POD
    fake_api.logs[("demo", "web-1", "app", False)] = ["now"]
    fake_api.logs[("demo", "web-1", "app", True)] = ["before-1", "before-2"]
    path = "/api/v1/namespaces/demo/pods/web-1/log"
    _, current = await get(fake_api, path, container="app")
    _, previous = await get(fake_api, path, container="app", previous="true")
    assert current.splitlines() == ["now"]
    assert previous.splitlines() == ["before-1", "before-2"]


async def test_log_filters_and_timestamps(fake_api):
    fake_api.pods[("demo", "web-1")] = POD
    fake_api.logs[("demo", "web-1", "app", False)] = ["a", "b", "c", "d"]
    path = "/api/v1/namespaces/demo/pods/web-1/log"
    _, tail = await get(fake_api, path, container="app", tailLines="2")
    assert tail.splitlines() == ["c", "d"]
    _, stamped = await get(fake_api, path, container="app", timestamps="true", tailLines="1")
    ts, _, rest = stamped.strip().partition(" ")
    assert rest == "d" and ts.endswith("Z") and "T" in ts
    _, since = await get(fake_api, path, container="app", sinceTime=ts)
    assert since.splitlines() == ["d"]
    status, _ = await get(fake_api, "/api/v1/namespaces/demo/pods/nope/log")
    assert status == 404


async def test_create_patch_delete_pod_update_state(fake_api):
    async with aiohttp.ClientSession() as session:
        base = fake_api.url + "/api/v1/namespaces/demo/pods"
        body = {"metadata": {"name": "dbg", "namespace": "demo"}, "spec": {"containers": []}}
        async with session.post(base, json=body) as resp:
            assert resp.status == 201
        assert fake_api.pods[("demo", "dbg")]["status"]["phase"] == "Pending"
        patch = {"spec": {"ephemeralContainers": [{"name": "dbg-1"}]}}
        async with session.patch(
            base + "/dbg/ephemeralcontainers",
            json=patch,
            headers={"Content-Type": "application/strategic-merge-patch+json"},
        ) as resp:
            assert resp.status == 200
        assert fake_api.pods[("demo", "dbg")]["spec"]["ephemeralContainers"] == [{"name": "dbg-1"}]
        async with session.delete(base + "/dbg") as resp:
            assert resp.status == 200
        assert ("demo", "dbg") not in fake_api.pods
    assert [(m, p) for m, p, _ in fake_api.requests] == [
        ("POST", "/api/v1/namespaces/demo/pods"),
        ("PATCH", "/api/v1/namespaces/demo/pods/dbg/ephemeralcontainers"),
        ("DELETE", "/api/v1/namespaces/demo/pods/dbg"),
    ]


async def watch_lines(server) -> tuple[int, list[str]]:
    async with (
        aiohttp.ClientSession() as session,
        session.get(server.url + "/api/v1/pods", params={"watch": "1"}) as resp,
    ):
        return resp.status, [line.decode() async for line in resp.content]


async def test_watch_modes(fake_api):
    fake_api.mode = "instant_close"
    status, lines = await asyncio.wait_for(watch_lines(fake_api), 5)
    assert status == 200 and [json.loads(x)["type"] for x in lines] == ["ADDED"]

    fake_api.mode = "watch_forbidden"
    status, _ = await asyncio.wait_for(watch_lines(fake_api), 5)
    assert status == 403

    fake_api.mode = "ok"
    task = asyncio.create_task(watch_lines(fake_api))
    await asyncio.sleep(0.2)
    assert not task.done()  # stays open until released
    fake_api.release.set()
    status, lines = await asyncio.wait_for(task, 5)
    assert status == 200 and len(lines) == 1
