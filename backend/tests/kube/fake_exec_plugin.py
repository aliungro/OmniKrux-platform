"""A local exec credential plugin with a file-backed invocation counter."""

import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path


def main():
    if os.environ.get("FAKE_PLUGIN_FAIL") == "1":
        print("boom: no login", file=sys.stderr)
        sys.exit(1)
    if output := os.environ.get("FAKE_PLUGIN_OUTPUT"):
        print(output)
        return
    state = Path(os.environ["FAKE_PLUGIN_STATE"])
    invocation = int(state.read_text()) + 1 if state.exists() else 1
    state.write_text(str(invocation))
    ttl = int(os.environ["FAKE_PLUGIN_TTL"])
    status = {"token": f"exec-{invocation}"}
    if cert := os.environ.get("FAKE_PLUGIN_CERT"):
        if invocation != 1:
            print("boom: no login", file=sys.stderr)
            sys.exit(1)
        status = {
            "clientCertificateData": Path(cert).read_text(),
            "clientKeyData": Path(os.environ["FAKE_PLUGIN_KEY"]).read_text(),
        }
    if ttl:
        status["expirationTimestamp"] = (datetime.now(UTC) + timedelta(seconds=ttl)).isoformat()
    print(
        json.dumps(
            {
                "apiVersion": "client.authentication.k8s.io/v1beta1",
                "kind": "ExecCredential",
                "status": status,
            }
        )
    )


if __name__ == "__main__":
    main()
