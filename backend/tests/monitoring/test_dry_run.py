"""The dry run: replaying a condition over past data, candidate thresholds, and the route."""

import math
import random
import socket
import time
from datetime import UTC, datetime

import pytest

from omnikrux.monitoring.alerts import dry_run as dry_run_module
from omnikrux.monitoring.alerts.dry_run import (
    GROUP_SOURCE,
    candidate_thresholds,
    replay,
)
from omnikrux.monitoring.alerts.evaluate import Sample, step
from omnikrux.monitoring.alerts.rule_expr import LOG_QUERY_COPY, RANGE_COPY
from omnikrux.monitoring.alerts.types import Condition
from omnikrux.monitoring.query.series import Series

DRY_RUN = "/api/monitoring/alerts/dry-run"
HOUR = 3600


def at(hh: int, mm: int) -> float:
    return datetime(2026, 11, 19, hh, mm, tzinfo=UTC).timestamp()


def series_over(labels, start: float, end: float, high: tuple[float, float], value=0.5, low=0.1):
    """A series at step 60 from `start` to `end`, at `value` inside `high` and `low` outside."""
    points = []
    t = start
    while t <= end:
        points.append((t, value if high[0] <= t <= high[1] else low))
        t += 60
    return Series(labels=labels, points=points)


# --- replay -----------------------------------------------------------------------------------


def test_replay_counts_periods_like_the_prototype():
    start, end = at(13, 0), at(19, 0)
    cond = Condition("each", "above", 0.3, 0, 60)
    one = series_over({"route": "/a"}, start, end, (at(18, 42), at(18, 51)))
    episodes, periods = replay([one], cond, start, end)
    assert periods == [(at(18, 42), at(18, 51), False)]
    assert periods[0][1] - periods[0][0] == 9 * 60
    assert [(e.start, e.end, e.ongoing, e.labels) for e in episodes] == [
        (at(18, 42), at(18, 51), False, {"route": "/a"})
    ]

    two = series_over({"route": "/b"}, start, end, (at(18, 45), at(18, 55)))
    episodes, periods = replay([one, two], cond, start, end)
    assert periods == [(at(18, 42), at(18, 55), False)]
    assert len(episodes) == 2


def test_replay_fires_only_after_for_and_only_while_the_run_lasts():
    start, end = at(13, 0), at(19, 0)
    cond = Condition("each", "above", 0.3, 300, 60)
    long_run = series_over({"r": "long"}, start, end, (at(14, 0), at(14, 9)))
    short_run = series_over({"r": "short"}, start, end, (at(15, 0), at(15, 3)))
    episodes, periods = replay([long_run, short_run], cond, start, end)
    assert periods == [(at(14, 5), at(14, 9), False)]
    assert [e.labels["r"] for e in episodes] == ["long"]


def test_replay_a_gap_or_no_value_breaks_a_run():
    cond = Condition("each", "above", 0.3, 120, 60)
    t0 = at(10, 0)
    gap = Series(labels={}, points=[(t0, 0.5), (t0 + 60, 0.5), (t0 + 180, 0.5), (t0 + 240, 0.5)])
    assert replay([gap], cond, t0, t0 + 600)[1] == []
    none = Series(labels={}, points=[(t0, 0.5), (t0 + 60, 0.5), (t0 + 120, None), (t0 + 180, 0.5)])
    assert replay([none], cond, t0, t0 + 600)[1] == []
    whole = Series(labels={}, points=[(t0 + 60 * i, 0.5) for i in range(4)])
    assert replay([whole], cond, t0, t0 + 600)[1] == [(t0 + 120, t0 + 180, False)]


def test_replay_is_ongoing_when_it_reaches_the_last_point():
    start, end = at(13, 0), at(19, 0)
    cond = Condition("each", "above", 0.3, 0, 60)
    now = series_over({}, start, end, (at(18, 50), end))
    episodes, periods = replay([now], cond, start, end)
    assert periods == [(at(18, 50), end, True)] and episodes[0].ongoing
    # a series that stopped before the end isn't firing now
    stopped = Series(labels={}, points=[p for p in now.points if p[0] < end])
    assert replay([stopped], cond, start, end)[1] == [(at(18, 50), end - 60, False)]


def test_replay_reads_only_the_window_and_touching_periods_merge():
    cond = Condition("each", "below", 1, 0, 60)
    t0 = at(10, 0)
    a = Series(labels={"x": "a"}, points=[(t0 - 60, 0.0), (t0, 0.0), (t0 + 60, 0.0), (t0 + 120, 5)])
    b = Series(labels={"x": "b"}, points=[(t0 + 60, 0.0), (t0 + 120, 0.0), (t0 + 180, 0.0)])
    _, periods = replay([a, b], cond, t0, t0 + 600)
    assert periods == [(t0, t0 + 180, False)]


def test_replay_of_nothing_is_nothing():
    cond = Condition("total", "above", 0, 0, 60)
    assert replay([], cond, 0, 600) == ([], [])
    assert replay([Series(labels={}, points=[])], cond, 0, 600) == ([], [])


# --- candidate thresholds ---------------------------------------------------------------------


def test_candidate_thresholds_above_are_calmer_and_rounded_up():
    values = Series(labels={}, points=[(float(i), i / 100) for i in range(1, 101)])  # 0.01..1.00
    # q0.9 = 0.901 -> 0.91, q0.95 = 0.9505 -> 0.96, q0.99 = 0.9901 -> 1.0, 1.1 x max = 1.1
    assert candidate_thresholds([values], "above") == [0.91, 0.96, 1.0, 1.1]


def test_candidate_thresholds_below_mirror():
    values = Series(labels={}, points=[(float(i), float(i)) for i in range(100, 201)])  # 100..200
    # q0.1 = 110, q0.05 = 105, q0.01 = 101 -> 100 (down), 0.9 x min = 90
    assert candidate_thresholds([values], "below") == [110.0, 100.0, 90.0]


def test_candidate_thresholds_skip_missing_values_and_handle_none():
    assert candidate_thresholds([], "above") == []
    empty = Series(labels={}, points=[(1.0, None), (2.0, None)])
    assert candidate_thresholds([empty], "below") == []
    flat = Series(labels={}, points=[(1.0, 0.0), (2.0, None), (3.0, 0.0)])
    assert candidate_thresholds([flat], "above") == [0.0]
    for v in candidate_thresholds([Series(labels={}, points=[(1.0, 0.123456)])], "above"):
        assert math.isfinite(v) and v >= 0.123456


# --- the route --------------------------------------------------------------------------------


def window_end(step: int = 60) -> float:
    return math.floor(time.time() / step) * step


def matrix(*items: tuple[dict, list[tuple[float, float]]]) -> dict:
    return {
        "resultType": "matrix",
        "result": [
            {"metric": labels, "values": [[t, str(v)] for t, v in points]}
            for labels, points in items
        ],
    }


def six_hours(high_from: float, high_to: float, value: float = 0.5) -> list[tuple[float, float]]:
    end = window_end()
    out = []
    t = end - 6 * HOUR
    while t <= end:
        out.append((t, value if high_from <= t <= high_to else 0.1))
        t += 60
    return out


def body(project_id: str, **over) -> dict:
    values = {
        "scope": {"kind": "project", "id": project_id},
        "source": {"type": "prometheus", "id": None},
        "expr": "errors_ratio",
        "op": "above",
        "threshold": 0.3,
        "for": "0s",
        "every": "1m",
    }
    return values | over


def closed_port_url() -> str:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}"


async def set_up(http, name: str, source_id: str, filter: str) -> str:
    r = await http.post(
        "/api/monitoring/setup",
        json={
            "name": name,
            "kind": "custom",
            "sources": [{"source_id": source_id, "filter": filter}],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def add_source(http, url: str, name: str, type: str = "prometheus") -> str:
    r = await http.post(
        "/api/monitoring/sources", json={"type": type, "reach": "url", "url": url, "name": name}
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def add_group(http, name: str, project_ids: list[str]) -> str:
    r = await http.post("/api/monitoring/groups", json={"name": name, "project_ids": project_ids})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def refusal(r) -> tuple[int, str, str]:
    detail = r.json()["detail"]
    return r.status_code, detail["code"], detail["message"]


async def test_dry_run_route(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    end = window_end()
    points = six_hours(end - 3 * HOUR, end - 3 * HOUR + 9 * 60)
    fake_prometheus.results['errors_ratio{cluster="a"}'] = matrix(({"route": "/a"}, points))

    r = await http.post(DRY_RUN, json=body(linked_project.project_id))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["fired"] == 1 and out["step"] == 60 and out["candidates"] == []
    assert out["firing_now"] is False
    assert out["end"] - out["start"] == 6 * HOUR and out["end"] % 60 == 0
    assert out["periods"] == [
        {"start": end - 3 * HOUR, "end": end - 3 * HOUR + 9 * 60, "ongoing": False}
    ]
    [project] = out["projects"]
    assert project == {
        "project_id": linked_project.project_id,
        "project_name": "Shop",
        "fired": 1,
        "firing_now": False,
        "periods": out["periods"],
        "series": 1,
        "error": None,
    }
    assert isinstance(out["took_ms"], int)

    r = await http.post(DRY_RUN, json=body(linked_project.project_id, candidates=[0.6, 0.2]))
    assert r.status_code == 200, r.text
    assert r.json()["candidates"] == [
        {"threshold": 0.6, "fired": 0},
        {"threshold": 0.2, "fired": 1},
    ]


async def test_dry_run_applies_the_project_filter(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    r = await http.post(
        DRY_RUN,
        json=body(
            linked_project.project_id,
            expr="rate(errors_total[$__rate_interval])",
            every="5m",
            window_seconds=86400,
        ),
    )
    assert r.status_code == 200, r.text
    [sent] = [q for q in fake_prometheus.requests if q.path == "/api/v1/query_range"]
    assert sent.params["query"] == ['rate(errors_total{cluster="a"}[20m])']
    assert sent.params["step"] == ["300"]
    start, end = float(sent.params["start"][0]), float(sent.params["end"][0])
    assert start % 300 == 0 and end % 300 == 0 and end - start >= 86400
    out = r.json()
    assert (out["fired"], out["step"], out["projects"][0]["series"]) == (0, 300, 0)
    assert out["projects"][0]["error"] is None


async def test_dry_run_of_the_total_sums_the_query(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    r = await http.post(DRY_RUN, json=body(linked_project.project_id, of="total"))
    assert r.status_code == 200, r.text
    [sent] = [q for q in fake_prometheus.requests if q.path == "/api/v1/query_range"]
    assert sent.params["query"][0].startswith("sum(")
    assert 'errors_ratio{cluster="a"}' in sent.params["query"][0]


async def test_dry_run_suggests_calmer_thresholds(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    end = window_end()
    points = six_hours(end - 3 * HOUR, end - 2 * HOUR, value=0.5)
    fake_prometheus.results['errors_ratio{cluster="a"}'] = matrix(({"route": "/a"}, points))
    r = await http.post(DRY_RUN, json=body(linked_project.project_id, suggest=True))
    assert r.status_code == 200, r.text
    candidates = r.json()["candidates"]
    thresholds = [c["threshold"] for c in candidates]
    assert thresholds == sorted(thresholds) and thresholds[-1] == 0.55
    assert all(c["fired"] == 0 for c in candidates if c["threshold"] >= 0.5)


async def test_dry_run_on_a_group_reports_each_project(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    good = await set_up(
        http, "Alpha", await add_source(http, fake_prometheus.url, "Up"), 'cluster="a"'
    )
    gone = await set_up(
        http, "Beta", await add_source(http, closed_port_url(), "Down"), 'cluster="b"'
    )
    group = await add_group(http, "Both", [good, gone])
    end = window_end()
    points = six_hours(end - HOUR, end)  # firing to the very end
    fake_prometheus.results['errors_ratio{cluster="a"}'] = matrix(({"route": "/a"}, points))

    r = await http.post(DRY_RUN, json=body(group, scope={"kind": "group", "id": group}))
    assert r.status_code == 200, r.text
    out = r.json()
    alpha, beta = out["projects"]
    assert (alpha["project_name"], alpha["fired"], alpha["firing_now"]) == ("Alpha", 1, True)
    assert alpha["error"] is None
    assert (beta["project_name"], beta["fired"], beta["series"]) == ("Beta", 0, 0)
    assert beta["error"]["code"] == "unreachable" and beta["error"]["message"]
    assert out["fired"] == 1 and out["firing_now"] is True


async def test_dry_run_on_a_group_names_a_project_without_a_source(
    monitoring_app, fake_prometheus, fake_loki
):
    http, _ = monitoring_app
    good = await set_up(
        http, "Alpha", await add_source(http, fake_prometheus.url, "Up"), 'cluster="a"'
    )
    logs = await add_source(http, fake_loki.url, "Logs", type="loki")
    only_logs = await set_up(http, "Gamma", logs, 'cluster="c"')
    group = await add_group(http, "Mixed", [only_logs, good])
    r = await http.post(DRY_RUN, json=body(group, scope={"kind": "group", "id": group}))
    assert r.status_code == 200, r.text
    alpha, gamma = r.json()["projects"]
    assert alpha["error"] is None
    assert gamma["error"] == {
        "code": "not_linked",
        "message": "Gamma has no Prometheus-compatible source.",
    }
    assert not [q for q in fake_loki.requests if "query" in q.path]


async def test_dry_run_where_every_project_fails_is_502(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    down = await set_up(http, "Down", await add_source(http, closed_port_url(), "Off"), 'x="1"')
    r = await http.post(DRY_RUN, json=body(down))
    status, code, message = refusal(r)
    assert (status, code) == (502, "unreachable") and message

    fake_prometheus.errors['errors_ratio{cluster="a"}'] = "parse error"
    shop = await set_up(
        http, "Shop", await add_source(http, fake_prometheus.url, "On"), 'cluster="a"'
    )
    group = await add_group(http, "Broken", [shop, down])
    r = await http.post(DRY_RUN, json=body(group, scope={"kind": "group", "id": group}))
    assert r.status_code == 502
    assert r.json()["detail"]["code"] == "unreachable"  # Down comes first by name


async def test_dry_run_refuses_a_loki_log_query(
    monitoring_app, linked_project_with_loki, fake_loki
):
    http, _ = monitoring_app
    r = await http.post(
        DRY_RUN,
        json=body(
            linked_project_with_loki.project_id,
            source={"type": "loki", "id": None},
            expr='  {app="api"} |= "error"',
        ),
    )
    assert refusal(r) == (400, "bad_query", LOG_QUERY_COPY)
    assert not fake_loki.requests

    metric = 'sum(count_over_time({app="api"} |= "error" [5m]))'
    r = await http.post(
        DRY_RUN,
        json=body(
            linked_project_with_loki.project_id,
            source={"type": "loki", "id": linked_project_with_loki.loki_source_id},
            expr=metric,
        ),
    )
    assert r.status_code == 200, r.text
    assert [q.path for q in fake_loki.requests] == ["/loki/api/v1/query_range"]
    assert 'cluster="a"' in fake_loki.requests[0].params["query"][0]


@pytest.mark.parametrize(
    ("expr", "message"),
    [
        ("rate(x[$__range])", RANGE_COPY),
        (
            'x{route="$route"}',
            "Uses $route, which isn't a variable here. Write the value into the query.",
        ),
        (
            'x{a=~"${team}"}',
            "Uses $team, which isn't a variable here. Write the value into the query.",
        ),
    ],
)
async def test_dry_run_refuses_variables_it_cant_place(
    monitoring_app, fake_prometheus, linked_project, expr, message
):
    http, _ = monitoring_app
    r = await http.post(DRY_RUN, json=body(linked_project.project_id, expr=expr))
    assert refusal(r) == (400, "bad_query", message)
    assert not fake_prometheus.requests or all(
        q.path != "/api/v1/query_range" for q in fake_prometheus.requests
    )


async def test_dry_run_places_the_interval(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    r = await http.post(
        DRY_RUN,
        json=body(linked_project.project_id, expr="rate(x[$__interval]) # $comment", every="30s"),
    )
    assert r.status_code == 200, r.text
    [sent] = [q for q in fake_prometheus.requests if q.path == "/api/v1/query_range"]
    assert sent.params["query"][0].startswith('rate(x{cluster="a"}[30s])')
    assert sent.params["step"] == ["30"]


async def test_dry_run_refuses_what_cant_start(
    monitoring_app, fake_prometheus, linked_project_with_loki
):
    http, _ = monitoring_app
    project = linked_project_with_loki.project_id
    group = await add_group(http, "One", [project])

    r = await http.post(
        DRY_RUN,
        json=body(
            group, scope={"kind": "group", "id": group}, source={"type": "prometheus", "id": "x"}
        ),
    )
    assert refusal(r) == (422, "bad_request", GROUP_SOURCE)

    r = await http.post(DRY_RUN, json=body("nope"))
    assert refusal(r)[:2] == (404, "not_found")
    r = await http.post(DRY_RUN, json=body("nope", scope={"kind": "group", "id": "nope"}))
    assert refusal(r)[:2] == (404, "not_found")

    loki = linked_project_with_loki.loki_source_id
    r = await http.post(DRY_RUN, json=body(project, source={"type": "prometheus", "id": loki}))
    assert refusal(r) == (
        400,
        "bad_request",
        "That source isn't a Prometheus-compatible source. Pick one that is.",
    )
    other = await add_source(http, fake_prometheus.url, "Elsewhere")
    r = await http.post(DRY_RUN, json=body(project, source={"type": "prometheus", "id": other}))
    assert refusal(r) == (404, "not_linked", "This source isn't linked to that project.")

    r = await http.post(DRY_RUN, json=body(project, **{"for": "2d"}))
    assert refusal(r) == (422, "bad_request", "Use a duration from 0s to 24h, like 5m.")

    for bad in (
        {"every": "2m"},
        {"window_seconds": 60},
        {"window_seconds": 86401},
        {"candidates": [0.1] * 21},
        {"expr": ""},
        {"op": "equal"},
        {"surprise": 1},
    ):
        r = await http.post(DRY_RUN, json=body(project, **bad))
        assert r.status_code == 422, (bad, r.text)
    r = await http.post(
        DRY_RUN,
        content=b'{"scope": {"kind": "project", "id": "p"}, "source": {"type": "prometheus"},'
        b' "expr": "x", "op": "above", "threshold": NaN}',
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 422
    assert not [q for q in fake_prometheus.requests if q.path == "/api/v1/query_range"]


async def test_dry_run_on_a_project_without_a_source_of_the_type(monitoring_app, linked_project):
    http, _ = monitoring_app
    r = await http.post(
        DRY_RUN, json=body(linked_project.project_id, source={"type": "loki", "id": None})
    )
    assert refusal(r) == (
        404,
        "not_linked",
        "Shop has no Loki source. Link one on the project page.",
    )


async def test_dry_run_never_writes_an_audit_record(
    monitoring_app, fake_prometheus, linked_project, monkeypatch
):
    http, app = monitoring_app

    async def broken(*args, **kwargs):
        raise AssertionError("a dry run must not write an audit record")

    monkeypatch.setattr(app.state.audit, "begin_app", broken)
    r = await http.post(DRY_RUN, json=body(linked_project.project_id))
    assert r.status_code == 200, r.text
    assert await app.state.monitoring.alerts.list_rules() == []


async def test_dry_run_refuses_cross_origin(monitoring_app, linked_project):
    http, _ = monitoring_app
    r = await http.post(
        DRY_RUN,
        json=body(linked_project.project_id),
        headers={"Origin": "http://evil.example"},
    )
    assert r.status_code == 403


async def test_a_project_with_too_many_points_says_so(
    monitoring_app, fake_prometheus, linked_project, monkeypatch
):
    http, _ = monitoring_app
    monkeypatch.setattr(dry_run_module, "MAX_PROJECT_POINTS", 100)
    end = window_end()
    points = six_hours(end, end)
    fake_prometheus.results['errors_ratio{cluster="a"}'] = matrix(({"route": "/a"}, points))
    r = await http.post(DRY_RUN, json=body(linked_project.project_id))
    status, code, message = refusal(r)
    assert (status, code) == (502, "too_large")
    assert message.startswith("This query returns 1 series, too many to replay")
    assert message.endswith('use a shorter "for" or window.')


async def test_a_cut_answer_is_not_counted(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    end = window_end()
    many = [({"i": str(i)}, [(end, 0.5)]) for i in range(2001)]
    fake_prometheus.results['errors_ratio{cluster="a"}'] = matrix(*many)
    r = await http.post(DRY_RUN, json=body(linked_project.project_id))
    status, code, message = refusal(r)
    assert (status, code) == (502, "too_large")
    assert message.startswith("This query returns more than 2000 series, too many to replay")


# --- fix round 1 ------------------------------------------------------------------------------


def constant(start: float, end: float, value: float = 0.5, step_s: int = 60) -> Series:
    return Series(labels={}, points=[(t, value) for t in range(int(start), int(end) + 1, step_s)])


def test_a_breach_from_before_the_window_keeps_the_for_it_served():
    start, end = at(13, 0), at(19, 0)
    day = Condition("each", "above", 0.3, 86400, 60)
    data = constant(start - 86400, end)
    assert replay([data], day, start, end, lookback=86400)[1] == [(start, end, True)]
    # without the look back, the timer would start again at the window's start
    assert replay([data], day, start, end)[1] == []

    hour = Condition("each", "above", 0.3, 3600, 60)
    data = constant(start - 3600, end)
    episodes, periods = replay([data], hour, start, end, lookback=3600)
    assert periods == [(start, end, True)] and episodes[0].start == start
    # a firing that ended before the window isn't counted
    early = Series(labels={}, points=[(start - 600 + 60 * i, 0.5) for i in range(5)])
    assert replay([early], Condition("each", "above", 0.3, 0, 60), start, end, lookback=600) == (
        [],
        [],
    )


async def test_dry_run_reads_back_by_for(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    end = window_end()
    points = [(t, 0.5) for t in range(int(end - 30 * HOUR), int(end) + 1, 60)]
    fake_prometheus.results['errors_ratio{cluster="a"}'] = matrix(({"route": "/a"}, points))
    r = await http.post(DRY_RUN, json=body(linked_project.project_id, **{"for": "24h"}))
    assert r.status_code == 200, r.text
    out = r.json()
    [sent] = [q for q in fake_prometheus.requests if q.path == "/api/v1/query_range"]
    assert float(sent.params["start"][0]) <= out["start"] - 86400
    assert out["fired"] == 1 and out["firing_now"] is True
    assert out["periods"] == [{"start": out["start"], "end": out["end"], "ongoing": True}]

    r = await http.post(DRY_RUN, json=body(linked_project.project_id, **{"for": "1h"}))
    assert r.json()["periods"][0]["start"] == r.json()["start"]


async def test_a_group_has_one_budget_for_all_its_projects(
    monitoring_app, fake_prometheus, two_projects_on_one_source, monkeypatch
):
    http, _ = monitoring_app
    two = two_projects_on_one_source
    group = await add_group(http, "Pair", [two.a, two.b])
    end = window_end()
    points = six_hours(end - HOUR, end)
    for cluster in ("a", "b"):
        fake_prometheus.results[f'errors_ratio{{cluster="{cluster}"}}'] = matrix(({}, points))
    monkeypatch.setattr(dry_run_module, "MAX_REQUEST_POINTS", len(points) + 10)
    r = await http.post(DRY_RUN, json=body(group, scope={"kind": "group", "id": group}))
    assert r.status_code == 200, r.text
    team_a, team_b = r.json()["projects"]
    assert team_a["error"] is None and team_a["fired"] == 1
    assert team_b["error"] == {"code": "too_large", "message": dry_run_module.TOO_MANY_TOGETHER}
    assert team_b["fired"] == 0


async def test_a_replay_past_its_time_limit_says_so(
    monitoring_app, fake_prometheus, linked_project, monkeypatch
):
    http, _ = monitoring_app
    end = window_end()
    fake_prometheus.results['errors_ratio{cluster="a"}'] = matrix(({}, six_hours(end, end)))
    monkeypatch.setattr(dry_run_module, "REPLAY_SECONDS", -1.0)
    r = await http.post(DRY_RUN, json=body(linked_project.project_id))
    assert refusal(r) == (504, "timeout", dry_run_module.REPLAY_TOO_LONG)
    with pytest.raises(dry_run_module.ReplayTooLong):
        replay([constant(0, 600)], Condition("each", "above", 0, 0, 60), 0, 600, deadline=0.0)


def test_suggested_thresholds_are_only_calmer():
    values = Series(labels={}, points=[(float(i), i / 100) for i in range(1, 101)])
    assert candidate_thresholds([values], "above", calmer_than=0.95) == [0.96, 1.0, 1.1]
    assert candidate_thresholds([values], "above", calmer_than=2) == []
    low = Series(labels={}, points=[(float(i), float(i)) for i in range(100, 201)])
    assert candidate_thresholds([low], "below", calmer_than=105) == [100.0, 90.0]


async def test_dry_run_suggests_only_calmer_thresholds(
    monitoring_app, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    end = window_end()
    points = six_hours(end - 3 * HOUR, end - 2 * HOUR, value=0.5)
    fake_prometheus.results['errors_ratio{cluster="a"}'] = matrix(({}, points))
    r = await http.post(DRY_RUN, json=body(linked_project.project_id, threshold=0.5, suggest=True))
    assert [c["threshold"] for c in r.json()["candidates"]] == [0.55]
    r = await http.post(
        DRY_RUN,
        json=body(linked_project.project_id, op="below", threshold=0.1, suggest=True),
    )
    assert r.json()["candidates"] == [{"threshold": 0.09, "fired": 0}]


def _folded(series: Series, cond: Condition, start: float, end: float):
    """The live checks, one per step from `start` to `end`, as (fired at, last firing, ongoing)."""
    by_time = dict(series.points)
    previous: list = []
    out = []
    opened = last = None
    t = start
    while t <= end:
        samples = [Sample(series.labels, by_time[t])] if t in by_time else []
        r = step("t", previous, samples, cond, datetime.fromtimestamp(t, UTC))
        if r.fired:
            opened = t
        if any(i.state == "firing" for i in r.instances):
            last = t
        elif opened is not None:
            out.append((opened, last, False))
            opened = None
        previous = list(r.instances)
        t += cond.every_seconds
    if opened is not None:
        out.append((opened, last, last == end))
    return out


def test_replay_agrees_with_the_live_checks():
    rng = random.Random(20261119)
    for case in range(60):
        every = rng.choice((30, 60, 300))
        cond = Condition(
            "each", rng.choice(("above", "below")), 0.5, every * rng.randint(0, 5), every
        )
        start = 1_800_000_000 - 1_800_000_000 % every
        end = start + every * rng.randint(5, 80)
        points = []
        for t in range(start, end + 1, every):
            roll = rng.random()
            if roll < 0.08:
                continue  # missing point
            value = None if roll < 0.12 else math.nan if roll < 0.15 else rng.random()
            points.append((float(t), value))
        series = Series(labels={"case": str(case)}, points=points)
        _, periods = replay([series], cond, start, end)
        assert periods == _folded(series, cond, start, end), case


async def test_dry_run_says_when_for_has_not_passed(
    monitoring_app, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    end = window_end()
    # Above the threshold for the last 3 minutes only: the condition holds, its 10 min haven't passed.
    points = six_hours(end - 3 * 60, end + 60)
    fake_prometheus.results['errors_ratio{cluster="a"}'] = matrix(({"route": "/a"}, points))
    r = await http.post(DRY_RUN, json=body(linked_project.project_id, **{"for": "10m"}))
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["fired"], out["firing_now"], out["holding_now"]) == (0, False, True)

    # Once it fires, it is firing now, not holding.
    r = await http.post(DRY_RUN, json=body(linked_project.project_id, **{"for": "1m"}))
    out = r.json()
    assert (out["firing_now"], out["holding_now"]) == (True, False)

    # Quiet at the end: neither.
    fake_prometheus.results['errors_ratio{cluster="a"}'] = matrix(
        ({"route": "/a"}, six_hours(end - 3 * HOUR, end - 3 * HOUR + 60))
    )
    r = await http.post(DRY_RUN, json=body(linked_project.project_id, **{"for": "10m"}))
    assert (r.json()["firing_now"], r.json()["holding_now"]) == (False, False)
