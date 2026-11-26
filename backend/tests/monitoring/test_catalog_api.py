"""`GET /projects/{id}/catalog`: what each source linked to a project holds under that link's
filter, built once per source and cached, one source's failure never failing another."""

import asyncio
import logging
import time
from dataclasses import replace

import pytest

from omnikrux.monitoring.explore.catalog import (
    CATALOG_TASK,
    CatalogCache,
    CatalogCacheClosed,
    CatalogEntry,
)
from omnikrux.monitoring.sources.connector import NOTE_NO_SERIES, UnknownSourceType
from omnikrux.monitoring.sources.health import SECRETS_UNREADABLE
from tests.monitoring.fakes import Bearer

PROMETHEUS_PATHS = ("/api/v1/label/", "/api/v1/labels", "/api/v1/metadata", "/api/v1/series")
LOKI_PATHS = ("/loki/api/v1/labels", "/loki/api/v1/label/", "/loki/api/v1/series")
TIMED_OUT = "Shop didn't describe its contents within 20 seconds. Try again, or check the tool."


def catalog_url(project_id: str) -> str:
    return f"/api/monitoring/projects/{project_id}/catalog"


def catalog_calls(fake, paths=PROMETHEUS_PATHS) -> list:
    """The catalog requests the fake saw; health probes and queries are left out."""
    return [r for r in fake.requests if r.path.startswith(paths)]


def series_filters(fake) -> list[str]:
    return [r.params["match[]"][0] for r in fake.requests if r.path == "/api/v1/series"]


async def until(condition, seconds: float = 5.0) -> None:
    deadline = time.monotonic() + seconds
    while not condition():
        assert time.monotonic() < deadline, "the condition never held"
        await asyncio.sleep(0.01)


class Clock:
    def __init__(self, now: float = 1_800_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def use_cache(app, **settings) -> CatalogCache:
    cache = CatalogCache(**settings)
    app.state.monitoring.catalogs = cache
    return cache


def seed_shop(fake_prometheus) -> None:
    fake_prometheus.label_values["__name__"] = ["http_requests_total"]
    fake_prometheus.labels = ["__name__", "cluster", "pod"]
    fake_prometheus.metadata = {
        "http_requests_total": [{"type": "counter", "help": "Requests served.", "unit": ""}]
    }
    fake_prometheus.series = [
        {"__name__": "http_requests_total", "cluster": "a", "pod": "web-1"},
    ]


# --- The route ---------------------------------------------------------------------------------


async def test_catalog_route_lists_each_linked_source(
    monitoring_app, fake_prometheus, fake_loki, linked_project_with_loki
):
    http, _ = monitoring_app
    seed_shop(fake_prometheus)
    fake_loki.series = [{"app": "shop", "cluster": "a"}]
    pid = linked_project_with_loki.project_id
    r = await http.get(catalog_url(pid))
    body = r.json()
    assert r.status_code == 200 and [s["source_type"] for s in body["sources"]] == [
        "prometheus",
        "loki",
    ]
    assert body["sources"][0]["state"] == "ok"
    assert body["sources"][0]["metrics"][0]["name"] == "http_requests_total"
    prometheus, loki = body["sources"]
    assert body["project_id"] == pid
    assert prometheus["source_id"] == linked_project_with_loki.source_id
    assert prometheus["source_name"] == "Shop" and prometheus["message"] is None
    assert prometheus["metrics"] == [
        {
            "name": "http_requests_total",
            "type": "counter",
            "help": "Requests served.",
            "unit": None,
            "labels": ["cluster", "pod"],
            "series": 1,
            "family": None,
        }
    ]
    assert prometheus["labels"] == ["__name__", "cluster", "pod"]
    assert prometheus["streams"] == [] and prometheus["notes"] == []
    assert loki["source_id"] == linked_project_with_loki.loki_source_id
    assert (loki["source_name"], loki["state"]) == ("Shop logs", "ok")
    assert loki["streams"] == [
        {"name": "app", "values": ["shop"], "truncated": False},
        {"name": "cluster", "values": ["a"], "truncated": False},
    ]
    assert loki["labels"] == ["app", "cluster"]
    # An ISO time, read back as the moment the build finished.
    assert abs(_seconds(prometheus["built_at"]) - time.time()) < 60


async def test_catalog_says_the_loki_window(
    monitoring_app, fake_prometheus, fake_loki, linked_project_with_loki
):
    http, _ = monitoring_app
    seed_shop(fake_prometheus)
    fake_loki.series = [{"app": "shop", "cluster": "a"}]
    body = (await http.get(catalog_url(linked_project_with_loki.project_id))).json()
    prometheus, loki = body["sources"]
    assert loki["stream_window_seconds"] == 604800
    assert prometheus["stream_window_seconds"] is None


async def test_a_failing_loki_says_no_window(
    monitoring_app, fake_prometheus, fake_loki, linked_project_with_loki
):
    http, _ = monitoring_app
    seed_shop(fake_prometheus)
    fake_loki.mode = "error500"
    body = (await http.get(catalog_url(linked_project_with_loki.project_id))).json()
    loki = body["sources"][1]
    assert loki["state"] == "error"
    assert loki["stream_window_seconds"] is None


def _seconds(text: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(text).timestamp()


async def test_a_catalog_with_notes_is_partial(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    seed_shop(fake_prometheus)
    fake_prometheus.fail_paths["/api/v1/series"] = 422
    r = await http.get(catalog_url(linked_project.project_id))
    [source] = r.json()["sources"]
    assert (source["state"], source["message"]) == ("partial", None)
    assert source["notes"] == [NOTE_NO_SERIES]
    assert source["metrics"][0]["series"] is None


async def test_catalog_is_cached_and_refreshed_on_demand(
    monitoring_app, fake_prometheus, linked_project
):
    http, app = monitoring_app
    clock = Clock()
    use_cache(app, clock=clock)
    seed_shop(fake_prometheus)
    url = catalog_url(linked_project.project_id)
    assert (await http.get(url)).status_code == 200
    built = len(catalog_calls(fake_prometheus))
    assert built > 0

    clock.now += 60  # well within 300 s: the stored catalog is served
    first = (await http.get(url)).json()
    assert len(catalog_calls(fake_prometheus)) == built

    r = await http.get(url, params={"refresh": "true"})  # asked for: built again
    assert r.status_code == 200
    assert len(catalog_calls(fake_prometheus)) == 2 * built
    assert r.json()["sources"][0]["built_at"] != first["sources"][0]["built_at"]

    clock.now += 5  # a second refresh within 10 s answers the build just made
    again = await http.get(url, params={"refresh": "true"})
    assert len(catalog_calls(fake_prometheus)) == 2 * built
    assert again.json() == r.json()

    clock.now += 301  # older than 300 s: built again without asking
    await http.get(url)
    assert len(catalog_calls(fake_prometheus)) == 3 * built


async def test_refresh_must_be_true_or_false(monitoring_app, linked_project):
    http, _ = monitoring_app
    r = await http.get(catalog_url(linked_project.project_id), params={"refresh": "soon"})
    assert r.status_code == 400
    assert r.json()["detail"] == {
        "code": "bad_request",
        "message": "Use refresh=true or refresh=false.",
    }


async def test_catalog_respects_and_follows_the_filter(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    assert (await http.get(catalog_url(p.a))).status_code == 200
    assert series_filters(fake_prometheus) == ['{__name__=~".+",cluster="a"}']
    assert (await http.get(catalog_url(p.b))).status_code == 200  # never A's entry
    assert series_filters(fake_prometheus) == [
        '{__name__=~".+",cluster="a"}',
        '{__name__=~".+",cluster="b"}',
    ]
    # Every catalog call but metadata (which takes no filter) carried the project's own filter.
    for request in catalog_calls(fake_prometheus):
        if request.path != "/api/v1/metadata":
            assert any("cluster=" in m for m in request.params["match[]"])

    r = await http.put(
        f"/api/monitoring/projects/{p.a}/sources/{p.source_id}", json={"filter": 'cluster="c"'}
    )
    assert r.status_code == 200, r.text
    assert (await http.get(catalog_url(p.a))).status_code == 200
    assert series_filters(fake_prometheus)[-1] == '{__name__=~".+",cluster="c"}'
    assert len(series_filters(fake_prometheus)) == 3
    # B's entry is still its own.
    assert (await http.get(catalog_url(p.b))).status_code == 200
    assert len(series_filters(fake_prometheus)) == 3


async def test_editing_the_source_builds_a_new_entry(
    monitoring_app, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    url = catalog_url(linked_project.project_id)
    await http.get(url)
    built = len(catalog_calls(fake_prometheus))
    r = await http.patch(
        f"/api/monitoring/sources/{linked_project.source_id}", json={"name": "Shop metrics"}
    )
    assert r.status_code == 200, r.text
    body = (await http.get(url)).json()
    assert len(catalog_calls(fake_prometheus)) == 2 * built
    assert body["sources"][0]["source_name"] == "Shop metrics"


async def test_concurrent_requests_build_once(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    fake_prometheus.mode = "hang"
    url = catalog_url(linked_project.project_id)
    try:
        gets = [asyncio.create_task(http.get(url)) for _ in range(3)]
        await until(lambda: len(catalog_calls(fake_prometheus)) >= 3)
        await asyncio.sleep(0.1)  # every GET has reached the cache by now
    finally:
        fake_prometheus.release.set()
    answers = await asyncio.gather(*gets)
    assert [a.status_code for a in answers] == [200, 200, 200]
    assert len([r for r in fake_prometheus.requests if r.path == "/api/v1/series"]) == 1
    assert len([r for r in fake_prometheus.requests if r.path == "/api/v1/metadata"]) == 1


async def test_a_hanging_source_does_not_hold_the_others(
    monitoring_app, fake_prometheus, fake_loki, linked_project_with_loki
):
    http, app = monitoring_app
    cache = use_cache(app, timeout=0.3)
    fake_prometheus.mode = "hang"
    url = catalog_url(linked_project_with_loki.project_id)
    try:
        began = time.monotonic()
        r = await http.get(url)
        assert time.monotonic() - began < 1.0
        assert r.status_code == 200
        prometheus, loki = r.json()["sources"]
        # The fixed copy, whatever the configured timeout.
        assert (prometheus["state"], prometheus["message"]) == ("error", TIMED_OUT)
        assert prometheus["metrics"] == [] and prometheus["notes"] == []
        assert loki["state"] == "ok"

        # Within the error's 30 s the timeout is the answer: nothing is asked again.
        sent = len(catalog_calls(fake_prometheus))
        again = await http.get(url)
        assert again.json()["sources"][0]["message"] == TIMED_OUT
        assert len(catalog_calls(fake_prometheus)) == sent
    finally:
        fake_prometheus.release.set()
    await cache.close()
    assert not [t for t in asyncio.all_tasks() if t.get_name() == CATALOG_TASK and not t.done()]


async def test_a_failing_source_is_an_error_in_words(
    monitoring_app, fake_prometheus, fake_loki, linked_project_with_loki
):
    http, _ = monitoring_app
    fake_prometheus.mode = "error500"
    r = await http.get(catalog_url(linked_project_with_loki.project_id))
    assert r.status_code == 200
    prometheus, loki = r.json()["sources"]
    assert (prometheus["state"], prometheus["message"]) == (
        "error",
        "The source answered HTTP 500. Try again, or check the tool.",
    )
    assert loki["state"] == "ok"


async def test_unreadable_secrets_are_an_error(
    monitoring_app, fake_prometheus, linked_project, monkeypatch
):
    http, app = monitoring_app
    store = app.state.monitoring.sources
    real_get = store.get

    async def unreadable(id):
        return replace(await real_get(id), secrets_unreadable=True)

    monkeypatch.setattr(store, "get", unreadable)
    r = await http.get(catalog_url(linked_project.project_id))
    [source] = r.json()["sources"]
    assert (source["state"], source["message"]) == ("error", SECRETS_UNREADABLE)
    assert catalog_calls(fake_prometheus) == []


async def test_a_source_without_a_connector_is_an_error(
    monitoring_app, fake_prometheus, linked_project, monkeypatch
):
    http, app = monitoring_app

    def unknown(type):
        raise UnknownSourceType("graphite")

    monkeypatch.setattr(app.state.monitoring.connectors, "get", unknown)
    [source] = (await http.get(catalog_url(linked_project.project_id))).json()["sources"]
    assert (source["state"], source["message"]) == (
        "error",
        'There\'s no connector for "graphite" sources.',
    )
    assert catalog_calls(fake_prometheus) == []


async def test_an_unexpected_failure_is_an_error_in_words(
    monitoring_app, linked_project, monkeypatch, caplog
):
    http, app = monitoring_app
    connector = app.state.monitoring.connectors.get("prometheus")

    async def broken(*args, **kwargs):
        raise RuntimeError("body text tok-SECRET-1")

    monkeypatch.setattr(connector, "catalog", broken)
    with caplog.at_level(logging.WARNING):
        r = await http.get(catalog_url(linked_project.project_id))
    [source] = r.json()["sources"]
    assert (source["state"], source["message"]) == (
        "error",
        "Shop couldn't describe its contents. Try again, or check the tool.",
    )
    assert "tok-SECRET-1" not in r.text and "tok-SECRET-1" not in caplog.text
    assert linked_project.source_id in caplog.text


async def test_unknown_project_is_404(monitoring_app):
    http, _ = monitoring_app
    r = await http.get(catalog_url("no-such-project"))
    assert r.status_code == 404
    assert r.json() == {
        "detail": {"code": "not_found", "message": "That project no longer exists."}
    }


async def test_a_stopping_app_answers_503_in_words(monitoring_app, fake_prometheus, linked_project):
    """While OmniKrux stops, the closed catalog cache refuses in plain words, never a bare 500."""
    http, app = monitoring_app
    seed_shop(fake_prometheus)
    await use_cache(app).close()
    r = await http.get(catalog_url(linked_project.project_id))
    assert r.status_code == 503
    assert r.json() == {
        "detail": {
            "code": "unavailable",
            "message": "OmniKrux is stopping. Try again in a moment.",
        }
    }


async def test_catalog_refuses_cross_origin(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    r = await http.get(
        catalog_url(linked_project.project_id), headers={"Origin": "http://evil.example"}
    )
    assert r.status_code == 403
    assert catalog_calls(fake_prometheus) == []


async def test_catalog_never_contains_secrets(monitoring_app, fake_prometheus):
    http, app = monitoring_app
    clock = Clock(time.time())
    use_cache(app, clock=clock)
    seed_shop(fake_prometheus)
    fake_prometheus.require = Bearer("tok-SECRET-9")
    fake_prometheus.echo_auth_in_errors = True
    source = await http.post(
        "/api/monitoring/sources",
        json={
            "type": "prometheus",
            "reach": "url",
            "url": fake_prometheus.url,
            "name": "Locked",
            "auth": {"type": "bearer", "token": "tok-SECRET-9"},
        },
    )
    assert source.status_code == 201, source.text
    project = await http.post(
        "/api/monitoring/setup",
        json={
            "name": "Locked",
            "kind": "custom",
            "sources": [{"source_id": source.json()["id"], "filter": 'cluster="a"'}],
        },
    )
    assert project.status_code == 201, project.text
    url = catalog_url(project.json()["id"])
    r = await http.get(url)
    assert r.json()["sources"][0]["state"] == "ok"
    assert "tok-SECRET-9" not in r.text
    # A refusal that echoes the request's credentials back doesn't carry them either.
    fake_prometheus.fail_paths["/api/v1/label/__name__/values"] = 400
    clock.now += 11
    r = await http.get(url, params={"refresh": "true"})
    assert r.json()["sources"][0]["state"] == "error"
    assert "tok-SECRET-9" not in r.text


# --- The cache ---------------------------------------------------------------------------------

KEY = ("project-a", "source-1", 'cluster="a"', "2026-11-19T00:00:00+00:00")


def entry(state: str = "ok", built_at: float = 0.0) -> CatalogEntry:
    return CatalogEntry(
        source_id="source-1",
        source_name="Shop",
        source_type="prometheus",
        state=state,  # type: ignore[arg-type]
        message="It failed." if state == "error" else None,
        catalog=None,
        built_at=built_at,
    )


def gave_up() -> CatalogEntry:
    return entry("error")


class Builds:
    """Build functions that count their runs and answer the states queued for them."""

    def __init__(self, *states: str) -> None:
        self.states = list(states)
        self.runs = 0

    async def __call__(self) -> CatalogEntry:
        self.runs += 1
        state = self.states.pop(0) if len(self.states) > 1 else self.states[0]
        return entry(state)


async def test_errors_are_kept_only_briefly():
    clock = Clock()
    cache = CatalogCache(clock=clock)
    build = Builds("error", "ok")
    first = await cache.get(KEY, build, refresh=False, timed_out=gave_up)
    assert first.state == "error" and first.built_at == clock.now  # stamped by the cache
    clock.now += 29
    assert (await cache.get(KEY, build, refresh=False, timed_out=gave_up)).state == "error"
    assert build.runs == 1
    clock.now += 2  # 31 s: an error is kept 30 s
    assert (await cache.get(KEY, build, refresh=False, timed_out=gave_up)).state == "ok"
    assert build.runs == 2
    clock.now += 299
    assert (await cache.get(KEY, build, refresh=False, timed_out=gave_up)).state == "ok"
    assert build.runs == 2
    clock.now += 2  # 301 s
    await cache.get(KEY, build, refresh=False, timed_out=gave_up)
    assert build.runs == 3


async def test_refresh_is_limited_to_once_per_gap():
    clock = Clock()
    cache = CatalogCache(clock=clock)
    build = Builds("ok")
    await cache.get(KEY, build, refresh=False, timed_out=gave_up)
    clock.now += 9
    await cache.get(KEY, build, refresh=True, timed_out=gave_up)
    assert build.runs == 1
    clock.now += 2
    await cache.get(KEY, build, refresh=True, timed_out=gave_up)
    assert build.runs == 2


async def test_cache_drops_the_least_recently_used():
    clock = Clock()
    cache = CatalogCache(clock=clock, max_entries=2)
    keys = [KEY[:1] + (f"source-{n}",) + KEY[2:] for n in range(3)]
    builds = [Builds("ok") for _ in keys]
    for key, build in zip(keys, builds, strict=True):
        await cache.get(key, build, refresh=False, timed_out=gave_up)
    await cache.get(keys[0], builds[0], refresh=False, timed_out=gave_up)  # the first was dropped
    assert builds[0].runs == 2
    # Now the second is the least recently used: reading the third keeps it.
    await cache.get(keys[2], builds[2], refresh=False, timed_out=gave_up)
    await cache.get(keys[1], builds[1], refresh=False, timed_out=gave_up)
    assert [b.runs for b in builds] == [2, 2, 1]


async def test_keys_keep_projects_apart():
    cache = CatalogCache(clock=Clock())
    a, b = Builds("ok"), Builds("error")
    other_project = ("project-b",) + KEY[1:]
    assert (await cache.get(KEY, a, refresh=False, timed_out=gave_up)).state == "ok"
    assert (await cache.get(other_project, b, refresh=False, timed_out=gave_up)).state == "error"
    assert (a.runs, b.runs) == (1, 1)


async def test_forget_project_drops_only_its_entries():
    cache = CatalogCache(clock=Clock())
    a, b = Builds("ok"), Builds("ok")
    other_project = ("project-b",) + KEY[1:]
    await cache.get(KEY, a, refresh=False, timed_out=gave_up)
    await cache.get(other_project, b, refresh=False, timed_out=gave_up)
    cache.forget_project("project-a")
    await cache.get(KEY, a, refresh=False, timed_out=gave_up)
    await cache.get(other_project, b, refresh=False, timed_out=gave_up)
    assert (a.runs, b.runs) == (2, 1)


async def test_a_cancelled_request_never_cancels_the_shared_build():
    cache = CatalogCache(clock=Clock())
    gate = asyncio.Event()
    runs = 0

    async def build() -> CatalogEntry:
        nonlocal runs
        runs += 1
        await gate.wait()
        return entry()

    first = asyncio.create_task(cache.get(KEY, build, refresh=False, timed_out=gave_up))
    second = asyncio.create_task(cache.get(KEY, build, refresh=False, timed_out=gave_up))
    await asyncio.sleep(0.01)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    gate.set()
    assert (await second).state == "ok"
    assert runs == 1
    assert (
        await cache.get(KEY, build, refresh=False, timed_out=gave_up)
    ).state == "ok" and runs == 1


async def test_a_timed_out_build_is_cached_as_its_error():
    clock = Clock()
    cache = CatalogCache(clock=clock, timeout=0.05)
    runs = 0

    async def hang() -> CatalogEntry:
        nonlocal runs
        runs += 1
        await asyncio.Event().wait()
        raise AssertionError("never reached")

    def timed_out() -> CatalogEntry:
        return entry("error")

    got = await cache.get(KEY, hang, refresh=False, timed_out=timed_out)
    assert got.state == "error" and got.built_at == clock.now
    clock.now += 29
    await cache.get(KEY, hang, refresh=False, timed_out=timed_out)
    assert runs == 1
    assert not [t for t in asyncio.all_tasks() if t.get_name() == CATALOG_TASK and not t.done()]


async def test_close_cancels_builds_in_flight():
    cache = CatalogCache(clock=Clock())

    async def hang() -> CatalogEntry:
        await asyncio.Event().wait()
        raise AssertionError("never reached")

    waiter = asyncio.create_task(cache.get(KEY, hang, refresh=False, timed_out=gave_up))
    await asyncio.sleep(0.01)
    await cache.close()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert not [t for t in asyncio.all_tasks() if t.get_name() == CATALOG_TASK and not t.done()]


async def test_a_refresh_joins_the_build_in_flight():
    clock = Clock()
    cache = CatalogCache(clock=clock)
    build = Builds("ok")
    await cache.get(KEY, build, refresh=False, timed_out=gave_up)
    clock.now += 11  # past the refresh gap: a refresh builds again
    gate = asyncio.Event()

    async def slow() -> CatalogEntry:
        await gate.wait()
        return await build()

    first = asyncio.create_task(cache.get(KEY, slow, refresh=True, timed_out=gave_up))
    await asyncio.sleep(0.01)
    second = asyncio.create_task(cache.get(KEY, slow, refresh=True, timed_out=gave_up))
    plain = asyncio.create_task(cache.get(KEY, slow, refresh=False, timed_out=gave_up))
    await asyncio.sleep(0.01)
    gate.set()
    answers = await asyncio.gather(first, second, plain)
    assert build.runs == 2  # the first build, then one refresh for all three
    assert answers[0] is answers[1]


async def test_a_closed_cache_starts_no_build():
    cache = CatalogCache(clock=Clock())
    build = Builds("ok")
    await cache.close()
    with pytest.raises(CatalogCacheClosed):
        await cache.get(KEY, build, refresh=False, timed_out=gave_up)
    assert build.runs == 0


async def test_a_failed_build_nobody_awaits_is_not_reported(caplog):
    """A build whose callers all went away and that then fails leaves no "Task exception was
    never retrieved" behind."""
    cache = CatalogCache(clock=Clock())
    gate = asyncio.Event()

    async def broken() -> CatalogEntry:
        await gate.wait()
        raise RuntimeError("broken")

    waiter = asyncio.create_task(cache.get(KEY, broken, refresh=False, timed_out=gave_up))
    await asyncio.sleep(0.01)
    waiter.cancel()
    gate.set()
    await asyncio.sleep(0.01)
    import gc

    with caplog.at_level(logging.ERROR, logger="asyncio"):
        gc.collect()
        await asyncio.sleep(0)
    assert "never retrieved" not in caplog.text


async def wide_project(http, url: str, count: int = 6) -> tuple[str, list[str]]:
    """A project linked to `count` Prometheus sources over `url`, in that order."""
    ids = []
    for n in range(count):
        r = await http.post(
            "/api/monitoring/sources",
            json={"type": "prometheus", "reach": "url", "url": url, "name": f"Shop {n}"},
        )
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
    project = await http.post(
        "/api/monitoring/setup",
        json={
            "name": "Wide",
            "kind": "custom",
            "sources": [{"source_id": i, "filter": 'cluster="a"'} for i in ids],
        },
    )
    assert project.status_code == 201, project.text
    return project.json()["id"], ids


async def test_a_project_builds_at_most_four_sources_at_once(
    monitoring_app, fake_prometheus, monkeypatch
):
    """Six Prometheus sources linked to one project: their catalogs are read four at a time."""
    from omnikrux.monitoring.sources.connector import SourceCatalog

    http, app = monitoring_app
    project_id, ids = await wide_project(http, fake_prometheus.url)
    connector = app.state.monitoring.connectors.get("prometheus")
    now = peak = 0

    async def slow(*args, **kwargs):
        nonlocal now, peak
        now += 1
        peak = max(peak, now)
        try:
            await asyncio.sleep(0.05)
            return SourceCatalog((), (), (), ())
        finally:
            now -= 1

    monkeypatch.setattr(connector, "catalog", slow)
    r = await http.get(catalog_url(project_id))
    assert [s["source_id"] for s in r.json()["sources"]] == ids
    assert peak == 4


async def test_many_hanging_sources_still_answer_within_the_time_limit(
    monitoring_app, fake_prometheus
):
    """Six hanging sources, four built at once: the two waiting for a turn are answered at the
    call's deadline too, not one timeout later."""
    http, app = monitoring_app
    cache = use_cache(app, timeout=0.3)
    project_id, ids = await wide_project(http, fake_prometheus.url)
    fake_prometheus.mode = "hang"
    try:
        began = time.monotonic()
        r = await http.get(catalog_url(project_id))
        took = time.monotonic() - began
        assert r.status_code == 200
        assert took < 0.55, took  # one 0.3 s bound, not two in a row (0.6 s)
        sources = r.json()["sources"]
        assert [s["source_id"] for s in sources] == ids
        assert [(s["state"], s["message"]) for s in sources] == [
            ("error", TIMED_OUT.replace("Shop", f"Shop {n}")) for n in range(6)
        ]
        # Only the four builds that ran stored their timeouts; the two answered at the deadline
        # were never built, so the next request builds them.
        sent = len(catalog_calls(fake_prometheus))
        await http.get(catalog_url(project_id))
        assert len(catalog_calls(fake_prometheus)) > sent
    finally:
        fake_prometheus.release.set()
    await cache.close()
    assert not [t for t in asyncio.all_tasks() if t.get_name() == CATALOG_TASK and not t.done()]
