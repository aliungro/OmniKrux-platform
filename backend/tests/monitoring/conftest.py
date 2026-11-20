"""Shared Monitoring fixtures: the stores over a fresh SQLite file, and the app."""

import itertools
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from omnikrux.config import Settings
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.main import create_app
from omnikrux.monitoring.projects.store import GroupStore, ProjectStore
from omnikrux.monitoring.sources.store import NewSource, SourceStore
from omnikrux.security.secrets import SecretBox

_names = itertools.count(1)


@dataclass
class Stores:
    """The three stores the Monitoring services are built on."""

    sources: SourceStore
    projects: ProjectStore
    groups: GroupStore


def new_source(**over) -> NewSource:
    """A URL-reached Prometheus without authentication; `over` replaces any field."""
    values = {
        "name": f"Prometheus · test {next(_names)}",
        "type": "prometheus",
        "reach": "url",
        "url": "http://prometheus.example:9090",
    }
    return NewSource(**(values | over))


@pytest.fixture
def db_path(tmp_path) -> Path:
    return tmp_path / "omnikrux.db"


@pytest.fixture
async def stores(tmp_path, db_path):
    settings = Settings(data_dir=tmp_path, kubeconfig="", in_container=False)
    engine = make_engine(f"sqlite+aiosqlite:///{db_path}")
    await init_db(engine)
    sessionmaker = make_sessionmaker(engine)
    box = SecretBox.from_settings(settings)
    yield Stores(
        sources=SourceStore(sessionmaker, box),
        projects=ProjectStore(sessionmaker),
        groups=GroupStore(sessionmaker),
    )
    await engine.dispose()


@pytest.fixture
def monitoring_client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    with TestClient(app) as client:
        yield client
