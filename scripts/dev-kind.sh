#!/usr/bin/env bash
# Create the kind cluster "omnikrux-dev" (if missing) and apply metrics-server and the demo
# workloads. Safe to re-run. `--recreate` deletes the cluster and builds it again from
# scripts/fixtures/kind-config.yaml (one control plane, one labelled worker).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT/.tools:$PATH"
CLUSTER="omnikrux-dev"
CONTEXT="kind-$CLUSTER"

RECREATE=false
for arg in "$@"; do
  case "$arg" in
    --recreate) RECREATE=true ;;
    *) echo "unknown argument: $arg (only --recreate is known)" >&2; exit 2 ;;
  esac
done

exists() { kind get clusters 2>/dev/null | tr -d '\r' | grep -qx "$CLUSTER"; }

if $RECREATE && exists; then
  kind delete cluster --name "$CLUSTER"
fi

if exists; then
  echo "kind cluster $CLUSTER already exists"
  if ! listed="$(kubectl --context "$CONTEXT" get nodes --no-headers)"; then
    echo "$CLUSTER exists but its API server isn't reachable; check that Docker is running and retry (nothing was changed)" >&2
    exit 1
  fi
  nodes="$(printf '%s\n' "$listed" | tr -d '\r' | grep -vc control-plane || true)"
  if [ "$nodes" -lt 1 ]; then
    echo "$CLUSTER has no worker node; run scripts/dev-kind.sh --recreate (this deletes the cluster)" >&2
    exit 1
  fi
else
  kind create cluster --name "$CLUSTER" --config "$ROOT/scripts/fixtures/kind-config.yaml" --wait 120s
fi

kubectl --context "$CONTEXT" apply -f "$ROOT/scripts/fixtures/metrics-server.yaml"

# A brand-new namespace's default service account appears a moment after the
# namespace does, and pods can't be created until it exists: retry briefly.
for attempt in $(seq 1 30); do
  if kubectl --context "$CONTEXT" apply -f "$ROOT/scripts/fixtures/workloads.yaml"; then
    exit 0
  fi
  echo "apply failed (attempt $attempt), retrying..." >&2
  sleep 2
done
echo "could not apply fixtures to $CONTEXT" >&2
exit 1
