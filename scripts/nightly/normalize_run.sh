#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/common.sh"
nightly_load_state

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_url=""
if [[ -n "${GITHUB_SERVER_URL:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
  run_url="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
fi

nightly_log "Normalizing run outputs"
normalize_args=()
if [[ "${S3_TESTS_INCLUDE_ALL_CASES}" == "true" ]]; then
  normalize_args+=("--s3-tests-include-all-cases")
fi

python3 "${ROOT_DIR}/scripts/normalize_run.py" \
  --out "${RUN_DIR}/run.json" \
  --run-id "${RUN_ID}" \
  --started-at "${STARTED_AT}" \
  --finished-at "${finished_at}" \
  --workflow-run-url "${run_url}" \
  --build-exit "${BUILD_EXIT}" \
  --cluster-exit "${CLUSTER_EXIT}" \
  --ozone-repo "${OZONE_REPO}" \
  --ozone-ref "${OZONE_REF}" \
  --ozone-commit "${OZONE_COMMIT}" \
  --s3-tests-repo "${S3_TESTS_REPO}" \
  --s3-tests-ref "${S3_TESTS_REF}" \
  --s3-tests-commit "${S3_TESTS_COMMIT}" \
  --s3-tests-source "${WORK_DIR}/s3-tests" \
  --s3-tests-junit "${RAW_DIR}/s3-tests/junit.xml" \
  --s3-tests-exit "${S3_TESTS_EXIT}" \
  --s3-tests-args "${S3_TESTS_ARGS}" \
  --mint-repo "${MINT_REPO}" \
  --mint-ref "${MINT_REF}" \
  --mint-commit "${MINT_COMMIT}" \
  --mint-log "${RAW_DIR}/mint/log/log.json" \
  --mint-console "${RAW_DIR}/mint/console.log" \
  --mint-exit "${MINT_EXIT}" \
  --mint-mode "${MINT_MODE}" \
  --mint-targets "${MINT_TARGETS}" \
  --ozone-datanodes "${OZONE_DATANODES}" \
  "${normalize_args[@]}"
