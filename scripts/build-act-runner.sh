#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_TAG="${1:-ozone-s3-compatibility/act-runner:latest}"
BUILD_ARGS=()

if [[ -n "${ACT_RUNNER_PLATFORM:-}" ]]; then
  BUILD_ARGS+=(--platform "${ACT_RUNNER_PLATFORM}")
fi

if [[ ${#BUILD_ARGS[@]} -gt 0 ]]; then
  docker build \
    --pull \
    -t "${IMAGE_TAG}" \
    -f "${REPO_ROOT}/.github/act/Dockerfile" \
    "${BUILD_ARGS[@]}" \
    "${REPO_ROOT}/.github/act"
else
  docker build \
    --pull \
    -t "${IMAGE_TAG}" \
    -f "${REPO_ROOT}/.github/act/Dockerfile" \
    "${REPO_ROOT}/.github/act"
fi
