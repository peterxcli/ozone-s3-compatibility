#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/common.sh"

nightly_reset_state

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

nightly_save_state RUN_ID "${RUN_ID}"
nightly_save_state STARTED_AT "${STARTED_AT}"
nightly_save_state OZONE_REPO "${OZONE_REPO}"
nightly_save_state OZONE_REF "${OZONE_REF}"
nightly_save_state OZONE_BUILD_ARGS "${OZONE_BUILD_ARGS}"
nightly_save_state OZONE_DATANODES "${OZONE_DATANODES}"
nightly_save_state S3_TESTS_REPO "${S3_TESTS_REPO}"
nightly_save_state S3_TESTS_SOURCE "${S3_TESTS_SOURCE}"
nightly_save_state S3_TESTS_REF "${S3_TESTS_REF}"
nightly_save_state S3_TESTS_ARGS "${S3_TESTS_ARGS}"
nightly_save_state S3_TESTS_MARK_EXPR "${S3_TESTS_MARK_EXPR}"
nightly_save_state MINT_REPO "${MINT_REPO}"
nightly_save_state MINT_SOURCE "${MINT_SOURCE}"
nightly_save_state MINT_REF "${MINT_REF}"
nightly_save_state MINT_MODE "${MINT_MODE}"
nightly_save_state MINT_TARGETS "${MINT_TARGETS}"
nightly_save_state MINT_TIMEOUT_SECONDS "${MINT_TIMEOUT_SECONDS}"
nightly_save_state OZONE_COMMIT "unknown"
nightly_save_state S3_TESTS_COMMIT "unknown"
nightly_save_state MINT_COMMIT "unknown"
nightly_save_state OZONE_DIST_DIR ""
nightly_save_state OZONE_COMPOSE_DIR ""
nightly_save_state OZONE_COMPOSE_RUNNING false
nightly_save_state BUILD_EXIT 1
nightly_save_state CLUSTER_EXIT 1
nightly_save_state S3_TESTS_EXIT 0
nightly_save_state MINT_EXIT 0

nightly_export_env RUN_ID "${RUN_ID}"
nightly_export_output run_id "${RUN_ID}"

nightly_log "Initialized nightly context at ${RUN_DIR}"
