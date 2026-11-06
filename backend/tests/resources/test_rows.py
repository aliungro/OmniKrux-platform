import pytest

from omnikrux.resources.rows import pod_row, pod_status


def pod(phase="Running", statuses=(), init=(), deleting=False, reason=None):
    md = {"uid": "u1", "name": "p", "namespace": "ns", "creationTimestamp": "2026-11-06T10:00:00Z"}
    if deleting:
        md["deletionTimestamp"] = "2026-11-06T11:00:00Z"
    st = {"phase": phase, "containerStatuses": list(statuses), "initContainerStatuses": list(init)}
    if reason:
        st["reason"] = reason
    return {"metadata": md, "spec": {"nodeName": "n1"}, "status": st}


def c(ready=True, restarts=0, waiting=None, terminated=None, last_finished=None):
    state = (
        {"waiting": {"reason": waiting}}
        if waiting
        else {"terminated": {"reason": terminated, "exitCode": 1}}
        if terminated
        else {"running": {}}
    )
    last = (
        {"terminated": {"reason": "OOMKilled", "exitCode": 137, "finishedAt": last_finished}}
        if last_finished
        else {}
    )
    return {"name": "c", "ready": ready, "restartCount": restarts, "state": state, "lastState": last}


@pytest.mark.parametrize(
    "p,expected",
    [
        (pod(statuses=[c()]), ("Running", "ok")),
        (pod(statuses=[c(ready=False)]), ("Not ready", "warn")),
        (pod(statuses=[c(ready=False, waiting="CrashLoopBackOff")]), ("CrashLoopBackOff", "bad")),
        (pod(statuses=[c(ready=False, waiting="ImagePullBackOff")]), ("ImagePullBackOff", "bad")),
        (pod("Pending", statuses=[c(ready=False, waiting="ContainerCreating")]), ("ContainerCreating", "warn")),
        (pod("Pending"), ("Pending", "warn")),
        (pod("Succeeded"), ("Completed", "done")),
        (pod("Failed", reason="Evicted"), ("Evicted", "bad")),
        (pod(statuses=[c()], deleting=True), ("Terminating", "warn")),
        (pod("Pending", init=[c(ready=False, waiting="CrashLoopBackOff")]), ("Init:CrashLoopBackOff", "bad")),
        (pod(statuses=[c(ready=False, terminated="OOMKilled")]), ("OOMKilled", "bad")),
    ],
)
def test_pod_status(p, expected):
    assert pod_status(p) == expected


def test_pod_row_columns():
    r = pod_row(
        pod(statuses=[c(restarts=14, ready=False, waiting="CrashLoopBackOff", last_finished="2026-11-06T14:04:14Z"), c()]),
        "cl1",
    )
    assert (r.uid, r.cluster_id, r.kind, r.namespace, r.name) == ("u1", "cl1", "Pod", "ns", "p")
    assert r.columns["ready"] == "1/2" and r.columns["restarts"] == 14
    assert r.columns["node"] == "n1" and r.columns["last_restart_at"] == "2026-11-06T14:04:14Z"


def test_pod_row_tolerates_missing_fields():
    r = pod_row({"metadata": {"uid": "u2", "name": "bare"}}, "cl1")
    assert r.namespace is None and r.created_at is None
    assert r.columns["ready"] == "0/0" and r.columns["restarts"] == 0
    assert r.columns["node"] is None and r.columns["last_restart_at"] is None
    assert r.columns["status"] == "Unknown"


def test_pod_row_created_at_is_aware_utc():
    assert pod_row(pod(), "cl1").created_at.utcoffset().total_seconds() == 0


def test_pod_row_null_restart_count():
    r = pod_row(pod(statuses=[{**c(), "restartCount": None}, c(restarts=2)]), "cl1")
    assert r.columns["restarts"] == 2


def test_pod_row_sums_restarts_and_picks_latest_restart():
    r = pod_row(
        pod(
            statuses=[
                c(restarts=3, last_finished="2026-11-06T14:04:14Z"),
                c(restarts=4, last_finished="2026-11-06T09:00:00Z"),
            ]
        ),
        "cl1",
    )
    assert r.columns["restarts"] == 7
    assert r.columns["last_restart_at"] == "2026-11-06T14:04:14Z"
