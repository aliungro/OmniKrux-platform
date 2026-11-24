"""What the install review reads from the cluster before it plans anything: its version, the
default storage class, the namespace, the Prometheus Operator's CustomResourceDefinitions, any
Prometheus Operator OmniKrux didn't install, and the Helm releases with OmniKrux's names.

Only reads, through the cluster's own API client. A read that fails raises (the action pipeline
words it, cloud privacy kept); a Helm release Secret that can't be decoded reads as a release
OmniKrux didn't make, never as one of its own."""

import asyncio
import base64
import binascii
import json
import zlib
from collections.abc import Sequence
from urllib.parse import quote

from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.actions.pipeline import ClusterRef
from omnikrux.kube.http import call_json
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.monitoring.install.settings import ClusterFacts, ReleaseRef
from omnikrux.monitoring.install.values import MANAGED_BY, RELEASES
from omnikrux.resources.kinds import object_name_problem

OPERATOR_VERSION = "operator.prometheus.io/version"
DEFAULT_CLASS = (
    "storageclass.kubernetes.io/is-default-class",
    "storageclass.beta.kubernetes.io/is-default-class",
)
CRD_PATH = "/apis/apiextensions.k8s.io/v1/customresourcedefinitions/{name}"
# The labels kube-prometheus-stack (and the plain prometheus-operator chart) put on the
# operator's Deployment, across chart versions.
OPERATOR_SELECTORS = (
    "app.kubernetes.io/name in (prometheus-operator,kube-prometheus-stack-prometheus-operator)",
    "app=kube-prometheus-stack-operator",
)
OUR_OPERATOR_INSTANCE = "omnikrux-metrics"
RELEASE_NAMES: tuple[str, ...] = tuple(
    spec.release for specs in RELEASES.values() for spec in specs
)
# A release record bigger than this when unpacked isn't Helm's: it is read as not ours.
_MAX_RELEASE_BYTES = 64 * 1024 * 1024
_GZIP_MAGIC = b"\x1f\x8b"


async def _get(api: ApiClient, path: str, query: Sequence[tuple[str, str]] = ()) -> dict:
    return await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT, query=query)


async def _get_or_none(api: ApiClient, path: str) -> dict | None:
    try:
        return await _get(api, path)
    except ApiException as exc:
        if exc.status == 404:
            return None
        raise


def _labels(obj: dict) -> dict:
    labels = (obj.get("metadata") or {}).get("labels")
    return labels if isinstance(labels, dict) else {}


def _annotations(obj: dict) -> dict:
    annotations = (obj.get("metadata") or {}).get("annotations")
    return annotations if isinstance(annotations, dict) else {}


def _items(answer: dict) -> list[dict]:
    items = answer.get("items")
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


async def _kube_version(api: ApiClient) -> str:
    answer = await _get(api, "/version")
    version = answer.get("gitVersion")
    return version if isinstance(version, str) and version else ""


async def _default_storage_class(api: ApiClient) -> str | None:
    answer = await _get(api, "/apis/storage.k8s.io/v1/storageclasses")
    defaults = sorted(
        str((sc.get("metadata") or {}).get("name") or "")
        for sc in _items(answer)
        if any(_annotations(sc).get(key) == "true" for key in DEFAULT_CLASS)
    )
    return next((name for name in defaults if name), None)


async def _crd_versions(api: ApiClient, names: Sequence[str]) -> dict[str, str | None]:
    """Each named CRD that exists, with its `operator.prometheus.io/version` annotation."""
    wanted = [n for n in dict.fromkeys(names) if object_name_problem(n, None) is None]
    found = await asyncio.gather(
        *(_get_or_none(api, CRD_PATH.format(name=quote(n, safe=""))) for n in wanted)
    )
    out: dict[str, str | None] = {}
    for name, crd in zip(wanted, found, strict=True):
        if crd is not None:
            version = _annotations(crd).get(OPERATOR_VERSION)
            out[name] = version if isinstance(version, str) else None
    return out


async def _foreign_operator(api: ApiClient, namespace: str) -> str | None:
    """`{namespace}/{name}` of a Prometheus Operator Deployment that isn't this install's own: our
    instance counts as ours only in `namespace`. Elsewhere (a second OmniKrux on the cluster, or
    one whose records were lost) it is another install that would fight over the same objects."""
    answers = await asyncio.gather(
        *(
            _get(api, "/apis/apps/v1/deployments", query=[("labelSelector", selector)])
            for selector in OPERATOR_SELECTORS
        )
    )
    found = set()
    for answer in answers:
        for deployment in _items(answer):
            meta = deployment.get("metadata") or {}
            if (
                _labels(deployment).get("app.kubernetes.io/instance") == OUR_OPERATOR_INSTANCE
                and meta.get("namespace") == namespace
            ):
                continue
            found.add(f"{meta.get('namespace') or ''}/{meta.get('name') or ''}")
    return min(found) if found else None


def _unpack(data: str) -> dict:
    """Helm's release record: the API's base64, then Helm's base64, then (usually) gzip, then
    JSON. ValueError when it isn't one (cut, too large, too deeply nested, or not an object)."""
    try:
        packed = base64.b64decode(base64.b64decode(data, validate=True), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("not base64") from exc
    if packed.startswith(_GZIP_MAGIC):
        unzip = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
        try:
            packed = unzip.decompress(packed, _MAX_RELEASE_BYTES)
        except zlib.error as exc:
            raise ValueError("not gzip") from exc
        if unzip.unconsumed_tail or not unzip.eof:
            raise ValueError("cut short or too large")
    try:
        release = json.loads(packed)
    except (ValueError, RecursionError) as exc:  # RecursionError: nested too deeply
        raise ValueError("not JSON") from exc
    if not isinstance(release, dict):
        raise ValueError("not a release")  # noqa: TRY004 (one error for every bad record)
    return release


def _revision(secret: dict) -> int:
    try:
        return int(_labels(secret).get("version") or 0)
    except (TypeError, ValueError):
        return 0


def decode_release(secret: dict) -> ReleaseRef:
    """One Helm release Secret (`sh.helm.release.v1.<name>.v<revision>`) as a ReleaseRef. Its
    owner is `omnikrux` only when the release's own values carry `omnikrux.managedBy:
    omnikrux`; a record that can't be read keeps what its labels say and has no owner."""
    labels = _labels(secret)
    name = str(labels.get("name") or "")
    status = str(labels.get("status") or "")
    data = secret.get("data") if isinstance(secret.get("data"), dict) else {}
    owner, chart_version, deployed_at = None, None, None
    try:
        release = _unpack(str(data.get("release") or ""))
    except Exception:  # noqa: BLE001 (any record that can't be read is not ours)
        release = None
    if release is not None:
        config = release.get("config") if isinstance(release.get("config"), dict) else {}
        marker = config.get("omnikrux") if isinstance(config.get("omnikrux"), dict) else {}
        if marker.get("managedBy") == MANAGED_BY:
            owner = MANAGED_BY
        chart = release.get("chart") if isinstance(release.get("chart"), dict) else {}
        meta = chart.get("metadata") if isinstance(chart.get("metadata"), dict) else {}
        if isinstance(meta.get("version"), str):
            chart_version = meta["version"]
        info = release.get("info") if isinstance(release.get("info"), dict) else {}
        if not status and isinstance(info.get("status"), str):
            status = info["status"]
        if isinstance(info.get("last_deployed"), str):
            deployed_at = info["last_deployed"]
    return ReleaseRef(
        name=name,
        revision=_revision(secret),
        status=status,
        owner_label=owner,
        chart_version=chart_version,
        deployed_at=deployed_at,
    )


async def read_releases(api: ApiClient, namespace: str) -> dict[str, ReleaseRef]:
    """The latest revision of each release with one of OmniKrux's names in the namespace (a
    valid namespace name), read from Helm's own records."""
    return await _releases(api, namespace)


async def _releases(api: ApiClient, namespace: str) -> dict[str, ReleaseRef]:
    """The latest revision of each release with one of OmniKrux's names in the namespace."""
    selector = f"owner=helm,name in ({','.join(RELEASE_NAMES)})"
    answer = await _get(
        api, f"/api/v1/namespaces/{namespace}/secrets", query=[("labelSelector", selector)]
    )
    latest: dict[str, dict] = {}
    for secret in _items(answer):
        name = _labels(secret).get("name")
        if name not in RELEASE_NAMES:
            continue
        if name not in latest or _revision(secret) > _revision(latest[name]):
            latest[name] = secret
    # Only the latest revision of each is unpacked (a release record can be large).
    refs = await asyncio.to_thread(lambda: [decode_release(s) for s in latest.values()])
    return {ref.name: ref for ref in refs}


async def read_facts(
    api: ApiClient,
    cluster: ClusterRef,
    namespace: str,
    *,
    crd_names: Sequence[str] = (),
    kube_version: str | None = None,
) -> ClusterFacts:
    """Read the cluster for an install into `namespace` (a valid namespace name).

    `crd_names`: the CustomResourceDefinitions the chart ships (`chart_crds`); each that exists
    is read with its operator version. `kube_version`: the cluster's version when the caller
    already has it; read from `/version` otherwise."""
    if object_name_problem(namespace, namespace) is not None:
        raise ValueError("not a namespace name")
    version, storage_class, ns, crds, foreign, releases = await asyncio.gather(
        _kube_version(api) if kube_version is None else _given(kube_version),
        _default_storage_class(api),
        _get_or_none(api, f"/api/v1/namespaces/{namespace}"),
        _crd_versions(api, crd_names),
        _foreign_operator(api, namespace),
        _releases(api, namespace),
    )
    return ClusterFacts(
        cluster_id=cluster.id,
        cluster_name=cluster.name,
        kube_version=version,
        default_storage_class=storage_class,
        namespace_exists=ns is not None,
        served_monitoring_crds=crds,
        foreign_operator=foreign,
        releases=releases,
        environment=cluster.environment,
    )


async def _given(value: str) -> str:
    return value
