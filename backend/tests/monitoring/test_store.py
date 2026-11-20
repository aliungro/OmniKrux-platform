"""The Monitoring stores on a real SQLite file: sources with encrypted secrets, projects, links,
groups and delete reviews."""

import sqlite3
from datetime import UTC, datetime

import pytest
from sqlalchemy import inspect

from omnikrux.db import MIGRATIONS_DIR, init_db, make_engine
from omnikrux.monitoring.projects.types import (
    GroupRef,
    KeptSource,
    Matcher,
    ProjectRef,
    ReviewChanged,
    SourceRef,
    UnknownGroup,
    UnknownProject,
    review_token,
)
from omnikrux.monitoring.sources.store import SourceChange
from omnikrux.monitoring.sources.types import (
    ClusterTarget,
    NameTaken,
    SourceCheck,
    SourceSecrets,
)
from tests.monitoring.conftest import new_source

NAME_RULE = "Names are 1 to 80 characters, without line breaks."


async def test_source_secrets_are_encrypted_at_rest(stores, db_path):
    src = await stores.sources.create(
        new_source(auth_type="bearer", secrets=SourceSecrets(token="tok-SECRET-1"))
    )
    raw = sqlite3.connect(db_path).execute("select * from monitoring_sources").fetchall()
    assert b"tok-SECRET-1" not in repr(raw).encode()
    assert (await stores.sources.get(src.id)).secrets.token == "tok-SECRET-1"


async def test_custom_header_values_are_encrypted_and_names_are_not(stores, db_path):
    src = await stores.sources.create(
        new_source(
            header_names=("X-Scope-OrgID",),
            secrets=SourceSecrets(headers={"X-Scope-OrgID": "hv-SECRET-2"}),
        )
    )
    raw = repr(sqlite3.connect(db_path).execute("select * from monitoring_sources").fetchall())
    assert "hv-SECRET-2" not in raw and "X-Scope-OrgID" in raw
    got = await stores.sources.get(src.id)
    assert got.header_names == ("X-Scope-OrgID",)
    assert dict(got.secrets.headers) == {"X-Scope-OrgID": "hv-SECRET-2"}


async def test_secrets_never_show_in_a_repr(stores):
    src = await stores.sources.create(
        new_source(
            auth_type="basic",
            username="u",
            header_names=("X-A",),
            secrets=SourceSecrets(password="pw-SECRET-3", headers={"X-A": "hv-SECRET-3"}),
        )
    )
    assert "SECRET" not in repr(src) and "SECRET" not in repr(src.secrets)


async def test_update_keeps_secrets_unless_replaced(stores):
    src = await stores.sources.create(
        new_source(auth_type="bearer", secrets=SourceSecrets(token="tok-SECRET-1"))
    )
    renamed = await stores.sources.update(src.id, SourceChange(name="x"))
    assert renamed.name == "x" and renamed.secrets.token == "tok-SECRET-1"
    assert renamed.updated_at >= src.updated_at

    switched = await stores.sources.update(
        src.id,
        SourceChange(auth_type="basic", username="u", secrets=SourceSecrets(password="p")),
    )
    assert switched.auth_type == "basic" and switched.username == "u"
    assert switched.secrets.password == "p" and switched.secrets.token is None
    again = await stores.sources.get(src.id)
    assert again.secrets.token is None and again.secrets.password == "p"


async def test_update_replaces_only_the_secrets_it_is_given(stores):
    src = await stores.sources.create(
        new_source(
            auth_type="bearer",
            header_names=("X-A", "X-B"),
            secrets=SourceSecrets(token="t1", headers={"X-A": "a1", "X-B": "b1"}),
        )
    )
    got = await stores.sources.update(
        src.id,
        SourceChange(
            secrets=SourceSecrets(token="t2", headers={"X-B": "b2"}), header_names=("X-A", "X-B")
        ),
    )
    assert got.secrets.token == "t2"
    assert dict(got.secrets.headers) == {"X-A": "a1", "X-B": "b2"}
    dropped = await stores.sources.update(src.id, SourceChange(header_names=("X-B",)))
    assert dropped.header_names == ("X-B",) and dict(dropped.secrets.headers) == {"X-B": "b2"}


async def test_names_are_unique(stores):
    await stores.sources.create(new_source(name="Prometheus · a"))
    with pytest.raises(NameTaken) as caught:
        await stores.sources.create(new_source(name="Prometheus · a"))
    assert str(caught.value) == 'A source named "Prometheus · a" already exists. Pick another name.'
    assert await stores.sources.unique_name("Prometheus · a") == "Prometheus · a (2)"
    await stores.sources.create(new_source(name="Prometheus · a (2)"))
    assert await stores.sources.unique_name("Prometheus · a") == "Prometheus · a (3)"
    assert await stores.sources.unique_name("Loki · b") == "Loki · b"

    await stores.projects.create("shop", "kubernetes", None)
    with pytest.raises(NameTaken, match='A project named "shop" already exists'):
        await stores.projects.create(" shop ", "custom", None)
    await stores.groups.create("team", [])
    with pytest.raises(NameTaken, match='A group named "team" already exists'):
        await stores.groups.create("team", [])


@pytest.mark.parametrize("bad", ["", "   ", "a" * 81, "two\nlines", "tab\there"])
async def test_names_follow_the_rule(stores, bad):
    with pytest.raises(ValueError, match=NAME_RULE):
        await stores.sources.create(new_source(name=bad))
    with pytest.raises(ValueError, match=NAME_RULE):
        await stores.projects.create(bad, "custom", None)
    with pytest.raises(ValueError, match=NAME_RULE):
        await stores.groups.create(bad, [])


async def test_names_are_trimmed(stores):
    src = await stores.sources.create(new_source(name="  Loki · x  "))
    assert src.name == "Loki · x"
    assert (await stores.projects.create(" a " + "b" * 77 + " ", "custom", None)).name == (
        "a " + "b" * 77
    )


async def test_cluster_target_round_trips_and_is_found(stores):
    target = ClusterTarget("c1", "monitoring", "prometheus-server", "9090", "http")
    src = await stores.sources.create(
        new_source(reach="cluster", url=None, cluster=target, path_prefix="/prom")
    )
    got = await stores.sources.get(src.id)
    assert got.cluster == target and got.url is None and got.path_prefix == "/prom"
    assert (await stores.sources.find_cluster_target(target)).id == src.id
    other = ClusterTarget("c1", "monitoring", "loki", "3100", "http")
    assert await stores.sources.find_cluster_target(other) is None


async def test_record_check_is_kept_without_touching_updated_at(stores):
    src = await stores.sources.create(new_source())
    assert src.check is None
    moment = datetime(2026, 11, 19, 10, 0, tzinfo=UTC)
    await stores.sources.record_check(src.id, SourceCheck(True, None, "2.53.0", moment))
    got = await stores.sources.get(src.id)
    assert got.check == SourceCheck(True, None, "2.53.0", moment)
    assert got.updated_at == src.updated_at


async def test_unknown_source_raises_key_error(stores):
    with pytest.raises(KeyError):
        await stores.sources.get("missing")
    with pytest.raises(KeyError):
        await stores.sources.update("missing", SourceChange(name="x"))
    with pytest.raises(KeyError):
        await stores.sources.delete("missing")


async def test_links_store_their_filter_and_can_be_replaced(stores):
    project = await stores.projects.create("shop", "kubernetes", "c1")
    src = await stores.sources.create(new_source())
    matchers = (Matcher("namespace", "=", "shop"), Matcher("job", "=~", "web.*"))
    link = await stores.projects.link(project.id, src.id, matchers, "auto")
    assert link.matchers == matchers and link.origin == "auto"
    await stores.projects.link(project.id, src.id, (), "none")
    got = await stores.projects.get(project.id)
    assert [(lk.source_id, lk.matchers, lk.origin) for lk in got.links] == [(src.id, (), "none")]
    assert got.cluster_id == "c1" and got.kind == "kubernetes"
    await stores.projects.unlink(project.id, src.id)
    assert (await stores.projects.get(project.id)).links == ()
    with pytest.raises(UnknownProject):
        await stores.projects.link("missing", src.id, (), "none")
    with pytest.raises(KeyError):
        await stores.projects.link(project.id, "missing", (), "none")


async def test_rename_project(stores):
    a = await stores.projects.create("a", "custom", None)
    await stores.projects.create("b", "custom", None)
    assert (await stores.projects.rename(a.id, "c")).name == "c"
    with pytest.raises(NameTaken):
        await stores.projects.rename(a.id, "b")
    with pytest.raises(UnknownProject):
        await stores.projects.rename("missing", "z")


async def _owned_setup(stores):
    """Project A created s1 (only A uses it) and s2 (B links it too) and links s3, which it
    didn't create; A is in group G."""
    a = await stores.projects.create("A", "kubernetes", None)
    b = await stores.projects.create("B", "custom", None)
    s1 = await stores.sources.create(new_source(name="s1", created_by_project_id=a.id))
    s2 = await stores.sources.create(new_source(name="s2", created_by_project_id=a.id))
    s3 = await stores.sources.create(new_source(name="s3"))
    for src in (s1, s2, s3):
        await stores.projects.link(a.id, src.id, (Matcher("namespace", "=", "a"),), "auto")
    await stores.projects.link(b.id, s2.id, (), "none")
    g = await stores.groups.create("G", [a.id])
    return a, b, s1, s2, s3, g


async def test_project_delete_review_lists_what_it_owns(stores):
    a, _b, s1, s2, s3, g = await _owned_setup(stores)
    review = await stores.projects.delete_review(a.id)
    assert review.project_id == a.id and review.name == "A"
    assert review.sources_removed == (SourceRef(s1.id, "s1"),)
    assert review.sources_kept == (KeptSource(s2.id, "s2", ("B",)),)
    assert review.sources_unlinked == (SourceRef(s3.id, "s3"),)
    assert review.groups_left == (GroupRef(g.id, "G"),)
    fields = {
        "project_id": a.id,
        "name": "A",
        "sources_removed": [{"id": s1.id, "name": "s1"}],
        "sources_kept": [{"id": s2.id, "name": "s2", "used_by": ["B"]}],
        "sources_unlinked": [{"id": s3.id, "name": "s3"}],
        "groups_left": [{"id": g.id, "name": "G"}],
    }
    assert review.token == review_token(fields)
    with pytest.raises(UnknownProject):
        await stores.projects.delete_review("missing")


async def test_delete_with_stale_review_changes_nothing(stores):
    a, b, s1, s2, s3, g = await _owned_setup(stores)
    review = await stores.projects.delete_review(a.id)
    await stores.projects.link(b.id, s1.id, (), "none")
    with pytest.raises(ReviewChanged, match="Something changed since the review. Review it again."):
        await stores.projects.delete(a.id, review.token, stores.sources)
    got = await stores.projects.get(a.id)
    assert {lk.source_id for lk in got.links} == {s1.id, s2.id, s3.id}
    assert (await stores.sources.get(s1.id)).name == "s1"
    assert (await stores.groups.get(g.id)).project_ids == (a.id,)


async def test_joining_a_group_after_the_review_makes_it_stale(stores):
    a, *_ = await _owned_setup(stores)
    review = await stores.projects.delete_review(a.id)
    await stores.groups.create("H", [a.id])
    with pytest.raises(ReviewChanged):
        await stores.projects.delete(a.id, review.token, stores.sources)
    assert (await stores.projects.get(a.id)).name == "A"


async def test_delete_removes_owned_sources_links_and_memberships(stores):
    a, b, s1, s2, s3, g = await _owned_setup(stores)
    review = await stores.projects.delete_review(a.id)
    done = await stores.projects.delete(a.id, review.token, stores.sources)
    assert done == review
    with pytest.raises(UnknownProject):
        await stores.projects.get(a.id)
    with pytest.raises(KeyError):
        await stores.sources.get(s1.id)
    assert {s.id for s in await stores.sources.list()} == {s2.id, s3.id}
    assert (await stores.sources.get(s2.id)).created_by_project_id is None
    assert await stores.projects.projects_using(s3.id) == []
    assert await stores.projects.projects_using(s2.id) == [ProjectRef(b.id, "B")]
    group = await stores.groups.get(g.id)
    assert group.project_ids == ()
    assert [p.id for p in await stores.projects.list()] == [b.id]


async def test_group_membership_never_moves_projects(stores):
    a, b, *_, g = await _owned_setup(stores)
    before = {p.id: p.links for p in await stores.projects.list()}
    both = await stores.groups.create("Both", [a.id, b.id])
    assert set(both.project_ids) == {a.id, b.id}
    assert set((await stores.projects.get(a.id)).group_ids) == {g.id, both.id}
    await stores.groups.delete(both.id)
    with pytest.raises(UnknownGroup):
        await stores.groups.get(both.id)
    after = {p.id: p.links for p in await stores.projects.list()}
    assert after == before
    assert (await stores.projects.get(a.id)).group_ids == (g.id,)
    assert (await stores.projects.get(b.id)).group_ids == ()


async def test_group_update_and_unknown_members(stores):
    a = await stores.projects.create("A", "custom", None)
    b = await stores.projects.create("B", "custom", None)
    g = await stores.groups.create("G", [a.id])
    renamed = await stores.groups.update(g.id, name="H")
    assert renamed.name == "H" and renamed.project_ids == (a.id,)
    moved = await stores.groups.update(g.id, project_ids=[b.id, b.id])
    assert moved.project_ids == (b.id,)
    with pytest.raises(UnknownProject):
        await stores.groups.update(g.id, project_ids=["missing"])
    with pytest.raises(UnknownProject):
        await stores.groups.create("X", ["missing"])
    with pytest.raises(UnknownGroup):
        await stores.groups.update("missing", name="Y")
    with pytest.raises(UnknownGroup):
        await stores.groups.delete("missing")
    assert [x.name for x in await stores.groups.list()] == ["H"]


async def test_source_delete_review_and_delete_takes_its_links(stores):
    a = await stores.projects.create("A", "custom", None)
    b = await stores.projects.create("B", "custom", None)
    src = await stores.sources.create(new_source(name="s"))
    await stores.projects.link(b.id, src.id, (), "none")
    await stores.projects.link(a.id, src.id, (), "none")
    review = await stores.projects.source_delete_review(await stores.sources.get(src.id))
    assert review.source_id == src.id and review.name == "s"
    assert review.projects == (ProjectRef(a.id, "A"), ProjectRef(b.id, "B"))
    assert review.token == review_token(
        {
            "source_id": src.id,
            "name": "s",
            "projects": [{"id": a.id, "name": "A"}, {"id": b.id, "name": "B"}],
        }
    )
    await stores.sources.delete(src.id)
    assert (await stores.projects.get(a.id)).links == ()
    assert await stores.projects.projects_using(src.id) == []


async def test_one_session_for_a_whole_setup(stores):
    sessionmaker = stores.projects._sessionmaker
    async with sessionmaker.begin() as session:
        project = await stores.projects.create("shop", "kubernetes", "c1", session=session)
        src = await stores.sources.create(
            new_source(created_by_project_id=project.id), session=session
        )
        await stores.projects.link(project.id, src.id, (), "none", session=session)
    got = await stores.projects.get(project.id)
    assert [lk.source_id for lk in got.links] == [src.id]

    with pytest.raises(RuntimeError):
        async with sessionmaker.begin() as session:
            other = await stores.projects.create("rolled back", "custom", None, session=session)
            raise RuntimeError("stop")
    with pytest.raises(UnknownProject):
        await stores.projects.get(other.id)


async def test_migration_0007_upgrade_and_downgrade(tmp_path):
    from alembic import command
    from alembic.config import Config

    def migrate(conn, direction, rev):
        config = Config()
        config.set_main_option("script_location", str(MIGRATIONS_DIR))
        config.attributes["connection"] = conn
        getattr(command, direction)(config, rev)

    tables = {
        "monitoring_sources",
        "monitoring_projects",
        "monitoring_project_sources",
        "monitoring_groups",
        "monitoring_group_members",
    }
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/m.db")
    await init_db(engine)
    async with engine.begin() as conn:
        names = await conn.run_sync(lambda c: set(inspect(c).get_table_names()))
        assert tables <= names
        indexes = await conn.run_sync(
            lambda c: {
                i["name"]
                for t in ("monitoring_project_sources", "monitoring_group_members")
                for i in inspect(c).get_indexes(t)
            }
        )
        assert indexes == {
            "ix_monitoring_project_sources_source_id",
            "ix_monitoring_group_members_project_id",
        }
        await conn.run_sync(migrate, "downgrade", "0006")
        names = await conn.run_sync(lambda c: set(inspect(c).get_table_names()))
        assert not tables & names
    await init_db(engine)
    await engine.dispose()
