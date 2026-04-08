#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-k8s}"

usage() {
  cat <<'EOF'
Usage:
  ops/oneclick-deploy.sh [k8s|dev]

Modes:
  k8s  Build image + deploy helm to local k8s (default)
  dev  Prepare local dev env and run local regression command

Environment variables (k8s):
  REGISTRY_IMAGE     Remote image repository
  NAMESPACE          Helm namespace
  RELEASE_NAME       Helm release name
  VALUES_FILE        Helm values file
  TAG                Image tag
  BUILD_LOCAL_IMAGE  1/0 build local image first (default: 1)
  PUSH_IMAGE         1/0 push to registry (default: 1)
  IMPORT_TO_K3S      1/0 import local image to k3s (default: 0)
  RUN_SMOKE          1/0 run post-deploy smoke checks (default: 1)

Environment variables (dev):
  RUN_SMOKE          1/0 run npm run:mvp after setup (default: 1)

Examples:
  ops/oneclick-deploy.sh k8s
  PUSH_IMAGE=0 IMPORT_TO_K3S=1 ops/oneclick-deploy.sh k8s
  ops/oneclick-deploy.sh dev
EOF
}

if [[ "$MODE" == "-h" || "$MODE" == "--help" || "$MODE" == "help" || "${2:-}" == "-h" || "${2:-}" == "--help" || "${2:-}" == "help" ]]; then
  usage
  exit 0
fi

REGISTRY_DEFAULT="crpi-wixjy6gci86ms14e.cn-hongkong.personal.cr.aliyuncs.com/ay-dev/astro-code"
REGISTRY_IMAGE="${REGISTRY_IMAGE:-$REGISTRY_DEFAULT}"
NAMESPACE="${NAMESPACE:-astro-code}"
RELEASE_NAME="${RELEASE_NAME:-astro-code}"
VALUES_FILE="${VALUES_FILE:-helm/astro-code/values.local.yaml}"
TAG="${TAG:-v$(date +%Y%m%d-%H%M%S)}"

BUILD_LOCAL_IMAGE="${BUILD_LOCAL_IMAGE:-1}"
PUSH_IMAGE="${PUSH_IMAGE:-1}"
IMPORT_TO_K3S="${IMPORT_TO_K3S:-0}"
RUN_SMOKE="${RUN_SMOKE:-1}"

LOCAL_IMAGE="astro-code/opencode:${TAG}"
REMOTE_IMAGE="${REGISTRY_IMAGE}:${TAG}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[ERROR] Required command not found: $1" >&2
    exit 1
  fi
}

deploy_k8s() {
  require_cmd podman
  require_cmd helm
  require_cmd kubectl

  cd "$ROOT_DIR"

  if [[ "$BUILD_LOCAL_IMAGE" == "1" ]]; then
    echo "[INFO] Building image: ${LOCAL_IMAGE}"
    podman build -f ops/Dockerfile.orchestrator -t "$LOCAL_IMAGE" .
  fi

  HELM_IMAGE_REPO="astro-code/opencode"
  HELM_IMAGE_TAG="$TAG"
  HELM_PULL_POLICY="IfNotPresent"

  if [[ "$PUSH_IMAGE" == "1" ]]; then
    echo "[INFO] Tagging + pushing image: ${REMOTE_IMAGE}"
    podman tag "$LOCAL_IMAGE" "$REMOTE_IMAGE"
    podman push "$REMOTE_IMAGE"
    HELM_IMAGE_REPO="$REGISTRY_IMAGE"
    HELM_PULL_POLICY="Always"
  fi

  if [[ "$IMPORT_TO_K3S" == "1" ]]; then
    TMP_TAR="/tmp/astro-code-${TAG}.tar"
    echo "[INFO] Importing image into local k3s: ${LOCAL_IMAGE}"
    podman save -o "$TMP_TAR" "$LOCAL_IMAGE"
    sudo k3s ctr images import "$TMP_TAR"
  fi

  echo "[INFO] Helm upgrade/install: ${RELEASE_NAME} (${NAMESPACE})"
  helm upgrade --install "$RELEASE_NAME" helm/astro-code \
    -n "$NAMESPACE" \
    --create-namespace \
    -f "$VALUES_FILE" \
    --set image.repository="$HELM_IMAGE_REPO" \
    --set image.tag="$HELM_IMAGE_TAG" \
    --set image.pullPolicy="$HELM_PULL_POLICY"

  echo "[INFO] Waiting rollout"
  kubectl -n "$NAMESPACE" rollout status "deploy/${RELEASE_NAME}" --timeout=300s

  if [[ "$RUN_SMOKE" == "1" ]]; then
    echo "[INFO] Post-deploy status"
    kubectl -n "$NAMESPACE" get pods,svc
  fi

  echo "[DONE] Deployed tag=${TAG} repo=${HELM_IMAGE_REPO}"
}

setup_dev() {
  require_cmd npm
  require_cmd python3

  cd "$ROOT_DIR"

  echo "[INFO] Installing npm dependencies"
  npm install

  echo "[INFO] Installing python dependencies"
  python3 -m pip install -r py/requirements.txt

  if [[ "$RUN_SMOKE" == "1" ]]; then
    echo "[INFO] Running local regression smoke"
    npm run run:mvp
  fi

  cat <<'EOF'
[DONE] Local dev setup complete.
Next useful command:
  NODE_TLS_REJECT_UNAUTHORIZED=0 opencode web --port 7788
EOF
}

case "$MODE" in
  k8s)
    deploy_k8s
    ;;
  dev)
    setup_dev
    ;;
  *)
    echo "[ERROR] Unknown mode: $MODE" >&2
    usage
    exit 1
    ;;
esac
