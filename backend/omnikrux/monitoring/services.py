"""Everything the Monitoring routes need, built once at startup as `app.state.monitoring`."""

from __future__ import annotations

import asyncio
import logging
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.audit.store import AuditLog
from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.config import Settings
from omnikrux.kube.connections import ClusterConnections
from omnikrux.monitoring.alerts.contact_points.senders import SenderSet
from omnikrux.monitoring.alerts.contact_points.store import ContactPointStore
from omnikrux.monitoring.alerts.silences import SilenceStore
from omnikrux.monitoring.alerts.store import AlertStore
from omnikrux.monitoring.dashboards.store import DashboardStore
from omnikrux.monitoring.explore.catalog import CatalogCache
from omnikrux.monitoring.install.helm import MAX_OUTPUT, HelmResult, HelmRunner, SubprocessHelm
from omnikrux.monitoring.install.kubeconfig import remove_leftover_folders
from omnikrux.monitoring.install.store import InstallStore
from omnikrux.monitoring.install.tools import ToolsCheck
from omnikrux.monitoring.models import now
from omnikrux.monitoring.projects.store import GroupStore, ProjectStore
from omnikrux.monitoring.sources.capability import CapabilityCache
from omnikrux.monitoring.sources.connector import ConnectorRegistry, default_connectors
from omnikrux.monitoring.sources.discovery import Discovery
from omnikrux.monitoring.sources.health import HealthCache
from omnikrux.monitoring.sources.store import SourceStore
from omnikrux.monitoring.sources.transport import TransportFactory
from omnikrux.security.secrets import SecretBox

if TYPE_CHECKING:
    # Imported in `build_services`: the engine runs queries through `query.run`, which reads
    # these services.
    from omnikrux.monitoring.alerts.engine import AlertEngine
    from omnikrux.monitoring.alerts.notify import Notifier
    from omnikrux.monitoring.alerts.sync import AlertSync
    from omnikrux.monitoring.alerts.tool.loki_ruler import LokiRuler
    from omnikrux.monitoring.alerts.tool.prometheus_rule import PrometheusRuleAction
    from omnikrux.monitoring.alerts.tool.state_reader import ToolStateReader

log = logging.getLogger(__name__)

# The longest the app's startup waits for the rules' targets to be brought up to date; the rest
# carries on in the background while the engine runs.
STARTUP_RECONCILE_SECONDS = 15.0


def helm_temp_root() -> Path:
    """Where the startup sweep looks for Helm folders a hard stop left (tests point it at a
    temporary folder)."""
    return Path(tempfile.gettempdir())


class LazyHelm(HelmRunner):
    """Runs the pinned Helm the tools check found, looked up at the first call (so a start
    without Helm still works and says why at the moment an install needs it)."""

    def __init__(self, tools: ToolsCheck):
        self._tools = tools
        self._runner: SubprocessHelm | None = None

    async def run(
        self,
        args: Sequence[str],
        *,
        kubeconfig: Path | None,
        timeout: float,
        max_output: int = MAX_OUTPUT,
    ) -> HelmResult:
        if self._runner is None:
            status = await self._tools.status()
            if status.helm is None:
                raise OSError(status.message or "Helm isn't available")
            self._runner = SubprocessHelm([str(status.helm)])
        return await self._runner.run(
            args, kubeconfig=kubeconfig, timeout=timeout, max_output=max_output
        )


@dataclass
class MonitoringServices:
    sources: SourceStore
    projects: ProjectStore
    groups: GroupStore
    dashboards: DashboardStore
    transports: TransportFactory
    connectors: ConnectorRegistry
    health: HealthCache
    discovery: Discovery
    catalogs: CatalogCache
    alerts: AlertStore
    contact_points: ContactPointStore
    senders: SenderSet
    silences: SilenceStore
    audit: AuditLog
    sessionmaker: async_sessionmaker[AsyncSession]
    capabilities: CapabilityCache
    # What OmniKrux installed into each cluster, whether the pinned Helm and charts are here,
    # and the Helm runner (replaced by a fake in tests).
    installs: InstallStore
    install_tools: ToolsCheck
    helm: HelmRunner
    # Set by `build_services` (they need the services themselves).
    notifier: Notifier = field(init=False)
    engine: AlertEngine = field(init=False)
    alert_sync: AlertSync = field(init=False)
    # Plans and applies a target's PrometheusRule through the action pipeline.
    prometheus_rules: PrometheusRuleAction = field(init=False)
    # Writes and removes the rules that run in a Loki ruler.
    loki_ruler: LokiRuler = field(init=False)
    # Reads the state of the rules that run in a tool (in the engine's loop).
    tool_state: ToolStateReader = field(init=False)
    # The startup pass of `alert_sync.reconcile_all` (`start_alerts`), while it runs.
    startup_reconcile: asyncio.Task | None = field(default=None, init=False)

    async def start_alerts(self, wait: float | None = None) -> None:
        """Bring every rule's targets up to date in the background, wait for that at most
        `wait` seconds (STARTUP_RECONCILE_SECONDS; it isn't cancelled when the time is up), then
        start the engine. Never raises: `reconcile_all` logs its own failures. First: installs left
        running by a stop are marked failed, and stale Helm temp folders are removed."""
        await self._clean_up_after_a_stop()
        limit = STARTUP_RECONCILE_SECONDS if wait is None else wait
        task = asyncio.create_task(self.alert_sync.reconcile_all(), name="omnikrux-alert-reconcile")
        self.startup_reconcile = task
        await asyncio.wait({task}, timeout=limit)
        if not task.done():
            log.info(
                "Alert rules are still being brought up to date after %g s; "
                "the engine starts and that carries on.",
                limit,
            )
        self.engine.start()

    async def _clean_up_after_a_stop(self) -> None:
        """Nothing runs at startup: an install or uninstall still marked as running was cut short
        with OmniKrux, and a hard stop may have left a Helm kubeconfig folder behind."""
        try:
            await self.installs.mark_interrupted(now())
        except Exception:
            log.exception("Couldn't mark the installs that were cut short")
        try:
            await asyncio.to_thread(remove_leftover_folders, helm_temp_root())
        except Exception:
            log.exception("Couldn't remove the temporary Helm folders a stop left")

    async def close(self) -> None:
        """Release what the services hold, before the database engine is disposed: the alert
        engine stops (checks in flight end, their writes finish), the notifier's queued
        deliveries get up to 15 s and the rest are cancelled; then the catalog builds in flight
        (cancelled), then the transports' and the senders' HTTP sessions (the stores share the
        app's engine). A startup reconcile still running is cancelled first; a rule whose
        targets it is writing finishes handing them over before it stops."""
        task, self.startup_reconcile = self.startup_reconcile, None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self.engine.stop()
        await self.notifier.drain()
        await self.notifier.close()
        await self.catalogs.close()
        await self.transports.close()
        await self.senders.close()


def build_services(
    sessionmaker: async_sessionmaker[AsyncSession],
    box: SecretBox,
    connections: ClusterConnections,
    registry: ClusterRegistry,
    *,
    audit: AuditLog,
    alert_engine: bool,
    settings: Settings | None = None,
) -> MonitoringServices:
    """The one place that wires the Monitoring services; `main.py` calls it in the lifespan.
    `alert_engine` False (OMNIKRUX_ALERT_ENGINE=false): the engine is built but never starts,
    and nothing else that would run in its loop starts either (the tool state reader included)."""
    from omnikrux.monitoring.alerts.engine import AlertEngine
    from omnikrux.monitoring.alerts.notify import Notifier
    from omnikrux.monitoring.alerts.sync import AlertSync, ToolEngines
    from omnikrux.monitoring.alerts.tool.loki_ruler import LokiRuler
    from omnikrux.monitoring.alerts.tool.prometheus_rule import PrometheusRuleAction
    from omnikrux.monitoring.alerts.tool.state_reader import ToolStateReader

    sources = SourceStore(sessionmaker, box)
    transports = TransportFactory(connections, registry)
    connectors = default_connectors()
    discovery = Discovery(connections, registry, transports, connectors, sources)
    install_tools = ToolsCheck(settings if settings is not None else Settings())
    services = MonitoringServices(
        sources=sources,
        projects=ProjectStore(sessionmaker),
        groups=GroupStore(sessionmaker),
        dashboards=DashboardStore(sessionmaker),
        transports=transports,
        connectors=connectors,
        health=HealthCache(sources, transports, connectors, registry),
        discovery=discovery,
        catalogs=CatalogCache(),
        alerts=AlertStore(sessionmaker),
        contact_points=ContactPointStore(sessionmaker, box),
        senders=SenderSet(),
        silences=SilenceStore(sessionmaker),
        audit=audit,
        sessionmaker=sessionmaker,
        capabilities=CapabilityCache(connectors, transports, discovery, registry),
        installs=InstallStore(sessionmaker),
        install_tools=install_tools,
        helm=LazyHelm(install_tools),
    )
    services.notifier = Notifier(services)
    services.engine = AlertEngine(services, enabled=alert_engine)
    services.loki_ruler = LokiRuler(services)
    services.alert_sync = AlertSync(
        services, tool_sync=ToolEngines(services, loki=services.loki_ruler)
    )
    services.prometheus_rules = PrometheusRuleAction(services)
    services.tool_state = ToolStateReader(services)
    return services
