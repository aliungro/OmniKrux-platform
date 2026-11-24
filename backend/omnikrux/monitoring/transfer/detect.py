"""Reading the text a user pastes or uploads, and telling what kind of file it is."""

import json
from typing import Literal

from omnikrux.monitoring.transfer.envelope import ENVELOPE_MARK
from omnikrux.monitoring.transfer.types import NEWER_FORMAT, TransferError  # noqa: F401

MAX_IMPORT_BYTES = 10 * 1024 * 1024
FormatName = Literal["omnikrux_export", "omnikrux_dashboard", "grafana"]

NOT_JSON = "This isn't valid JSON: {reason}. Check that the whole file or text was copied."
TOO_LARGE = "This is larger than 10 MB. Export fewer dashboards at a time."
UNKNOWN_FORMAT = (
    "This doesn't look like an OmniKrux export or a Grafana dashboard. "
    "Export the dashboard again and import that file."
)
GRAFANA_LIST = "Paste one Grafana dashboard at a time, or an OmniKrux export."


def _refuse_constant(name: str):
    raise ValueError(f"{name} is not allowed")


def parse_import_text(text: str) -> object:
    if len(text.encode("utf-8", errors="surrogatepass")) > MAX_IMPORT_BYTES:
        raise TransferError(413, "too_large", TOO_LARGE)
    try:
        return json.loads(text, parse_constant=_refuse_constant)
    except json.JSONDecodeError as e:
        reason = f"{e.msg} (line {e.lineno}, column {e.colno})"
    except RecursionError:
        reason = "it is nested too deeply"
    except ValueError as e:
        reason = str(e)
    raise TransferError(422, "invalid_input", NOT_JSON.format(reason=reason))


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def detect_format(value: object) -> tuple[FormatName, object]:
    if isinstance(value, list):
        raise TransferError(422, "invalid_input", GRAFANA_LIST)
    if isinstance(value, dict):
        if value.get("omnikrux") == ENVELOPE_MARK:
            return "omnikrux_export", value
        if isinstance(value.get("dashboard"), dict) and "meta" in value:
            return "grafana", value["dashboard"]
        panels = value.get("panels")
        version = value.get("schemaVersion")
        if (
            _is_int(version)
            and version == 1
            and isinstance(panels, list)
            and all("queries" in p and "gridPos" not in p for p in panels if isinstance(p, dict))
        ):
            return "omnikrux_dashboard", value
        if (
            isinstance(panels, list)
            or isinstance(value.get("rows"), list)
            or (_is_int(version) and version >= 2)
        ):
            return "grafana", value
    raise TransferError(422, "unknown_format", UNKNOWN_FORMAT)
