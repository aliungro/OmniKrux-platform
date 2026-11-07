"""What a cluster serves: every resource of each API group's preferred version that can be listed
and watched, the groups that couldn't be read, and the printer columns of its CRDs.

One broken API group (an aggregated API whose backend is down answers 503) is recorded and
skipped; it never hides the others. Only the core list (`/api/v1`) and the group list (`/apis`)
failing make the whole cluster unavailable.
"""

import asyncio
import json
import logging
from dataclasses import dataclass

from kubernetes_asyncio.client import ApiClient

from omnikrux.kube.client import ClusterUnavailable
from omnikrux.kube.http import status_message

logger = logging.getLogger(__name__)

DISCOVERY_TIMEOUT_SECONDS = 30
MAX_CONCURRENT_GROUPS = 8
REQUIRED_VERBS = frozenset({"list", "watch"})
CRD_GROUP = "apiextensions.k8s.io"
CRDS_PATH = f"/apis/{CRD_GROUP}/v1/customresourcedefinitions"
UNEXPECTED = "The cluster's API discovery failed: it answered with something unexpected"


@dataclass(frozen=True)
class ApiResource:
    group: str
    version: str
    plural: str
    kind: str
    namespaced: bool
    verbs: frozenset[str]
    short_names: tuple[str, ...]


@dataclass
class Discovery:
    resources: list[ApiResource]
    failed_groups: dict[str, str]  # group -> why its kinds are missing, in plain words
    # (group, plural) -> the preferred version's additionalPrinterColumns, for CRDs that have any
    printer_columns: dict[tuple[str, str], list[dict]]


class _Refused(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status
        self.message = message


class _Unexpected(Exception):
    """The answer was 2xx but not the JSON document asked for (an HTML login page, say)."""


async def discover(api: ApiClient, *, timeout: float = DISCOVERY_TIMEOUT_SECONDS) -> Discovery:
    """Discover what the cluster serves, within one deadline `timeout` seconds from now.

    Raises `ClusterUnavailable` (in words) when the core or group list can't be read; connection
    errors (aiohttp) there propagate as they are. A group still unanswered at the deadline, or
    failing in any way, is only that group's entry in `failed_groups`."""
    deadline = asyncio.get_running_loop().time() + timeout
    try:
        async with asyncio.timeout_at(deadline):
            core = _resources("", "v1", await _get(api, "/api/v1", timeout))
            versions = _preferred_versions(await _get(api, "/apis", timeout))
    except TimeoutError as exc:
        raise ClusterUnavailable(f"The cluster API did not respond within {timeout:g} s") from exc
    except _Refused as exc:
        if exc.status == 401:
            message = f"The cluster rejected the console's credentials: {exc.message}"
        elif exc.status == 403:
            message = f"Not allowed to read the cluster's API list: {exc.message}"
        else:
            message = f"The cluster's API discovery failed: {exc.status} {exc.message}"
        raise ClusterUnavailable(message) from exc
    except _Unexpected as exc:
        raise ClusterUnavailable(UNEXPECTED) from exc

    limit = asyncio.Semaphore(MAX_CONCURRENT_GROUPS)

    async def group_resources(group: str, version: str) -> list[ApiResource] | str:
        try:
            async with asyncio.timeout_at(deadline), limit:  # waiting for a slot counts too
                body = await _get(api, f"/apis/{group}/{version}", timeout)
            return _resources(group, version, body)
        except TimeoutError:
            why = f"The {group} API didn't answer within {timeout:g} s"
        except _Refused as exc:
            if exc.status == 403:
                return f"Not allowed to read the {group} API: {exc.message}"
            why = f"The {group} API didn't answer ({exc.status}: {exc.message})"
        except _Unexpected:
            why = f"The {group} API answered with something unexpected"
        except Exception as exc:  # noqa: BLE001 (one group never fails the others)
            logger.warning("reading API group %s failed (%s)", group, type(exc).__name__)
            why = f"The {group} API couldn't be read ({type(exc).__name__})"
        return f"{why}; its kinds are hidden until it does."

    results, printer = await asyncio.gather(
        asyncio.gather(*(group_resources(g, v) for g, v in versions.items())),
        _crd_printer_columns(api, versions, timeout, deadline),
    )
    resources, failed = list(core), {}
    for group, result in zip(versions, results, strict=True):
        if isinstance(result, str):
            failed[group] = result
        else:
            resources.extend(result)
    return Discovery(resources=resources, failed_groups=failed, printer_columns=printer)


async def _get(api: ApiClient, path: str, timeout: float = DISCOVERY_TIMEOUT_SECONDS) -> dict:
    resp = await api.call_api(
        path,
        "GET",
        header_params={"Accept": "application/json"},
        auth_settings=["BearerToken"],
        _preload_content=False,
        _return_http_data_only=True,
        _request_timeout=(timeout, timeout),
    )
    try:
        body = await resp.read()
    finally:
        resp.release()
    if not 200 <= resp.status < 300:
        raise _Refused(resp.status, status_message(body) or resp.reason or "no details")
    try:
        data = json.loads(body)
    except ValueError as exc:
        raise _Unexpected from exc
    if not isinstance(data, dict):
        raise _Unexpected
    return data


def _resources(group: str, version: str, body: dict) -> list[ApiResource]:
    """The listable, watchable resources of one APIResourceList; subresources are skipped."""
    entries = body.get("resources")
    if not isinstance(entries, list):
        raise _Unexpected
    found = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name, kind = entry.get("name"), entry.get("kind")
        verbs = frozenset(v for v in entry.get("verbs") or () if isinstance(v, str))
        if not isinstance(name, str) or not name or "/" in name or not isinstance(kind, str):
            continue
        if not REQUIRED_VERBS <= verbs:
            continue
        found.append(
            ApiResource(
                group=group,
                version=version,
                plural=name,
                kind=kind,
                namespaced=bool(entry.get("namespaced")),
                verbs=verbs,
                short_names=tuple(s for s in entry.get("shortNames") or () if isinstance(s, str)),
            )
        )
    return found


def _preferred_versions(body: dict) -> dict[str, str]:
    """group -> its preferred version, from an APIGroupList."""
    groups = body.get("groups")
    if not isinstance(groups, list):
        raise _Unexpected
    versions = {}
    for group in groups:
        if not isinstance(group, dict) or not isinstance(name := group.get("name"), str):
            continue
        preferred = (group.get("preferredVersion") or {}).get("version")
        if not preferred:
            listed = [v.get("version") for v in group.get("versions") or [] if isinstance(v, dict)]
            preferred = next((v for v in listed if v), None)
        if isinstance(preferred, str) and preferred:
            versions[name] = preferred
    return versions


async def _crd_printer_columns(
    api: ApiClient, versions: dict[str, str], timeout: float, deadline: float
) -> dict[tuple[str, str], list[dict]]:
    """Each CRD's printer columns for the version discovery uses; {} when they can't be read by
    the deadline (the CRDs then keep generic columns)."""
    if CRD_GROUP not in versions:
        return {}
    try:
        async with asyncio.timeout_at(deadline):
            body = await _get(api, CRDS_PATH, timeout)
    except Exception as exc:  # noqa: BLE001 (printer columns are optional)
        logger.info("CRD printer columns not read (%s); CRDs keep generic columns", exc)
        return {}
    items = body.get("items")
    columns = {}
    for crd in items if isinstance(items, list) else []:
        spec = (crd.get("spec") or {}) if isinstance(crd, dict) else {}
        names = spec.get("names") if isinstance(spec, dict) else None
        group = spec.get("group") if isinstance(spec, dict) else None
        plural = names.get("plural") if isinstance(names, dict) else None
        listed = spec.get("versions") if isinstance(spec, dict) else None
        crd_versions = (
            [v for v in listed if isinstance(v, dict)] if isinstance(listed, list) else []
        )
        chosen = next((v for v in crd_versions if v.get("name") == versions.get(group)), None)
        chosen = chosen or next((v for v in crd_versions if v.get("storage")), None)
        printer = (chosen or {}).get("additionalPrinterColumns")
        if isinstance(group, str) and isinstance(plural, str) and isinstance(printer, list):
            columns[(group, plural)] = [c for c in printer if isinstance(c, dict)]
    return columns
