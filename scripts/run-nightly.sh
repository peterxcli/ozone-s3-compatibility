#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
STEP_DIR="${ROOT_DIR}/scripts/nightly"
infra_status=0
normalize_status=0
stop_invoked=false

cleanup_cluster() {
  if [[ "${stop_invoked}" == "true" ]]; then
    return 0
  fi
  stop_invoked=true
  bash "${STEP_DIR}/stop_cluster.sh" >/dev/null 2>&1 || true
}

trap cleanup_cluster EXIT HUP INT TERM

bash "${STEP_DIR}/init.sh"

if ! bash "${STEP_DIR}/clone_sources.sh"; then
  infra_status=$?
fi

if [[ ${infra_status} -eq 0 ]] && ! bash "${STEP_DIR}/build_ozone.sh"; then
  infra_status=$?
fi

if [[ ${infra_status} -eq 0 ]] && ! bash "${STEP_DIR}/start_cluster.sh"; then
  infra_status=$?
fi

if [[ ${infra_status} -eq 0 ]]; then
  bash "${STEP_DIR}/run_s3_tests.sh"
  bash "${STEP_DIR}/run_mint.sh"
fi

cleanup_cluster
trap - EXIT HUP INT TERM

if ! bash "${STEP_DIR}/normalize_run.sh"; then
  normalize_status=$?
fi

if [[ ${infra_status} -ne 0 ]]; then
  exit "${infra_status}"
fi

exit "${normalize_status}"
