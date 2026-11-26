"""Routes for contact points: list, add, change, test and remove them.

Secrets are write-only: they come in as `SecretStr`, go straight into the store (encrypted) and
come back only as the names in `secrets_set`. Audit `details` carry the type and key names,
never a value. Every answer about a delivery is the senders' copy, which never carries an
address, a token or a password."""

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from omnikrux.monitoring.alerts.contact_points.senders import (
    SENT,
    DeliveryFailed,
    notice_for_test,
)
from omnikrux.monitoring.alerts.contact_points.store import ContactPointStore
from omnikrux.monitoring.alerts.contact_points.types import (
    TYPE_FIXED,
    ContactPoint,
    ContactPointInvalid,
    ContactPointType,
    Resolved,
    SecretNeeded,
    UnknownContactPoint,
    resolve,
    stored_problem,
    summary_of,
)
from omnikrux.monitoring.alerts.store import RuleRef
from omnikrux.monitoring.alerts.sync import AlertChangeOut, change_out
from omnikrux.monitoring.audit import begin_change, finish_change
from omnikrux.monitoring.dashboards.api import drop_contact_point
from omnikrux.monitoring.models import now
from omnikrux.monitoring.projects.types import REVIEW_CHANGED, ReviewChanged
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.rules import refuse
from omnikrux.monitoring.sources.types import NameTaken

log = logging.getLogger(__name__)

router = APIRouter(prefix="/alerts/contact-points")

GONE = "That contact point doesn't exist anymore. It may have been removed."
NOT_SAVED = "The contact point couldn't be saved. Try again."
NOT_REMOVED = "The contact point couldn't be removed. Try again."


# --- Shapes ------------------------------------------------------------------------------------


class ContactPointIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    type: ContactPointType
    settings: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, SecretStr | None] = Field(default_factory=dict)


class ContactPointPatch(BaseModel):
    """Every field optional. `settings` are merged onto the stored ones; a secret left out or
    sent as `null` keeps the stored value, `""` clears an optional one. `type` can't change."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    type: ContactPointType | None = None
    settings: dict[str, Any] | None = None
    secrets: dict[str, SecretStr | None] | None = None


class RuleRefOut(BaseModel):
    id: str
    name: str


class DeliveryOut(BaseModel):
    at: datetime
    ok: bool
    message: str | None


class ContactPointOut(BaseModel):
    id: str
    name: str
    type: ContactPointType
    settings: dict[str, Any]
    secrets_set: list[str]
    summary: str
    used_by: list[RuleRefOut]
    last_delivery: DeliveryOut | None
    created_at: datetime
    updated_at: datetime
    # What is wrong with the stored address, in words (a Slack address that isn't Slack's).
    problem: str | None = None


class ContactPointChangedOut(ContactPointOut):
    """The PATCH answer: the contact point, and what its change asks for elsewhere (the
    contact points in an Alertmanager OmniKrux installed that now need a review)."""

    alert_changes: list[AlertChangeOut]


class ContactPointDeleteOut(BaseModel):
    alert_changes: list[AlertChangeOut]


class ContactPointDeleteReviewOut(BaseModel):
    id: str
    name: str
    used_by: list[RuleRefOut]
    token: str


class TestOut(BaseModel):
    __test__ = False  # not a pytest test class, whatever module imports it

    ok: bool
    message: str


# --- Helpers -----------------------------------------------------------------------------------


def _services(request: Request) -> MonitoringServices:
    return request.app.state.monitoring


def _store(request: Request) -> ContactPointStore:
    return _services(request).contact_points


async def _contact_point(store: ContactPointStore, id: str) -> ContactPoint:
    try:
        return await store.get(id)
    except UnknownContactPoint:
        raise HTTPException(status_code=404, detail=GONE) from None


def _plain(secrets: dict[str, SecretStr | None] | None) -> dict[str, str | None]:
    return {
        key: value.get_secret_value() if value is not None else None
        for key, value in (secrets or {}).items()
    }


def _invalid(exc: ContactPointInvalid) -> HTTPException:
    """422 with the copy; a secret that must be entered again is named as the field (in the
    shape of a request-validation answer, so the form can mark that field)."""
    if isinstance(exc, SecretNeeded):
        loc = ["body", "secrets", exc.field]
        return HTTPException(
            status_code=422, detail=[{"type": "secret_needed", "loc": loc, "msg": exc.message}]
        )
    return refuse(exc.message)


def _checked(type: ContactPointType, **values: Any) -> Resolved:
    try:
        return resolve(type, **values)
    except ContactPointInvalid as exc:
        raise _invalid(exc) from None


def _refs(refs: list[RuleRef] | tuple[RuleRef, ...]) -> list[RuleRefOut]:
    return [RuleRefOut(id=r.id, name=r.name) for r in refs]


def _out(cp: ContactPoint, used_by: list[RuleRef]) -> ContactPointOut:
    last = None
    if cp.last_delivery_at is not None:
        last = DeliveryOut(
            at=cp.last_delivery_at,
            ok=bool(cp.last_delivery_ok),
            message=cp.last_delivery_message,
        )
    return ContactPointOut(
        id=cp.id,
        name=cp.name,
        type=cp.type,
        settings=dict(cp.settings),
        secrets_set=cp.secrets_set,
        summary=summary_of(cp),
        used_by=_refs(used_by),
        last_delivery=last,
        created_at=cp.created_at,
        updated_at=cp.updated_at,
        problem=stored_problem(cp),
    )


async def _alert_changes(request: Request) -> list[AlertChangeOut]:
    """The installs whose contact points now need a review (never raises)."""
    changes = await _services(request).alert_sync.contact_changes()
    return [change_out(c) for c in changes]


async def _send_test(request: Request, cp: ContactPoint) -> TestOut:
    """One attempt (no retries), so the answer comes within the send limit."""
    try:
        await _services(request).senders.send(cp, notice_for_test(cp.name))
    except DeliveryFailed as exc:
        log.info("Test of contact point %s (%s) failed: %s", cp.id or "-", cp.type, exc.message)
        return TestOut(ok=False, message=exc.message)
    return TestOut(ok=True, message=SENT)


# --- Routes ------------------------------------------------------------------------------------


@router.get("")
async def list_contact_points(request: Request) -> list[ContactPointOut]:
    store = _store(request)
    usage = await store.usage()
    return [_out(cp, usage.get(cp.id, [])) for cp in await store.list()]


@router.post("", status_code=201)
async def add_contact_point(body: ContactPointIn, request: Request) -> ContactPointOut:
    store = _store(request)
    secrets = _plain(body.secrets)
    checked = _checked(body.type, name=body.name, settings=body.settings, secrets=secrets)
    details = {
        "type": body.type,
        "settings": sorted(checked.settings),
        "secrets": sorted(checked.secrets or {}),
    }
    record = await begin_change(
        request, "contact_point_add", "contact_point", checked.name, details
    )
    try:
        created = await store.create(body.name, body.type, body.settings, secrets)
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except ContactPointInvalid as exc:
        await finish_change(request, record, False, exc.message)
        raise _invalid(exc) from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return _out(created, [])


@router.post("/test")
async def test_unsaved_contact_point(body: ContactPointIn, request: Request) -> TestOut:
    """Send a test to a contact point as entered; nothing is stored."""
    checked = _checked(
        body.type, name=body.name, settings=body.settings, secrets=_plain(body.secrets)
    )
    moment = now()
    cp = ContactPoint(
        id="",
        name=checked.name,
        type=body.type,
        settings=checked.settings,
        secrets=checked.secrets or {},
        last_delivery_at=None,
        last_delivery_ok=None,
        last_delivery_message=None,
        created_at=moment,
        updated_at=moment,
    )
    record = await begin_change(
        request, "contact_point_test", "contact_point", cp.name, {"type": cp.type, "saved": False}
    )
    out = await _send_test(request, cp)
    await finish_change(request, record, out.ok, None if out.ok else out.message)
    return out


@router.patch("/{id}")
async def change_contact_point(
    id: str, body: ContactPointPatch, request: Request
) -> ContactPointChangedOut:
    store = _store(request)
    old = await _contact_point(store, id)
    if body.type is not None and body.type != old.type:
        raise refuse(TYPE_FIXED)
    secrets = _plain(body.secrets)
    checked = _checked(
        old.type,
        name=body.name if body.name is not None else old.name,
        settings=body.settings or {},
        secrets=secrets,
        stored_settings=old.settings,
        stored_secrets=old.secrets,
        secrets_unreadable=old.secrets_unreadable,
    )
    details: dict[str, Any] = {
        "type": old.type,
        "settings": sorted(body.settings or {}),
        "secrets": sorted(key for key, value in secrets.items() if value),
    }
    if cleared := sorted(key for key, value in secrets.items() if value == ""):
        details["secrets_cleared"] = cleared
    record = await begin_change(
        request, "contact_point_change", "contact_point", checked.name, details
    )
    try:
        updated = await store.update(id, name=body.name, settings=body.settings, secrets=secrets)
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except UnknownContactPoint:
        await finish_change(request, record, False, GONE)
        raise HTTPException(status_code=404, detail=GONE) from None
    except ContactPointInvalid as exc:
        await finish_change(request, record, False, exc.message)
        raise _invalid(exc) from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    out = _out(updated, await store.used_by(id))
    return ContactPointChangedOut(**dict(out), alert_changes=await _alert_changes(request))


@router.post("/{id}/test")
async def test_contact_point(id: str, request: Request) -> TestOut:
    """Send a test to a saved contact point; the result is kept as its last delivery."""
    store = _store(request)
    cp = await _contact_point(store, id)
    record = await begin_change(
        request, "contact_point_test", "contact_point", cp.name, {"type": cp.type, "saved": True}
    )
    out = await _send_test(request, cp)
    message = None if out.ok else out.message
    at = now()
    try:
        await store.record_delivery(id, out.ok, message, at)
        await store.add_delivery(id, None, "test", out.ok, message, at)
    except UnknownContactPoint:  # removed while the test ran
        pass
    await finish_change(request, record, out.ok, message)
    return out


@router.get("/{id}/delete-review")
async def contact_point_delete_review(id: str, request: Request) -> ContactPointDeleteReviewOut:
    try:
        review = await _store(request).delete_review(id)
    except UnknownContactPoint:
        raise HTTPException(status_code=404, detail=GONE) from None
    return ContactPointDeleteReviewOut(
        id=review.id, name=review.name, used_by=_refs(review.used_by), token=review.token
    )


@router.delete("/{id}")
async def remove_contact_point(id: str, token: str, request: Request) -> ContactPointDeleteOut:
    store = _store(request)
    try:
        review = await store.delete_review(id)
    except UnknownContactPoint:
        raise HTTPException(status_code=404, detail=GONE) from None
    record = await begin_change(
        request,
        "contact_point_remove",
        "contact_point",
        review.name,
        {"removed_from": [r.name for r in review.used_by]},
    )
    try:
        await store.delete(id, token)
    except ReviewChanged:
        await finish_change(request, record, False, REVIEW_CHANGED)
        raise HTTPException(status_code=409, detail=REVIEW_CHANGED) from None
    except UnknownContactPoint:
        await finish_change(request, record, False, GONE)
        raise HTTPException(status_code=404, detail=GONE) from None
    except Exception:
        await finish_change(request, record, False, NOT_REMOVED)
        raise
    await finish_change(request, record, True)
    # Panel alerts name it in their dashboards' documents: those are saved without it.
    await drop_contact_point(request, id, review.name)
    return ContactPointDeleteOut(alert_changes=await _alert_changes(request))
