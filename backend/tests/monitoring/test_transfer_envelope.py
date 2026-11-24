"""The OmniKrux export file: reading it back, its words and the transfer digest."""

import copy
from dataclasses import replace
from datetime import UTC, datetime

import pytest

from omnikrux.monitoring.dashboards.schema import Problem
from omnikrux.monitoring.sources.types import ClusterTarget, SourceConfig, SourceSecrets
from omnikrux.monitoring.transfer.detect import NEWER_FORMAT
from omnikrux.monitoring.transfer.envelope import (
    ENVELOPE_MARK,
    FORMAT_VERSION,
    MAX_EXPORT_DASHBOARDS,
    envelope,
    read_envelope,
    source_entry,
)
from omnikrux.monitoring.transfer.types import (
    AlertDraft,
    ConvertedDashboard,
    ExportedCluster,
    Identity,
    SkippedItem,
    SourceRefFound,
    TransferError,
    digest,
)

DASHBOARDS_COPY = "An export holds 1 to 200 dashboards."


def query(ref="A", source_id="src-1", kind="prometheus"):
    return {"ref": ref, "source": {"type": kind, "id": source_id}, "expr": "up"}


def dash(title="API latency", source_id="src-1", panels=None):
    if panels is None:
        panels = [
            {
                "id": "p-1",
                "type": "timeseries",
                "title": "Rate",
                "layout": {"x": 0, "y": 0, "w": 12, "h": 8},
                "queries": [query(source_id=source_id)],
            }
        ]
    return {"schemaVersion": 1, "title": title, "panels": panels}


def project_file():
    return {
        "omnikrux": "monitoring-export",
        "formatVersion": 1,
        "kind": "project",
        "exportedAt": "2026-11-19T10:00:00Z",
        "owner": {"kind": "project", "name": "prod-east"},
        "project": {
            "name": "prod-east",
            "kind": "kubernetes",
            "cluster": "prod-east",
            "links": [{"source": "src-1", "filter": 'cluster="prod-east"'}],
        },
        "sources": [
            {
                "key": "src-1",
                "type": "prometheus",
                "name": "Prometheus",
                "reach": "cluster",
                "url": None,
                "cluster": {
                    "name": "prod-east",
                    "namespace": "monitoring",
                    "service": "prometheus-server",
                    "port": "80",
                    "scheme": "http",
                },
                "pathPrefix": "",
                "auth": "none",
                "headerNames": [],
            },
            {
                "key": "src-2",
                "type": "loki",
                "name": "Loki",
                "reach": "url",
                "url": "https://loki.example.invalid",
                "cluster": None,
                "pathPrefix": "/loki",
                "auth": "bearer",
                "headerNames": ["X-Scope-OrgID"],
            },
        ],
        "dashboards": [
            {"exportId": "d8f3", "owner": "project", "version": 3, "dashboard": dash()},
            {"exportId": "a1b2", "owner": "project", "version": 1, "dashboard": dash("Second")},
        ],
    }


def test_envelope_reads_sources_and_dashboards():
    read = read_envelope(project_file())
    assert (read.kind, read.owner_kind, read.owner_name) == ("project", "project", "prod-east")
    assert read.project["name"] == "prod-east" and read.group is None
    assert [s.key for s in read.sources] == ["src-1", "src-2"]
    assert read.sources[0] == SourceRefFound(
        key="src-1",
        type="prometheus",
        type_guessed=False,
        name="Prometheus",
        url=None,
        cluster=ExportedCluster("prod-east", "monitoring", "prometheus-server", "80", "http"),
        path_prefix="",
        auth="none",
        filter='cluster="prod-east"',
    )
    assert read.sources[1].url == "https://loki.example.invalid"
    assert read.sources[1].cluster is None and read.sources[1].filter is None
    assert [d.key for d in read.dashboards] == ["d-1", "d-2"]
    assert [d.export_id for d in read.dashboards] == ["d8f3", "a1b2"]
    first = read.dashboards[0]
    assert first.problems == () and first.owner_kind == "project" and first.title == "API latency"
    assert first.doc["description"] == "" and first.doc["panels"][0]["alert"] is None
    assert read.skipped_by_key == {"d-1": (), "d-2": ()}


def test_newer_format_is_refused_in_words():
    for version, message in [
        (2, NEWER_FORMAT.format(n=2)),
        (0, "Expected 1."),
        ("1", "Expected 1."),
    ]:
        value = project_file() | {"formatVersion": version}
        with pytest.raises(TransferError) as e:
            read_envelope(value)
        assert (e.value.status, e.value.code) == (422, "invalid_input")
        assert e.value.problems == (Problem("formatVersion", message),)
    assert "export format 2" in NEWER_FORMAT.format(n=2)


def test_envelope_problems_in_words():
    value = project_file()
    value["kind"] = "team"
    value["owner"] = {"kind": "org", "name": "x"}
    value["sources"][0]["type"] = "tempo"
    value["sources"][1]["key"] = "src-1"
    value["dashboards"] = []
    with pytest.raises(TransferError) as e:
        read_envelope(value)
    assert e.value.problems == (
        Problem("kind", 'Use "dashboard", "project" or "group".'),
        Problem("owner.kind", 'Use "project" or "group".'),
        Problem("sources[0].type", 'Use "prometheus" or "loki".'),
        Problem("sources[1].key", "Each source needs its own key."),
        Problem("dashboards", DASHBOARDS_COPY),
    )
    value = project_file()
    value["dashboards"] = [value["dashboards"][0]] * (MAX_EXPORT_DASHBOARDS + 1)
    with pytest.raises(TransferError) as e:
        read_envelope(value)
    assert e.value.problems == (Problem("dashboards", DASHBOARDS_COPY),)
    value = project_file()
    del value["sources"][0]["key"]
    with pytest.raises(TransferError) as e:
        read_envelope(value)
    assert e.value.problems[0] == Problem("sources[0].key", "Each source needs its own key.")


def test_a_broken_dashboard_does_not_break_the_others():
    value = project_file()
    value["dashboards"][1]["dashboard"]["panels"][0]["layout"]["w"] = 30
    read = read_envelope(value)
    ok, broken = read.dashboards
    assert ok.doc is not None and ok.problems == ()
    assert broken.doc is None and broken.title == "Second"
    assert broken.problems == (
        Problem("dashboard.panels[0].layout.w", "Use a whole number from 2 to 24."),
    )
    assert read.skipped_by_key["d-2"] == ()


def test_unknown_source_key_becomes_null_and_is_listed():
    value = project_file()
    value["dashboards"][0]["dashboard"]["panels"][0]["queries"] = [
        query("A", "src-9"),
        query("B", "src-1"),
        query("C", None),
        query("D", "src-8", kind="loki"),
    ]
    read = read_envelope(value)
    queries = read.dashboards[0].doc["panels"][0]["queries"]
    assert [q["source"]["id"] for q in queries] == [None, "src-1", None, None]
    assert read.skipped_by_key["d-1"] == (
        SkippedItem(
            'Panel "Rate"',
            "Query A",
            "It named a source the file doesn't list, so it uses the first "
            "Prometheus-compatible source.",
        ),
        SkippedItem(
            'Panel "Rate"',
            "Query D",
            "It named a source the file doesn't list, so it uses the first Loki source.",
        ),
    )


def test_a_group_export():
    value = {
        "omnikrux": ENVELOPE_MARK,
        "formatVersion": FORMAT_VERSION,
        "kind": "group",
        "owner": {"kind": "group", "name": "Production"},
        "group": {"name": "Production", "projects": ["prod-east", "prod-west"]},
        "sources": [],
        "dashboards": [{"exportId": "g1", "owner": "group", "dashboard": dash(source_id=None)}],
    }
    read = read_envelope(value)
    assert read.kind == "group" and read.project is None and read.sources == ()
    assert read.group["projects"] == ["prod-east", "prod-west"]
    assert read.dashboards[0].owner_kind == "group" and read.dashboards[0].doc is not None


def test_writing_the_envelope_and_source_entries():
    cfg = SourceConfig(
        id="internal-id",
        name="Prometheus",
        type="prometheus",
        reach="cluster",
        url=None,
        cluster=ClusterTarget("internal-cluster", "monitoring", "prometheus-server", "80", "http"),
        path_prefix="",
        auth_type="basic",
        username="admin",
        header_name=None,
        client_cert_pem=None,
        ca_pem="CA-PEM",
        header_names=("X-Org",),
        secrets=SourceSecrets(password="hunter2", headers={"X-Org": "secret-value"}),
        created_by_project_id=None,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
        check=None,
    )
    entry = source_entry(cfg, "src-1", "prod-east", 'cluster="prod-east"')
    text = repr(entry)
    for private in (
        "hunter2",
        "secret-value",
        "admin",
        "internal-id",
        "internal-cluster",
        "CA-PEM",
    ):
        assert private not in text
    assert entry["cluster"]["name"] == "prod-east" and entry["auth"] == "basic"
    assert entry["headerNames"] == ["X-Org"] and entry["url"] is None
    by_url = replace(cfg, reach="url", url="https://p.example.invalid", cluster=None)
    plain = source_entry(by_url, "src-2", None)
    assert plain["cluster"] is None and plain["url"] == "https://p.example.invalid"
    assert "filter" not in plain

    out = envelope(
        "project",
        owner_kind="project",
        owner_name="prod-east",
        sources=[entry],
        dashboards=[],
        project={"name": "prod-east"},
        group={"name": "ignored"},
        now=datetime(2026, 11, 19, 10, 0, 0, tzinfo=UTC),
    )
    assert list(out) == [
        "omnikrux",
        "formatVersion",
        "kind",
        "exportedAt",
        "owner",
        "project",
        "sources",
        "dashboards",
    ]
    assert out["exportedAt"] == "2026-11-19T10:00:00Z"
    assert out["owner"] == {"kind": "project", "name": "prod-east"}
    grouped = envelope(
        "group",
        owner_kind="group",
        owner_name="G",
        sources=[],
        dashboards=[],
        group={"name": "G", "projects": []},
        now=datetime(2026, 11, 19, 10, 0, 0),
    )
    assert "project" not in grouped and grouped["group"]["name"] == "G"
    single = envelope(
        "dashboard",
        owner_kind="group",
        owner_name="G",
        sources=[],
        dashboards=[],
        now=datetime(2026, 1, 1),
    )
    assert "project" not in single and "group" not in single


def converted(**changes):
    draft = AlertDraft("A", "last", "above", 1.0, 60, "t", "m", None, None)
    base = ConvertedDashboard(
        key="d-1",
        title="A",
        doc=dash("A"),
        refs=(),
        skipped=(SkippedItem("Panel", "Query A", "because"),),
        alerts=(("p-1", draft),),
        problems=(),
        identity=Identity("grafana", "uid-1", 3),
        panel_sources=(("p-1", "7"),),
    )
    return replace(base, **changes)


def test_digest_is_stable_and_sensitive():
    a = converted()
    assert digest(a) == digest(converted(doc=copy.deepcopy(a.doc)))
    assert len(digest(a)) == 64
    assert digest(a) != digest(converted(skipped=(SkippedItem("Panel", "Query A", "other"),)))
    assert digest(a) != digest(converted(doc=dash("B")))
    assert digest(a) != digest(converted(alerts=()))
    assert digest(a) != digest(converted(problems=(Problem("x", "y"),), doc=None))
    # Where a panel came from, and the dashboard's identity, are not what a reviewer saw.
    assert digest(a) == digest(converted(panel_sources=(("p-1", "99"),)))
    assert digest(a) == digest(converted(identity=Identity("omnikrux", "x", None)))
