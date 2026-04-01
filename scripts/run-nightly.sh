#!/usr/bin/env bash

set -u -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
OUTPUT_ROOT="${OUTPUT_ROOT:-$ROOT_DIR/out/run}"
WORK_DIR="${WORK_DIR:-$ROOT_DIR/.work}"
RUN_ID="${RUN_ID:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
RUN_DIR="${OUTPUT_ROOT}"
RAW_DIR="${RUN_DIR}/raw"
RUN_JSON="${RUN_DIR}/run.json"

OZONE_REPO="${OZONE_REPO:-https://github.com/apache/ozone.git}"
OZONE_REF="${OZONE_REF:-master}"
OZONE_BUILD_ARGS="${OZONE_BUILD_ARGS:--Pdist -Dmaven.javadoc.skip=true -DskipRecon}"
OZONE_DATANODES="${OZONE_DATANODES:-1}"

S3_TESTS_REPO="${S3_TESTS_REPO:-https://github.com/ceph/s3-tests.git}"
S3_TESTS_REF="${S3_TESTS_REF:-master}"
S3_TESTS_ARGS="${S3_TESTS_ARGS:-s3tests/functional}"

MINT_REPO="${MINT_REPO:-https://github.com/minio/mint.git}"
MINT_REF="${MINT_REF:-master}"
MINT_MODE="${MINT_MODE:-core}"
MINT_TARGETS="${MINT_TARGETS:-}"
if [[ ${MINT_BUILD_TARGETS+x} ]]; then
  EFFECTIVE_MINT_BUILD_TARGETS="${MINT_BUILD_TARGETS}"
else
  EFFECTIVE_MINT_BUILD_TARGETS="${MINT_TARGETS}"
fi

mkdir -p "${RAW_DIR}/ozone" "${RAW_DIR}/s3-tests" "${RAW_DIR}/mint" "${WORK_DIR}"

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BUILD_EXIT=0
CLUSTER_EXIT=0
S3_TESTS_EXIT=0
MINT_EXIT=0
COMPOSE_STOP_ATTEMPTED=false

log() {
  printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"
}

wait_for_http_endpoint() {
  local url="$1"
  local timeout="${2:-60}"

  SECONDS=0
  while [[ ${SECONDS} -lt ${timeout} ]]; do
    if curl -sS -o /dev/null --connect-timeout 2 --max-time 5 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  return 1
}

clone_repo() {
  local repo_url="$1"
  local repo_ref="$2"
  local target_dir="$3"

  rm -rf "${target_dir}"
  git clone --depth 1 --branch "${repo_ref}" "${repo_url}" "${target_dir}"
}

cleanup_cluster() {
  set +e
  if [[ "${COMPOSE_STOP_ATTEMPTED}" == "false" ]] && [[ "${OZONE_COMPOSE_RUNNING:-false}" == "true" ]] && declare -F stop_docker_env >/dev/null 2>&1; then
    COMPOSE_STOP_ATTEMPTED=true
    if [[ -n "${COMPOSE_DIR:-}" && -d "${COMPOSE_DIR}" ]]; then
      pushd "${COMPOSE_DIR}" >/dev/null || true
    fi
    KEEP_RUNNING=false stop_docker_env
    if [[ -n "${COMPOSE_DIR:-}" && -d "${COMPOSE_DIR}" ]]; then
      popd >/dev/null || true
    fi
  fi
}

build_mint_image() {
  local context_dir="$1"
  local image_tag="$2"
  local build_log="$3"
  local build_spec="${EFFECTIVE_MINT_BUILD_TARGETS:-}"
  local targeted_release="${context_dir}/release-targeted.sh"
  local targeted_dockerfile="${context_dir}/Dockerfile.targeted"

  rm -f "${targeted_release}" "${targeted_dockerfile}"

  if [[ -n "${build_spec}" ]]; then
    local target=""
    local -a build_targets=()
    # shellcheck disable=SC2206
    build_targets=(${build_spec})

    cat > "${targeted_release}" <<'EOF'
#!/bin/bash -e

export MINT_ROOT_DIR=${MINT_ROOT_DIR:-/mint}
source "${MINT_ROOT_DIR}"/source.sh
EOF

    for target in "${build_targets[@]}"; do
      if [[ ! "${target}" =~ ^[A-Za-z0-9._-]+$ ]]; then
        log "Invalid Mint build target: ${target}"
        return 1
      fi
      if [[ ! -x "${context_dir}/build/${target}/install.sh" ]]; then
        log "Unknown Mint build target: ${target}"
        return 1
      fi
      printf 'echo "Running $MINT_ROOT_DIR/build/%s/install.sh"\n' "${target}" >> "${targeted_release}"
      printf '"$MINT_ROOT_DIR/build/%s/install.sh"\n' "${target}" >> "${targeted_release}"
    done

    cat >> "${targeted_release}" <<'EOF'
"${MINT_ROOT_DIR}"/postinstall.sh
EOF

    chmod +x "${targeted_release}"

    cat > "${targeted_dockerfile}" <<'EOF'
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND noninteractive
ENV LANG C.UTF-8
ENV GOROOT /usr/local/go
ENV GOPATH /usr/local/gopath
ENV PATH $GOPATH/bin:$GOROOT/bin:$PATH
ENV MINT_ROOT_DIR /mint

RUN apt-get --yes update && apt-get --yes upgrade && \
    apt-get --yes --quiet install wget jq curl git dnsmasq

COPY . /mint

WORKDIR /mint

RUN /mint/create-data-files.sh
RUN /mint/preinstall.sh
RUN /mint/release-targeted.sh

ENTRYPOINT ["/mint/entrypoint.sh"]
EOF

    docker build -f "${targeted_dockerfile}" -t "${image_tag}" "${context_dir}" > "${build_log}" 2>&1
    return $?
  fi

  docker build -t "${image_tag}" "${context_dir}" > "${build_log}" 2>&1
}

trap cleanup_cluster EXIT

log "Cloning Ozone ${OZONE_REF}"
clone_repo "${OZONE_REPO}" "${OZONE_REF}" "${WORK_DIR}/ozone"
OZONE_COMMIT="$(git -C "${WORK_DIR}/ozone" rev-parse HEAD)"

log "Cloning s3-tests ${S3_TESTS_REF}"
clone_repo "${S3_TESTS_REPO}" "${S3_TESTS_REF}" "${WORK_DIR}/s3-tests"
S3_TESTS_COMMIT="$(git -C "${WORK_DIR}/s3-tests" rev-parse HEAD)"
log "Patching s3-tests cleanup for Ozone compatibility"
python3 "${ROOT_DIR}/scripts/patch_s3_tests_for_ozone.py" --repo "${WORK_DIR}/s3-tests"

log "Cloning mint ${MINT_REF}"
clone_repo "${MINT_REPO}" "${MINT_REF}" "${WORK_DIR}/mint"
MINT_COMMIT="$(git -C "${WORK_DIR}/mint" rev-parse HEAD)"
log "Patching Mint installers for Ozone compatibility"
python3 "${ROOT_DIR}/scripts/patch_mint_for_ozone.py" --repo "${WORK_DIR}/mint"

log "Building Ozone distribution"
pushd "${WORK_DIR}/ozone" >/dev/null
set +e
MAVEN_OPTS="${MAVEN_OPTS:-"-Xmx4096m"}" \
  hadoop-ozone/dev-support/checks/build.sh ${OZONE_BUILD_ARGS} \
  2>&1 | tee "${RAW_DIR}/ozone/build.log"
BUILD_EXIT=${PIPESTATUS[0]}
set -e
popd >/dev/null

DIST_DIR=""
if [[ ${BUILD_EXIT} -eq 0 ]]; then
  DIST_DIR="$(find "${WORK_DIR}/ozone/hadoop-ozone/dist/target" -maxdepth 1 -type d -name 'ozone-*' | sort | tail -n 1)"
  if [[ -z "${DIST_DIR}" ]]; then
    log "Could not locate built Ozone distribution"
    BUILD_EXIT=1
  fi
fi

if [[ ${BUILD_EXIT} -eq 0 ]]; then
  log "Starting packaged Ozone cluster"
  export COMPOSE_DIR="${DIST_DIR}/compose/ozone"
  export RESULT_DIR="${RAW_DIR}/ozone/compose"
  export OZONE_REPLICATION_FACTOR=1
  export SECURITY_ENABLED=false
  export OZONE_SAFEMODE_MIN_DATANODES="${OZONE_DATANODES}"
  pushd "${COMPOSE_DIR}" >/dev/null
  # shellcheck disable=SC1091
  source "${DIST_DIR}/compose/testlib.sh"
  set +e
  start_docker_env "${OZONE_DATANODES}" > >(tee "${RAW_DIR}/ozone/start.log") 2>&1
  CLUSTER_EXIT=$?
  set -e
  if [[ ${CLUSTER_EXIT} -eq 0 ]] && ! wait_for_http_endpoint "http://127.0.0.1:9878" 60; then
    log "S3 gateway did not become reachable after compose startup"
    CLUSTER_EXIT=1
  fi
  if [[ ${CLUSTER_EXIT} -ne 0 ]]; then
    docker-compose ps -a > "${RAW_DIR}/ozone/compose-ps.log" 2>&1 || true
    docker-compose logs --no-color > "${RAW_DIR}/ozone/compose.log" 2>&1 || true
  fi
  popd >/dev/null
fi

if [[ ${BUILD_EXIT} -eq 0 && ${CLUSTER_EXIT} -eq 0 ]]; then
  log "Preparing s3-tests environment"
  if ! python3 -m venv "${WORK_DIR}/venv"; then
    S3_TESTS_EXIT=1
  else
    # shellcheck disable=SC1091
    source "${WORK_DIR}/venv/bin/activate"
    if ! python -m pip install --upgrade pip setuptools wheel; then
      S3_TESTS_EXIT=1
    elif ! python -m pip install -r "${WORK_DIR}/s3-tests/requirements.txt"; then
      S3_TESTS_EXIT=1
    fi
  fi

  cat > "${RAW_DIR}/s3-tests/s3tests.conf" <<'EOF'
[DEFAULT]
host = 127.0.0.1
port = 9878
is_secure = False
ssl_verify = False

[fixtures]
bucket prefix = ozone-compat-{random}-
iam name prefix = ozone-compat-
iam path prefix = /ozone-compat/

[s3 main]
display_name = Ozone Main
user_id = ozone-main-user
email = ozone-main@example.com
api_name = default
access_key = OZONEACCESSKEY000001
secret_key = ozone-secret-key-main-0000000000000001

[s3 alt]
display_name = Ozone Alt
email = ozone-alt@example.com
user_id = ozone-alt-user
access_key = OZONEACCESSKEY000002
secret_key = ozone-secret-key-alt-0000000000000002

[s3 tenant]
display_name = ozone$tenant-user
user_id = ozone$tenant-user-id
access_key = OZONEACCESSKEY000003
secret_key = ozone-secret-key-tenant-000000000003
email = ozone-tenant@example.com
tenant = ozone

[iam]
email = ozone-iam@example.com
user_id = ozone-iam-user
access_key = OZONEACCESSKEY000004
secret_key = ozone-secret-key-iam-0000000000000004
display_name = ozone-iam

[iam root]
access_key = OZONEACCESSKEY000005
secret_key = ozone-secret-key-iam-root-00000000000005
user_id = ozone-iam-root
email = ozone-iam-root@example.com

[iam alt root]
access_key = OZONEACCESSKEY000006
secret_key = ozone-secret-key-iam-alt-root-0000000006
user_id = ozone-iam-alt-root
email = ozone-iam-alt-root@example.com
EOF

  if [[ ${S3_TESTS_EXIT} -eq 0 ]]; then
    export S3TEST_CONF="${RAW_DIR}/s3-tests/s3tests.conf"
    pushd "${WORK_DIR}/s3-tests" >/dev/null
    log "Running s3-tests selection: ${S3_TESTS_ARGS}"
    set +e
    python -m pytest --junitxml "${RAW_DIR}/s3-tests/junit.xml" ${S3_TESTS_ARGS} \
      2>&1 | tee "${RAW_DIR}/s3-tests/pytest.log"
    S3_TESTS_EXIT=${PIPESTATUS[0]}
    set -e
    popd >/dev/null
  fi

  if [[ -n "${VIRTUAL_ENV:-}" ]]; then
    deactivate || true
  fi

  log "Building Mint image"
  if ! build_mint_image "${WORK_DIR}/mint" ozone-compat-mint:local "${RAW_DIR}/mint/docker-build.log"; then
    MINT_EXIT=1
  else
    log "Running Mint"
    mint_args=()
    if [[ -n "${MINT_TARGETS}" ]]; then
      # shellcheck disable=SC2206
      mint_args=(${MINT_TARGETS})
    fi
    MINT_CONTAINER_ID="$(docker create \
      --network host \
      -e SERVER_ENDPOINT=127.0.0.1:9878 \
      -e ACCESS_KEY=OZONEACCESSKEY000001 \
      -e SECRET_KEY=ozone-secret-key-main-0000000000000001 \
      -e ENABLE_HTTPS=0 \
      -e MINT_MODE="${MINT_MODE}" \
      ozone-compat-mint:local \
      "${mint_args[@]}")"
    set +e
    docker start -a "${MINT_CONTAINER_ID}" 2>&1 | tee "${RAW_DIR}/mint/console.log"
    MINT_EXIT=${PIPESTATUS[0]}
    set -e
    docker cp "${MINT_CONTAINER_ID}:/mint/log" "${RAW_DIR}/mint/log" >/dev/null 2>&1 || true
    docker rm -f "${MINT_CONTAINER_ID}" >/dev/null 2>&1 || true
  fi
fi

cleanup_cluster

FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_URL=""
if [[ -n "${GITHUB_SERVER_URL:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_RUN_ID:-}" ]]; then
  RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
fi

python3 "${ROOT_DIR}/scripts/normalize_run.py" \
  --out "${RUN_JSON}" \
  --run-id "${RUN_ID}" \
  --started-at "${STARTED_AT}" \
  --finished-at "${FINISHED_AT}" \
  --workflow-run-url "${RUN_URL}" \
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
  --mint-exit "${MINT_EXIT}" \
  --mint-mode "${MINT_MODE}" \
  --mint-targets "${MINT_TARGETS}" \
  --ozone-datanodes "${OZONE_DATANODES}"

if [[ ${BUILD_EXIT} -ne 0 || ${CLUSTER_EXIT} -ne 0 ]]; then
  log "Nightly orchestration finished with infrastructure errors"
  exit 1
fi

log "Nightly orchestration completed"
