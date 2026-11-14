"""Opt-in checks and local regression tests for their safety gates."""

import os
from itertools import pairwise

PROVIDERS = {"azure": "azure", "aws": "aws", "gcp": "gcloud", "oci": "oci"}


def opted_in_provider(item):
    marker = item.get_closest_marker("cloud_live")
    if marker is None or item.get_closest_marker("kind") is not None:
        return None
    if item.config.getoption("markexpr") != "cloud_live":
        return None
    args = item.config.invocation_params.args
    explicit = ("-m", "cloud_live") in pairwise(args) or any(
        arg in {"-mcloud_live", "-m=cloud_live"} for arg in args
    )
    if not explicit:
        return None
    provider = marker.kwargs.get("provider")
    selected = {value.strip() for value in os.getenv("OMNIKRUX_LIVE_CLOUDS", "").split(",")}
    return (
        provider if isinstance(provider, str) and provider in PROVIDERS.keys() & selected else None
    )
