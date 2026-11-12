"""A local exec credential plugin with a file-backed invocation counter."""

import json
import os
import subprocess
import sys
import time
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
    if hold := os.environ.get("FAKE_PLUGIN_HOLD"):
        print("stdout sentinel", flush=True)
        print("stderr sentinel", file=sys.stderr, flush=True)
        if hold == "child":
            subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(3)"],
                stdin=subprocess.DEVNULL,
            )
        state.write_text(str(invocation))
        if hold == "parent":
            time.sleep(3)
        return
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
