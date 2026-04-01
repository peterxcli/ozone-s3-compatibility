#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/common.sh"
nightly_load_state

nightly_log "Building Ozone distribution"
pushd "${WORK_DIR}/ozone" >/dev/null
set +e
MAVEN_OPTS="${MAVEN_OPTS:-"-Xmx4096m"}" \
  hadoop-ozone/dev-support/checks/build.sh ${OZONE_BUILD_ARGS} \
  2>&1 | tee "${RAW_DIR}/ozone/build.log"
build_exit=${PIPESTATUS[0]}
set -e
popd >/dev/null

nightly_save_state BUILD_EXIT "${build_exit}"
if [[ ${build_exit} -ne 0 ]]; then
  nightly_log "Ozone build failed"
  exit "${build_exit}"
fi

dist_dir="$(find "${WORK_DIR}/ozone/hadoop-ozone/dist/target" -maxdepth 1 -type d -name 'ozone-*' | sort | tail -n 1)"
if [[ -z "${dist_dir}" ]]; then
  nightly_save_state BUILD_EXIT 1
  nightly_log "Could not locate built Ozone distribution"
  exit 1
fi

nightly_save_state OZONE_DIST_DIR "${dist_dir}"
nightly_save_state OZONE_COMPOSE_DIR "${dist_dir}/compose/ozone"
