#!/usr/bin/env bash
# Create the kind cluster "omnikrux-dev" (if missing) and apply the demo workloads.
# Safe to re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT/.tools:$PATH"
CLUSTER="omnikrux-dev"
CONTEXT="kind-$CLUSTER"

if kind get clusters 2>/dev/null | tr -d '\r' | grep -qx "$CLUSTER"; then
  echo "kind cluster $CLUSTER already exists"
else
  kind create cluster --name "$CLUSTER" --wait 120s
fi

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
