import pytest

from omnikrux.resources.rows import pod_row, pod_status


def pod(phase="Running", statuses=(), init=(), deleting=False, reason=None):
    md = {
        "uid": "u1",
        "name": "p",
        "namespace": "ns",
        "creationTimestamp": "2026-11-06T10:00:00Z",
        "resourceVersion": "812",
    }
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
    return {
        "name": "c",
        "ready": ready,
        "restartCount": restarts,
        "state": state,
        "lastState": last,
    }


@pytest.mark.parametrize(
    "p,expected",
    [
        (pod(statuses=[c()]), ("Running", "ok")),
        (pod(statuses=[c(ready=False)]), ("Not ready", "warn")),
        (pod(statuses=[c(ready=False, waiting="CrashLoopBackOff")]), ("CrashLoopBackOff", "bad")),
        (pod(statuses=[c(ready=False, waiting="ImagePullBackOff")]), ("ImagePullBackOff", "bad")),
        (
            pod("Pending", statuses=[c(ready=False, waiting="ContainerCreating")]),
            ("ContainerCreating", "warn"),
        ),
        (pod("Pending"), ("Pending", "warn")),
        (pod("Succeeded"), ("Completed", "done")),
        (pod("Failed", reason="Evicted"), ("Evicted", "bad")),
        (pod(statuses=[c()], deleting=True), ("Terminating", "warn")),
        (
            pod("Pending", init=[c(ready=False, waiting="CrashLoopBackOff")]),
            ("Init:CrashLoopBackOff", "bad"),
        ),
        (pod(statuses=[c(ready=False, terminated="OOMKilled")]), ("OOMKilled", "bad")),
    ],
)
def test_pod_status(p, expected):
    assert pod_status(p) == expected


def test_pod_row_columns():
    r = pod_row(
        pod(
            statuses=[
                c(
                    restarts=14,
                    ready=False,
                    waiting="CrashLoopBackOff",
                    last_finished="2026-11-06T14:04:14Z",
                ),
                c(),
            ]
        ),
        "cl1",
    )
    assert (r.uid, r.cluster_id, r.kind, r.namespace, r.name) == ("u1", "cl1", "Pod", "ns", "p")
    assert r.columns["ready"] == "1/2" and r.columns["restarts"] == 14
    assert r.columns["node"] == "n1" and r.columns["last_restart_at"] == "2026-11-06T14:04:14Z"
    assert r.columns["resource_version"] == "812"


def test_pod_row_tolerates_missing_fields():
    r = pod_row({"metadata": {"uid": "u2", "name": "bare"}}, "cl1")
    assert r.namespace is None and r.created_at is None
    assert r.columns["ready"] == "0/0" and r.columns["restarts"] == 0
    assert r.columns["node"] is None and r.columns["last_restart_at"] is None
    assert r.columns["status"] == "Unknown" and r.columns["resource_version"] is None


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


def test_pod_row_requests_limits_labels_images():
    p = pod(statuses=[c()])
    p["metadata"]["labels"] = {"app": "web"}
    p["spec"]["containers"] = [
        {
            "name": "a",
            "image": "nginx:1",
            "resources": {
                "requests": {"cpu": "250m", "memory": "64Mi"},
                "limits": {"cpu": "500m", "memory": "128Mi"},
            },
        },
        {
            "name": "b",
            "image": "busybox",
            "resources": {"requests": {"cpu": "0.5"}, "limits": {"cpu": "1"}},
        },
    ]
    p["spec"]["initContainers"] = [
        {"name": "i", "image": "init", "resources": {"requests": {"cpu": "4"}}}
    ]
    row = pod_row(p, "c1")
    assert row.labels == {"app": "web"}
    assert row.columns["images"] == ["nginx:1", "busybox"]
    assert row.columns["cpu_request_m"] == 750 and row.columns["cpu_limit_m"] == 1500
    assert row.columns["memory_request_b"] == 64 * 2**20
    assert row.columns["memory_limit_b"] is None  # container b has no memory limit
    p["spec"]["containers"][1]["resources"]["limits"]["memory"] = "128Mi"
    assert pod_row(p, "c1").columns["memory_limit_b"] == 256 * 2**20
    bare = pod_row(pod(), "c1")
    assert bare.columns["cpu_request_m"] == 0 and bare.columns["cpu_limit_m"] is None
    assert bare.columns["images"] == []


def test_pod_row_unreadable_quantities_are_none_not_zero():
    p = pod()
    p["spec"]["containers"] = [
        {
            "name": "a",
            "image": "x",
            "resources": {"requests": {"cpu": "1e999999999", "memory": "junk"}},
        },
        {"name": "b", "image": "y", "resources": {"requests": {"cpu": "100m", "memory": "1Mi"}}},
    ]
    row = pod_row(p, "c1")
    assert row.columns["cpu_request_m"] is None and row.columns["memory_request_b"] is None
    assert row.columns["images"] == ["x", "y"]


def test_node_row_survives_an_absurd_allocatable():
    from omnikrux.resources.kind_rows import node_row

    n = {"metadata": {"name": "n"}, "status": {"allocatable": {"cpu": "1e999999999", "pods": "x"}}}
    row = node_row(n, "c1")
    assert row.columns["allocatable_cpu_m"] is None and row.columns["allocatable_pods"] is None


def states_for(containers, statuses=(), init_containers=(), init_statuses=()):
    p = pod(statuses=statuses, init=init_statuses)
    p["spec"]["containers"] = containers
    p["spec"]["initContainers"] = init_containers
    return pod_row(p, "c1").columns["containers"]


def test_container_states_ready_running_waiting():
    assert states_for(
        [{"name": "ready"}, {"name": "starting"}, {"name": "creating"}],
        [
            {**c(waiting="ContainerCreating"), "name": "creating"},
            {**c(), "name": "ready"},
            {**c(ready=False), "name": "starting"},
        ],
    ) == [
        {"name": "ready", "init": False, "state": "ready", "reason": None, "restarts": 0},
        {"name": "starting", "init": False, "state": "running", "reason": None, "restarts": 0},
        {
            "name": "creating",
            "init": False,
            "state": "waiting",
            "reason": "ContainerCreating",
            "restarts": 0,
        },
    ]


@pytest.mark.parametrize(
    "state,reason",
    [
        ({"waiting": {"reason": "CrashLoopBackOff"}}, "CrashLoopBackOff"),
        ({"waiting": {"reason": "ErrImagePull"}}, "ErrImagePull"),
        ({"terminated": {"reason": "OOMKilled", "exitCode": 137}}, "OOMKilled"),
        ({"terminated": {"exitCode": 2}}, "Exit code 2"),
    ],
)
def test_container_states_failing_reasons(state, reason):
    assert states_for([{"name": "app"}], [{"name": "app", "state": state}]) == [
        {"name": "app", "init": False, "state": "failing", "reason": reason, "restarts": 0}
    ]


@pytest.mark.parametrize("reason,expected", [(None, "Completed"), ("Succeeded", "Succeeded")])
def test_container_states_done_is_exit_zero(reason, expected):
    p = pod(
        "Succeeded",
        statuses=[{"name": "job", "state": {"terminated": {"exitCode": 0, "reason": reason}}}],
    )
    p["spec"]["containers"] = [{"name": "job"}]
    assert pod_row(p, "c1").columns["containers"] == [
        {"name": "job", "init": False, "state": "done", "reason": expected, "restarts": 0}
    ]


def test_init_containers_only_while_running_or_failing():
    assert states_for(
        [{"name": "app"}],
        [{**c(), "name": "app"}],
        [{"name": name} for name in ["finished", "running", "crashing", "pending", "absent"]],
        [
            {"name": "finished", "state": {"terminated": {"exitCode": 0}}},
            {**c(), "name": "running"},
            {**c(waiting="CrashLoopBackOff"), "name": "crashing"},
            {**c(waiting="PodInitializing"), "name": "pending"},
        ],
    ) == [
        {"name": "running", "init": True, "state": "running", "reason": None, "restarts": 0},
        {
            "name": "crashing",
            "init": True,
            "state": "failing",
            "reason": "CrashLoopBackOff",
            "restarts": 0,
        },
        {"name": "app", "init": False, "state": "ready", "reason": None, "restarts": 0},
    ]


@pytest.mark.parametrize(
    "status,expected,reason",
    [
        (c(), "ready", None),
        (c(ready=False), "running", None),
        (c(waiting="ContainerCreating"), "waiting", "ContainerCreating"),
        (c(waiting="CrashLoopBackOff"), "failing", "CrashLoopBackOff"),
        ({"state": {"terminated": {"exitCode": 0}}}, "done", "Completed"),
    ],
)
def test_native_sidecar_init_states_are_retained(status, expected, reason):
    assert states_for(
        [],
        init_containers=[{"name": "sidecar", "restartPolicy": "Always"}],
        init_statuses=[{**status, "name": "sidecar"}],
    ) == [{"name": "sidecar", "init": True, "state": expected, "reason": reason, "restarts": 0}]


def test_container_states_without_statuses_are_waiting():
    assert states_for([{"name": "a"}, {"name": "b"}]) == [
        {"name": "a", "init": False, "state": "waiting", "reason": None, "restarts": 0},
        {"name": "b", "init": False, "state": "waiting", "reason": None, "restarts": 0},
    ]


def test_container_restarts_are_per_container():
    assert states_for(
        [{"name": "a"}, {"name": "b"}],
        [{**c(restarts=3), "name": "b"}, {**c(restarts=7), "name": "a"}],
    ) == [
        {"name": "a", "init": False, "state": "ready", "reason": None, "restarts": 7},
        {"name": "b", "init": False, "state": "ready", "reason": None, "restarts": 3},
    ]


def test_ephemeral_and_unmatched_statuses_are_excluded():
    p = pod(statuses=[{**c(), "name": "removed"}])
    p["spec"]["containers"] = [{"name": "app"}]
    p["spec"]["ephemeralContainers"] = [{"name": "debug"}]
    p["status"]["ephemeralContainerStatuses"] = [{**c(), "name": "debug"}]
    assert pod_row(p, "c1").columns["containers"] == [
        {"name": "app", "init": False, "state": "waiting", "reason": None, "restarts": 0}
    ]
