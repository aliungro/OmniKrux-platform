"""The pinned charts render with our values: what they create, the CustomResourceDefinitions
they ship, and the names the rest of the Monitoring app relies on. These run the real pinned
Helm and chart archives from `.tools/` and skip when they are absent."""

from types import MappingProxyType

import pytest
import yaml

from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.helm import HelmResult, SubprocessHelm
from omnikrux.monitoring.install.pins import CHARTS, HELM_VERSION
from omnikrux.monitoring.install.render import RenderRefused, chart_crds, render
from omnikrux.monitoring.install.settings import InstallSettings
from omnikrux.monitoring.install.tools import ToolsStatus
from omnikrux.monitoring.install.values import RELEASES, values_for
from tests.monitoring.fake_helm import FakeHelm, pinned_tools

pytestmark = pytest.mark.helm

KUBE_VERSION = "v1.31.0"
ALL_RELEASES = [spec for specs in RELEASES.values() for spec in specs]


@pytest.fixture
def real():
    helm_path, charts = pinned_tools()
    status = ToolsStatus(
        True,
        None,
        helm_path,
        f"v{HELM_VERSION}",
        MappingProxyType({key: charts / pin.file for key, pin in CHARTS.items()}),
    )
    return SubprocessHelm([helm_path]), status


async def rendered(real, spec, settings=None):
    settings = settings or InstallSettings()
    helm, status = real
    values = values_for(spec.release, settings, namespace="monitoring", cluster_name="kind-x")
    return await render(
        helm, status, spec, values, namespace="monitoring", kube_version=KUBE_VERSION
    )


@pytest.mark.parametrize("spec", ALL_RELEASES, ids=lambda s: s.release)
async def test_pinned_charts_render_with_our_values(real, spec):
    result = await rendered(real, spec)
    found = {(o.kind, o.name) for o in result.objects}
    for workload in spec.workloads:
        if not workload.made_by_operator:
            assert (workload.kind, workload.name) in found
    for name, _port in spec.services.values():
        assert ("Service", name) in found
    assert not [o for o in result.objects if o.kind == "Deployment" and "grafana" in o.name]
    assert not [o for o in result.objects if o.kind == "CustomResourceDefinition"]


async def test_loki_render_keeps_retention_and_names(real):
    loki = next(s for s in ALL_RELEASES if s.release == "omnikrux-loki")
    result = await rendered(real, loki)
    found = {(o.kind, o.name) for o in result.objects}
    assert ("StatefulSet", "omnikrux-loki") in found
    assert ("Service", "omnikrux-loki") in found
    config = "\n".join(
        str(d.get("data", {})) for d in result.documents if d["kind"] in ("ConfigMap", "Secret")
    )
    assert "retention_period: 168h" in config.replace("\\n", "\n")
    assert "retention_enabled: true" in config.replace("\\n", "\n")
    service = next(
        d
        for d in result.documents
        if d["kind"] == "Service" and d["metadata"]["name"] == "omnikrux-loki"
    )
    assert 3100 in [p["port"] for p in service["spec"]["ports"]]


async def test_loki_scratch_volume_when_persistence_is_off(real):
    loki = next(s for s in ALL_RELEASES if s.release == "omnikrux-loki")
    result = await rendered(real, loki, InstallSettings(persist=False))
    sts = next(d for d in result.documents if d["kind"] == "StatefulSet")
    spec = sts["spec"]["template"]["spec"]
    assert {"name": "data", "emptyDir": {}} in spec["volumes"]
    assert any(m["mountPath"] == "/var/loki" for m in spec["containers"][0]["volumeMounts"])


async def test_pinned_crds_include_alertmanagerconfig_with_msteamsv2(real):
    helm, status = real
    crds = await chart_crds(helm, status)
    names = {c["metadata"]["name"] for c in crds}
    assert len(crds) == 10, names
    assert all(n.endswith(".monitoring.coreos.com") for n in names)
    config = next(
        c for c in crds if c["metadata"]["name"] == "alertmanagerconfigs.monitoring.coreos.com"
    )
    receivers = [
        v["schema"]["openAPIV3Schema"]["properties"]["spec"]["properties"]["receivers"]["items"][
            "properties"
        ]
        for v in config["spec"]["versions"]
    ]
    assert any("msteamsv2Configs" in r for r in receivers), (
        "choose a newer kube-prometheus-stack chart in Task 1"
    )
    size = len(yaml.safe_dump(crds))
    print(f"chart CRDs: {len(crds)}, about {size} bytes as YAML")


async def test_operator_creates_prometheus_named_as_planned(real):
    metrics = next(s for s in ALL_RELEASES if s.release == "omnikrux-metrics")
    result = await rendered(real, metrics)
    by_kind = {o.kind: o.name for o in result.objects if o.kind in ("Prometheus", "Alertmanager")}
    assert by_kind == {
        "Prometheus": "omnikrux-metrics-prometheus",
        "Alertmanager": "omnikrux-metrics-alertmanager",
    }
    prometheus = next(d for d in result.documents if d["kind"] == "Prometheus")
    assert prometheus["spec"]["ruleSelector"]["matchLabels"]["release"] == "omnikrux-metrics"


@pytest.mark.parametrize("spec", ALL_RELEASES, ids=lambda s: s.release)
async def test_the_managed_by_marker_renders_in_every_chart(real, spec):
    helm, status = real
    values = values_for(spec.release, InstallSettings(), namespace="monitoring", cluster_name="k")
    assert values["omnikrux"] == {"managedBy": "omnikrux"}
    result = await render(
        helm, status, spec, values, namespace="monitoring", kube_version=KUBE_VERSION
    )
    assert result.objects


async def test_a_truncated_answer_is_refused_never_used():
    _, charts = pinned_tools()
    status = ToolsStatus(
        True,
        None,
        charts,
        f"v{HELM_VERSION}",
        MappingProxyType({key: charts / pin.file for key, pin in CHARTS.items()}),
    )
    cut = HelmResult(0, "kind: ConfigMap\n---\nkind: Sec", "", truncated=True)
    helm = FakeHelm(script={"template": cut, "show": cut})
    spec = ALL_RELEASES[1]
    with pytest.raises(RenderRefused) as refused:
        await render(helm, status, spec, {}, namespace="monitoring", kube_version=KUBE_VERSION)
    assert str(refused.value) == messages.RENDER_TOO_LONG.format(
        step=messages.RENDER_STEP.format(chart="loki")
    )
    with pytest.raises(RenderRefused) as refused:
        await chart_crds(helm, status)
    assert "too long to read in full" in str(refused.value)


async def test_a_helm_failure_is_said_in_words():
    _, charts = pinned_tools()
    status = ToolsStatus(
        True,
        None,
        charts,
        f"v{HELM_VERSION}",
        MappingProxyType({key: charts / pin.file for key, pin in CHARTS.items()}),
    )
    failed = HelmResult(1, "", "Error: values don't meet the specifications of the schema\n")
    with pytest.raises(RenderRefused) as refused:
        await render(
            FakeHelm(script={"template": failed}),
            status,
            ALL_RELEASES[0],
            {},
            namespace="monitoring",
            kube_version=KUBE_VERSION,
        )
    assert str(refused.value) == (
        "Helm couldn't read the kube-prometheus-stack chart with these settings: "
        "values don't meet the specifications of the schema"
    )
