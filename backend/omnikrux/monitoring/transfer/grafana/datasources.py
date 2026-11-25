"""Which data source a Grafana panel or query points at, as a key an import can map."""

import re
from dataclasses import dataclass
from typing import Literal

_LOKI_START = re.compile(r"^\s*\{")
_LOKI_CALL = re.compile(r"\(\s*\{")
_VARIABLE = re.compile(
    r"^\s*(?:\$\{([A-Za-z_]\w*)(?::[^}]*)?\}|\$([A-Za-z_]\w*)|\[\[([A-Za-z_]\w*)(?::[^\]]*)?\]\])\s*$"
)
SPECIAL = {"-- mixed --": "mixed", "-- grafana --": "grafana", "-- dashboard --": "dashboard"}


@dataclass(frozen=True)
class GrafanaDatasource:
    uid: str
    name: str
    type: str
    url: str | None
    is_default: bool


@dataclass(frozen=True)
class GrafanaContext:
    datasources: tuple[GrafanaDatasource, ...] = ()
    alert_rules: tuple[dict, ...] | None = None
    alert_rules_note: str | None = None


@dataclass(frozen=True)
class Ref:
    key: str
    type: str | None
    name: str


@dataclass(frozen=True)
class Special:
    kind: Literal["mixed", "grafana", "dashboard"]


DsResolution = Ref | Special


def guess_type(exprs: list[str]) -> Literal["prometheus", "loki"]:
    """Loki when any expression starts a stream selector or calls a function on one."""
    for expr in exprs:
        if _LOKI_START.search(expr) or _LOKI_CALL.search(expr):
            return "loki"
    return "prometheus"


def _text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _default(ctx, default_key: str) -> Ref:
    for ds in ctx.datasources:
        if ds.is_default:
            return Ref(f"grafana:uid:{ds.uid}", ds.type or None, ds.name)
    return Ref(default_key, None, "Default data source")


def _variable_ref(name: str, inputs: dict, ds_vars: dict) -> Ref:
    if name in inputs:
        entry = inputs[name] if isinstance(inputs[name], dict) else {}
        label = _text(entry.get("label")) or name
        return Ref(f"grafana:input:{name}", _text(entry.get("pluginId")), label)
    plugin = ds_vars.get(name)
    return Ref(f"grafana:var:{name}", _text(plugin) if isinstance(plugin, str) else None, name)


def resolve(raw, *, ctx, inputs: dict, ds_vars: dict, default_key: str) -> DsResolution:
    """A panel's or target's `datasource` field (text, object or missing) as a Ref or Special."""
    plugin: str | None = None
    token: str | None = None
    by_uid = False
    if isinstance(raw, dict):
        plugin = _text(raw.get("type"))
        token = _text(raw.get("uid"))
        by_uid = True
        if token is None and plugin is not None and plugin.lower() in SPECIAL.values():
            return Special(plugin.lower())  # type: ignore[arg-type]
    elif isinstance(raw, str):
        token = _text(raw)
    if token is None:
        base = _default(ctx, default_key)
        return Ref(base.key, base.type or plugin, base.name)
    special = SPECIAL.get(token.lower())
    if special:
        return Special(special)  # type: ignore[arg-type]
    if token.lower() == "grafana" and by_uid and plugin in (None, "datasource", "grafana"):
        return Special("grafana")
    m = _VARIABLE.match(token)
    if m:
        ref = _variable_ref(m.group(1) or m.group(2) or m.group(3), inputs, ds_vars)
        return Ref(ref.key, ref.type or plugin, ref.name)
    for ds in ctx.datasources:
        if ds.uid == token or (not by_uid and ds.name == token):
            return Ref(f"grafana:uid:{ds.uid}", ds.type or plugin, ds.name)
    if by_uid:
        return Ref(f"grafana:uid:{token}", plugin, token)
    return Ref(f"grafana:name:{token}", None, token)
