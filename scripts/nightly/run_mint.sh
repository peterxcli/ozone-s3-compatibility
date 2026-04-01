#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/common.sh"
nightly_load_state

suite_exit=0

nightly_log "Building Mint image"
if ! nightly_build_mint_image "${WORK_DIR}/mint" ozone-compat-mint:local "${RAW_DIR}/mint/docker-build.log"; then
  suite_exit=1
else
  nightly_log "Running Mint"
  mint_create_cmd=(
    docker create
    --network host
    -e SERVER_ENDPOINT=127.0.0.1:9878
    -e ACCESS_KEY=OZONEACCESSKEY000001
    -e SECRET_KEY=ozone-secret-key-main-0000000000000001
    -e ENABLE_HTTPS=0
    -e MINT_MODE="${MINT_MODE}"
    ozone-compat-mint:local
  )
  if [[ -n "${MINT_TARGETS}" ]]; then
    # shellcheck disable=SC2206
    mint_create_cmd+=(${MINT_TARGETS})
  fi
  if ! MINT_CONTAINER_ID="$("${mint_create_cmd[@]}")"; then
    suite_exit=1
  else
    set +e
    nightly_run_with_timeout "${MINT_TIMEOUT_SECONDS}" docker start -a "${MINT_CONTAINER_ID}" \
      2>&1 | tee "${RAW_DIR}/mint/console.log"
    suite_exit=${PIPESTATUS[0]}
    set -e
    if [[ ${suite_exit} -eq 124 ]]; then
      nightly_log "Mint exceeded timeout (${MINT_TIMEOUT_SECONDS}s)"
    fi
    docker cp "${MINT_CONTAINER_ID}:/mint/log" "${RAW_DIR}/mint/log" >/dev/null 2>&1 || true
    docker rm -f "${MINT_CONTAINER_ID}" >/dev/null 2>&1 || true
  fi
fi

nightly_save_state MINT_EXIT "${suite_exit}"
nightly_log "Mint finished with exit code ${suite_exit}"
