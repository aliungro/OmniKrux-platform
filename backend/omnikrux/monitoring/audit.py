"""Audit records for changes to Monitoring's own data: written before the change is made
("no audit, no change") and finished once it is known how it ended."""

from typing import Literal

from fastapi import HTTPException, Request

from omnikrux.audit.store import (
    Action,
    AppAuditEntry,
    AuditLog,
    AuditUnavailable,
    actor_of,
    no_audit_message,
)


async def begin_change(
    request: Request,
    action: Action,
    kind: Literal["source", "project", "group"],
    name: str,
    details: dict | None = None,
) -> int:
    """Write the `started` record and return its id; 503 (nothing changes) when it can't be
    written. `details` hold names and settings, never secret values."""
    audit: AuditLog = request.app.state.audit
    try:
        return await audit.begin_app(
            AppAuditEntry(
                actor=actor_of(request),
                app="monitoring",
                action=action,
                kind=kind,
                name=name,
                details=details,
            )
        )
    except AuditUnavailable as exc:
        raise HTTPException(status_code=503, detail=no_audit_message(exc)) from None


async def finish_change(
    request: Request, record_id: int, ok: bool, message: str | None = None
) -> None:
    """Record how the change ended. Never raises (the audit log logs its own failures)."""
    audit: AuditLog = request.app.state.audit
    await audit.finish(record_id, "succeeded" if ok else "failed", message)
