#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/common.sh"
nightly_load_state

if [[ -z "${OZONE_DIST_DIR:-}" || ! -d "${OZONE_DIST_DIR}" ]]; then
  nightly_log "Ozone distribution directory is missing"
  exit 1
fi

compose_dir="${OZONE_COMPOSE_DIR:-${OZONE_DIST_DIR}/compose/ozone}"

nightly_log "Starting packaged Ozone cluster"
export COMPOSE_DIR="${compose_dir}"
export RESULT_DIR="${RAW_DIR}/ozone/compose"
export OZONE_REPLICATION_FACTOR=1
export SECURITY_ENABLED=false
export OZONE_SAFEMODE_MIN_DATANODES="${OZONE_DATANODES}"

pushd "${compose_dir}" >/dev/null
# shellcheck disable=SC1091
source "${OZONE_DIST_DIR}/compose/testlib.sh"
set +e
start_docker_env "${OZONE_DATANODES}" > >(tee "${RAW_DIR}/ozone/start.log") 2>&1
cluster_exit=$?
set -e

if [[ ${cluster_exit} -eq 0 ]] && ! nightly_wait_for_http_endpoint "http://127.0.0.1:9878" 60; then
  nightly_log "S3 gateway did not become reachable after compose startup"
  cluster_exit=1
fi
popd >/dev/null

nightly_save_state CLUSTER_EXIT "${cluster_exit}"
if [[ ${cluster_exit} -eq 0 ]]; then
  nightly_save_state OZONE_COMPOSE_RUNNING true
  exit 0
fi

nightly_save_state OZONE_COMPOSE_RUNNING false
nightly_capture_compose_diagnostics "${compose_dir}"
nightly_log "Ozone cluster startup failed"
exit "${cluster_exit}"
