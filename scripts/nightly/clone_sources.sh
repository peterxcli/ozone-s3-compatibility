#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/common.sh"
nightly_load_state

nightly_log "Cloning Ozone ${OZONE_REF}"
nightly_clone_repo "${OZONE_REPO}" "${OZONE_REF}" "${WORK_DIR}/ozone"
nightly_save_state OZONE_COMMIT "$(git -C "${WORK_DIR}/ozone" rev-parse HEAD)"

nightly_log "Cloning s3-tests ${S3_TESTS_REF}"
nightly_clone_repo "${S3_TESTS_REPO}" "${S3_TESTS_REF}" "${WORK_DIR}/s3-tests"
nightly_save_state S3_TESTS_COMMIT "$(git -C "${WORK_DIR}/s3-tests" rev-parse HEAD)"
nightly_log "Patching s3-tests cleanup for Ozone compatibility"
python3 "${ROOT_DIR}/scripts/patch_s3_tests_for_ozone.py" --repo "${WORK_DIR}/s3-tests"

nightly_log "Cloning Mint ${MINT_REF}"
nightly_clone_repo "${MINT_REPO}" "${MINT_REF}" "${WORK_DIR}/mint"
nightly_save_state MINT_COMMIT "$(git -C "${WORK_DIR}/mint" rev-parse HEAD)"
nightly_log "Patching Mint installers for Ozone compatibility"
python3 "${ROOT_DIR}/scripts/patch_mint_for_ozone.py" --repo "${WORK_DIR}/mint"
