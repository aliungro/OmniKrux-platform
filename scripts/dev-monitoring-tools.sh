#!/usr/bin/env bash
# Put the pinned Helm and the monitoring chart archives in .tools/ for running OmniKrux outside
# its image (the image ships them). The chart pins and the Linux Helm sums are read from the
# Dockerfile's monitoring-tools stage; Helm for this host comes from get.helm.sh. Every file is
# checked against its SHA-256 before anything is installed. Safe to re-run: files that already
# match are kept.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS="$ROOT/.tools"
CHARTS="$TOOLS/charts"

pin() {
  local value
  value="$(sed -n "s/^ARG $1=//p" "$ROOT/Dockerfile" | tr -d '\r')"
  if [ -z "$value" ]; then
    echo "The Dockerfile has no ARG $1; nothing was installed." >&2
    exit 1
  fi
  printf '%s' "$value"
}

HELM_VERSION="$(sed -n 's/^ARG HELM_VERSION=//p' "$ROOT/Dockerfile" | tr -d '\r')"
KPS_CHART_VERSION="$(sed -n 's/^ARG KPS_CHART_VERSION=//p' "$ROOT/Dockerfile" | tr -d '\r')"
LOKI_CHART_VERSION="$(sed -n 's/^ARG LOKI_CHART_VERSION=//p' "$ROOT/Dockerfile" | tr -d '\r')"
ALLOY_CHART_VERSION="$(sed -n 's/^ARG ALLOY_CHART_VERSION=//p' "$ROOT/Dockerfile" | tr -d '\r')"
for name in HELM_VERSION KPS_CHART_VERSION LOKI_CHART_VERSION ALLOY_CHART_VERSION; do
  if [ -z "${!name}" ]; then
    echo "The Dockerfile has no ARG $name; nothing was installed." >&2
    exit 1
  fi
done
KPS_CHART_SHA256="$(pin KPS_CHART_SHA256)"
LOKI_CHART_SHA256="$(pin LOKI_CHART_SHA256)"
ALLOY_CHART_SHA256="$(pin ALLOY_CHART_SHA256)"

# Helm for the host. The Windows sum is from
# https://get.helm.sh/helm-v4.3.1-windows-amd64.zip.sha256sum; the Linux sums are the image's.
# A host without a sum here stops with a pointer to the release's .sha256sum file.
HELM_DEV_VERSION="4.3.1"
HELM_DEV_SHA256_windows_amd64=fcfd7b796dcf0f225abc40b5636a3b01f55f3de2fb1dfb18475df94e62c14112
HELM_DEV_SHA256_linux_amd64="$(pin HELM_AMD64_SHA256)"
HELM_DEV_SHA256_linux_arm64="$(pin HELM_ARM64_SHA256)"
HELM_DEV_SHA256_darwin_arm64=""

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "This script knows Windows, Linux and macOS, not $(uname -s); nothing was installed." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "This script knows amd64 and arm64, not $(uname -m); nothing was installed." >&2; exit 1 ;;
esac
if [ "$os" = windows ]; then
  helm_archive="helm-v$HELM_VERSION-$os-$arch.zip"
  helm_name=helm.exe
else
  helm_archive="helm-v$HELM_VERSION-$os-$arch.tar.gz"
  helm_name=helm
fi
sum_var="HELM_DEV_SHA256_${os}_${arch}"
helm_sha="${!sum_var:-}"
if [ "$HELM_VERSION" != "$HELM_DEV_VERSION" ] && [ "$os" != linux ]; then
  echo "The Dockerfile pins Helm $HELM_VERSION and this script's $sum_var is for $HELM_DEV_VERSION. Update $sum_var from https://get.helm.sh/$helm_archive.sha256sum; nothing was installed." >&2
  exit 1
fi
if [ -z "$helm_sha" ]; then
  echo "There is no pinned Helm sum for $os-$arch. Set $sum_var in this script from https://get.helm.sh/$helm_archive.sha256sum; nothing was installed." >&2
  exit 1
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

mkdir -p "$TOOLS"
STAGE="$(mktemp -d "$TOOLS/.download.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# file, sha, url: download into the staging folder and check it. A mismatch deletes the file and
# stops before anything is installed.
fetch() {
  local file="$1" sha="$2" url="$3"
  echo "Downloading $file"
  curl -fsSL --retry 3 -o "$STAGE/$file" "$url"
  if [ "$(sha256_of "$STAGE/$file")" != "$sha" ]; then
    rm -f "$STAGE/$file"
    echo "Checksum mismatch for $file: expected $sha. Nothing was installed." >&2
    exit 1
  fi
}

need_helm=true
if [ -x "$TOOLS/$helm_name" ] \
  && [ "$("$TOOLS/$helm_name" version --template '{{.Version}}' 2>/dev/null | tr -d '\r')" = "v$HELM_VERSION" ]; then
  need_helm=false
  echo "Helm v$HELM_VERSION is already in .tools/"
fi
if $need_helm; then
  fetch "$helm_archive" "$helm_sha" "https://get.helm.sh/$helm_archive"
fi

charts=(
  "kube-prometheus-stack-$KPS_CHART_VERSION.tgz|$KPS_CHART_SHA256|https://github.com/prometheus-community/helm-charts/releases/download/kube-prometheus-stack-$KPS_CHART_VERSION/kube-prometheus-stack-$KPS_CHART_VERSION.tgz"
  "loki-$LOKI_CHART_VERSION.tgz|$LOKI_CHART_SHA256|https://github.com/grafana/helm-charts/releases/download/helm-loki-$LOKI_CHART_VERSION/loki-$LOKI_CHART_VERSION.tgz"
  "alloy-$ALLOY_CHART_VERSION.tgz|$ALLOY_CHART_SHA256|https://github.com/grafana/helm-charts/releases/download/alloy-$ALLOY_CHART_VERSION/alloy-$ALLOY_CHART_VERSION.tgz"
)
fetched=()
for entry in "${charts[@]}"; do
  IFS='|' read -r file sha url <<<"$entry"
  if [ -f "$CHARTS/$file" ] && [ "$(sha256_of "$CHARTS/$file")" = "$sha" ]; then
    echo "$file is already in .tools/charts/"
  else
    fetch "$file" "$sha" "$url"
    fetched+=("$file")
  fi
done

# Every download matched its sum: install them.
if $need_helm; then
  mkdir -p "$STAGE/helm"
  if [ "$os" = windows ]; then
    unzip -q -o -j "$STAGE/$helm_archive" "$os-$arch/$helm_name" -d "$STAGE/helm"
  else
    tar -xzf "$STAGE/$helm_archive" -C "$STAGE/helm" --strip-components=1 "$os-$arch/$helm_name"
  fi
  install -m 755 "$STAGE/helm/$helm_name" "$TOOLS/$helm_name"
  echo "Installed Helm v$HELM_VERSION as .tools/$helm_name"
fi
mkdir -p "$CHARTS"
for file in ${fetched[@]+"${fetched[@]}"}; do
  install -m 644 "$STAGE/$file" "$CHARTS/$file"
  echo "Installed .tools/charts/$file"
done

if command -v cygpath >/dev/null 2>&1; then
  shown_tools="$(cygpath -m "$TOOLS")"
else
  shown_tools="$TOOLS"
fi
echo
echo "Export these before starting OmniKrux:"
echo "  export OMNIKRUX_HELM_BINARY=\"$shown_tools/$helm_name\""
echo "  export OMNIKRUX_CHARTS_DIR=\"$shown_tools/charts\""
