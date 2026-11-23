"""What the engine and notifier tests share: a project on the fake Prometheus, a webhook contact
point on the fake receiver, and the app's services with an engine driven by `tick(now)`.

Times are fixed (`T0` and offsets); the notifier waits nothing between retries."""

import asyncio
import socket
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from omnikrux.monitoring.alerts.engine import AlertEngine
from omnikrux.monitoring.alerts.notify import Notifier
from omnikrux.monitoring.alerts.rule_expr import eval_expr
from omnikrux.monitoring.alerts.store import RuleRecord, RuleSpec, TargetRecord, TargetSpec
from omnikrux.monitoring.alerts.types import Condition, Engine

T0 = datetime(2026, 11, 19, 10, 0, tzinfo=UTC)
MIN = timedelta(minutes=1)
HOUR = timedelta(hours=1)
CONTACT_POINTS = "/api/monitoring/alerts/contact-points"
NAME = "API latency high"
SENT = 'api_latency{cluster="a"}'  # what the fake receives for the expr `api_latency`


async def no_sleep(_seconds: float) -> None:
    return None


def vector(*items: tuple[dict, float]) -> dict:
    return {
        "resultType": "vector",
        "result": [{"metric": labels, "value": [T0.timestamp(), str(v)]} for labels, v in items],
    }


def closed_port_url() -> str:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{s.getsockname()[1]}"


async def until(check, seconds: float = 5.0) -> None:
    """Wait (yielding to the loop) until `check()` holds; fails after `seconds`."""
    deadline = time.monotonic() + seconds
    while not check():
        assert time.monotonic() < deadline, "condition never held"
        await asyncio.sleep(0.01)


@dataclass
class EngineEnv:
    http: object
    app: object
    services: object
    engine: AlertEngine
    prom: object
    webhook: object
    project_id: str
    source_id: str
    cp_id: str

    @property
    def notifier(self) -> Notifier:
        return self.services.notifier

    def queries(self) -> list:
        return [r for r in self.prom.requests if r.path == "/api/v1/query"]

    async def add_rule(
        self,
        *,
        name: str = NAME,
        expr: str = "api_latency",
        op: str = "above",
        threshold: float = 0.3,
        for_seconds: int = 300,
        every: int = 60,
        message: str = "",
        contact_points: tuple[str, ...] | None = None,
        engine: Engine = "omnikrux",
        source_id: str | None = "",
    ) -> tuple[RuleRecord, TargetRecord]:
        """A project rule with its one target (on the project's Prometheus unless said)."""
        alerts = self.services.alerts
        rule = await alerts.create_rule(
            RuleSpec(
                name=name,
                scope_kind="project",
                scope_id=self.project_id,
                source_type="prometheus",
                source_id=None,
                expr=expr,
                condition=Condition("each", op, threshold, for_seconds, every),
                severity="warning",
                message=message,
                contact_point_ids=(self.cp_id,) if contact_points is None else contact_points,
                engine=engine,
            )
        )
        await alerts.put_targets(
            rule.id,
            [
                TargetSpec(
                    project_id=self.project_id,
                    engine=engine,
                    engine_note=None,
                    source_id=self.source_id if source_id == "" else source_id,
                    eval_expr=eval_expr(expr, "each"),
                    rule_text="",
                    tool_kind="prometheus_rule" if engine == "tool" else None,
                )
            ],
        )
        [target] = await alerts.targets(rule_id=rule.id)
        return rule, target

    async def tick(self, at: datetime):
        """One tick at `at`, then every delivery it queued."""
        report = await self.engine.tick(at)
        assert await self.notifier.drain(10)
        return report

    async def target(self, rule: RuleRecord) -> TargetRecord:
        [target] = await self.services.alerts.targets(rule_id=rule.id)
        return target

    async def instances(self, rule: RuleRecord):
        return await self.services.alerts.instances((await self.target(rule)).id)

    async def add_contact_point(self, body: dict) -> str:
        r = await self.http.post(CONTACT_POINTS, json=body)
        assert r.status_code == 201, r.text
        return r.json()["id"]

    async def move_source(self, url: str) -> None:
        r = await self.http.patch(f"/api/monitoring/sources/{self.source_id}", json={"url": url})
        assert r.status_code == 200, r.text
