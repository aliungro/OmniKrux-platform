"""One check of an alert condition: which series breach it, and how each series' state moves.

Pure: no I/O and no clock. The caller passes the time of the check, the series it read and the
instances the previous check left; the answer says what to store and what to tell.
"""

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from omnikrux.monitoring.alerts.store import InstanceRecord
from omnikrux.monitoring.alerts.types import Condition, TargetState


def fingerprint(labels: Mapping[str, str]) -> str:
    """The series' identity: sha256 of its sorted label pairs, first 16 hex characters."""
    pairs = sorted((str(k), str(v)) for k, v in labels.items())
    text = json.dumps(pairs, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def breaches(value: float | None, cond: Condition) -> bool:
    """Whether one value breaks the condition. No value (None, NaN) never breaches."""
    if value is None or math.isnan(value):
        return False
    return value > cond.threshold if cond.op == "above" else value < cond.threshold


def shown(value: float | None) -> float | None:
    """The value an instance keeps: a finite number, else None. ±Inf still breaches (it was
    compared before this); the instance's state says why it is pending or firing, and its value
    never carries a number JSON, the store or a message can't hold."""
    return value if value is not None and math.isfinite(value) else None


@dataclass(frozen=True)
class Sample:
    """One series' value at the check."""

    labels: Mapping[str, str]
    value: float | None


@dataclass(frozen=True)
class StepResult:
    instances: tuple[InstanceRecord, ...]  # pending and firing after this check, by fingerprint
    fired: tuple[InstanceRecord, ...]  # became firing in this check
    resolved: tuple[InstanceRecord, ...]  # were firing and no longer breach (or are gone)
    state: TargetState


def _by_fingerprint(records: Sequence[InstanceRecord]) -> tuple[InstanceRecord, ...]:
    return tuple(sorted(records, key=lambda r: r.fingerprint))


def step(
    target_id: str,
    previous: Sequence[InstanceRecord],
    samples: Sequence[Sample],
    cond: Condition,
    now: datetime,
) -> StepResult:
    """The next state of a target after a check at `now` that read `samples`.

    Per series: breaching and new is pending from now (firing at once when `for` is 0);
    breaching and pending for at least `for` fires now; not breaching, or gone, drops (a firing
    one is resolved). Values follow every check, as `shown` keeps them (None when not finite).
    The target is firing when any series fires, else pending when any is pending, else no data
    when no sample carries a value (none read, or every one None or NaN), else OK.
    """
    before = {r.fingerprint: r for r in previous}
    hold = timedelta(seconds=cond.for_seconds)
    instances: list[InstanceRecord] = []
    fired: list[InstanceRecord] = []
    resolved: list[InstanceRecord] = []
    seen: set[str] = set()

    for sample in samples:
        fp = fingerprint(sample.labels)
        if fp in seen:  # the same series twice: the first answer counts
            continue
        seen.add(fp)
        old = before.get(fp)
        if not breaches(sample.value, cond):
            if old is not None and old.state == "firing":
                resolved.append(replace(old, target_id=target_id, value=shown(sample.value)))
            continue
        labels = dict(sample.labels)
        if old is None:
            firing = cond.for_seconds == 0
            record = InstanceRecord(
                target_id=target_id,
                fingerprint=fp,
                labels=labels,
                state="firing" if firing else "pending",
                active_since=now,
                fired_at=now if firing else None,
                value=shown(sample.value),
                last_notified_at=None,
            )
            if firing:
                fired.append(record)
        elif old.state == "pending" and now - old.active_since >= hold:
            record = replace(
                old,
                target_id=target_id,
                labels=labels,
                state="firing",
                fired_at=now,
                value=shown(sample.value),
            )
            fired.append(record)
        else:
            record = replace(old, target_id=target_id, labels=labels, value=shown(sample.value))
        instances.append(record)

    for fp, old in before.items():
        if fp not in seen and old.state == "firing":
            resolved.append(replace(old, target_id=target_id))

    if any(r.state == "firing" for r in instances):
        state: TargetState = "firing"
    elif instances:
        state = "pending"
    elif not any(s.value is not None and not math.isnan(s.value) for s in samples):
        state = "no_data"
    else:
        state = "ok"
    return StepResult(
        instances=_by_fingerprint(instances),
        fired=_by_fingerprint(fired),
        resolved=_by_fingerprint(resolved),
        state=state,
    )


def restored(
    previous: Sequence[InstanceRecord],
    last_eval_at: datetime | None,
    every_seconds: int,
    now: datetime,
) -> list[InstanceRecord]:
    """The instances to carry on with after a restart. Firing ones are kept (they were told and
    must not be told again). A pending one is kept only when the last check was at most two
    intervals ago: after a longer pause its timer would count time nobody checked."""
    recent = last_eval_at is not None and now - last_eval_at <= timedelta(seconds=2 * every_seconds)
    return [r for r in previous if r.state == "firing" or (r.state == "pending" and recent)]
