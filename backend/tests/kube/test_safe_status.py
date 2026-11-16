import json

from omnikrux.kube.safe_status import MAX_MESSAGE, safe_status_body

TOKEN = "289364205570899346551-opaque-token"
JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXZhbHVl"
AWS = (
    "k8s-aws-v1.aHR0cHM6Ly9zdHMuZXUtd2VzdC0xLmFtYXpvbmF3cy5jb20vP0FjdGlvbj1HZXRDYWxsZXJJZGVudGl0eQ"
)


def status(message, **extra) -> bytes:
    body = {"kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 409}
    body |= {"reason": "Conflict", "message": message} | extra
    return json.dumps(body).encode()


def test_keeps_code_reason_and_the_markers_callers_decide_on():
    uid = (
        'Operation cannot be fulfilled on pods "web-0": Precondition failed: '
        "UID in precondition: u-old, UID in object meta: u-new"
    )
    safe = json.loads(safe_status_body(status(uid)))
    assert (safe["kind"], safe["code"], safe["reason"]) == ("Status", 409, "Conflict")
    assert safe["message"] == uid
    metrics = json.loads(safe_status_body(status('podmetrics.metrics.k8s.io "web-1" not found')))
    assert metrics["message"] == 'podmetrics.metrics.k8s.io "web-1" not found'


def test_redacts_credentials_and_addresses():
    message = (
        f"https://private-api.example.test:443/api rejected Bearer {TOKEN}; "
        f"also {TOKEN} and {JWT} and {AWS} at http://user:pw@10.0.0.1/x "
        "from internal.example.test"
    )
    raw = status(message)
    safe = safe_status_body(raw, secrets=(TOKEN,), hosts=("internal.example.test",)).decode()
    for sensitive in (TOKEN, JWT, AWS, "private-api.example.test", "user:pw", "10.0.0.1"):
        assert sensitive not in safe
    assert "internal.example.test" not in safe
    assert "rejected Bearer [redacted]" in json.loads(safe)["message"]


def test_keeps_cause_reasons_and_fields_and_redacts_cause_messages():
    causes = [
        {"reason": "FieldValueInvalid", "field": "spec.replicas", "message": f"bad {JWT}"},
        "not a cause",
        {"reason": "with spaces are dropped", "message": "kept"},
    ]
    safe = json.loads(safe_status_body(status("denied", details={"causes": causes})))
    first, second = safe["details"]["causes"]
    assert first == {
        "reason": "FieldValueInvalid",
        "field": "spec.replicas",
        "message": "bad [redacted]",
    }
    assert second == {"message": "kept"}


def test_caps_the_message_after_redaction():
    safe = json.loads(safe_status_body(status("x " * 2000 + TOKEN), secrets=(TOKEN,)))
    assert len(safe["message"]) <= MAX_MESSAGE
    assert TOKEN[:12] not in safe["message"]


def test_non_status_bodies_become_empty():
    for raw in (b"", b"<html>proxy error Bearer abc</html>", b"[1, 2]", b'{"kind": "Pod"}'):
        assert safe_status_body(raw) == b""
