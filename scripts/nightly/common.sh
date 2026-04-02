#!/usr/bin/env bash

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." >/dev/null 2>&1 && pwd)"
OUTPUT_ROOT="${OUTPUT_ROOT:-$ROOT_DIR/out/run}"
WORK_DIR="${WORK_DIR:-$ROOT_DIR/.work}"
RUN_ID="${RUN_ID:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
RUN_DIR="${OUTPUT_ROOT}"
RAW_DIR="${RUN_DIR}/raw"
STATE_DIR="${RUN_DIR}/state"
STATE_FILE="${STATE_DIR}/exports.env"

OZONE_REPO="${OZONE_REPO:-https://github.com/apache/ozone.git}"
OZONE_REF="${OZONE_REF:-master}"
OZONE_BUILD_ARGS="${OZONE_BUILD_ARGS:--Pdist -Dmaven.javadoc.skip=true -DskipRecon}"
OZONE_DATANODES="${OZONE_DATANODES:-1}"

S3_TESTS_REPO="${S3_TESTS_REPO:-https://github.com/ceph/s3-tests.git}"
S3_TESTS_REF="${S3_TESTS_REF:-master}"
S3_TESTS_ARGS="${S3_TESTS_ARGS:-s3tests/functional}"
S3_TESTS_MARK_EXPR="${S3_TESTS_MARK_EXPR:-not fails_on_aws}"

MINT_REPO="${MINT_REPO:-https://github.com/minio/mint.git}"
MINT_REF="${MINT_REF:-master}"
MINT_MODE="${MINT_MODE:-core}"
MINT_TARGETS="${MINT_TARGETS:-}"
MINT_TIMEOUT_SECONDS="${MINT_TIMEOUT_SECONDS:-1800}"
if [[ ${MINT_BUILD_TARGETS+x} ]]; then
  EFFECTIVE_MINT_BUILD_TARGETS="${MINT_BUILD_TARGETS}"
else
  EFFECTIVE_MINT_BUILD_TARGETS="${MINT_TARGETS}"
fi

nightly_log() {
  printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"
}

nightly_init_dirs() {
  mkdir -p "${RAW_DIR}/ozone" "${RAW_DIR}/s3-tests" "${RAW_DIR}/mint" "${STATE_DIR}" "${WORK_DIR}"
}

nightly_reset_state() {
  rm -rf "${RUN_DIR}"
  nightly_init_dirs
  : > "${STATE_FILE}"
}

nightly_load_state() {
  if [[ -f "${STATE_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${STATE_FILE}"
  fi
}

nightly_save_state() {
  local key="$1"
  local value="${2-}"
  local escaped=""
  local line=""
  local tmp_file=""

  nightly_init_dirs
  touch "${STATE_FILE}"
  escaped="${value//\'/\'\\\'\'}"
  line="${key}='${escaped}'"
  tmp_file="$(mktemp "${STATE_DIR}/exports.XXXXXX")"
  awk -v key="${key}" -v line="${line}" '
    BEGIN {
      replaced = 0
    }
    $0 ~ "^" key "=" {
      print line
      replaced = 1
      next
    }
    {
      print
    }
    END {
      if (!replaced) {
        print line
      }
    }
  ' "${STATE_FILE}" > "${tmp_file}"
  mv "${tmp_file}" "${STATE_FILE}"
}

nightly_export_env() {
  local key="$1"
  local value="${2-}"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    printf '%s=%s\n' "${key}" "${value}" >> "${GITHUB_ENV}"
  fi
}

nightly_export_output() {
  local key="$1"
  local value="${2-}"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "${key}" "${value}" >> "${GITHUB_OUTPUT}"
  fi
}

nightly_clone_repo() {
  local repo_url="$1"
  local repo_ref="$2"
  local target_dir="$3"

  rm -rf "${target_dir}"
  git clone --depth 1 --branch "${repo_ref}" "${repo_url}" "${target_dir}"
}

nightly_run_with_timeout() {
  local timeout_seconds="$1"
  shift

  if [[ -z "${timeout_seconds}" || "${timeout_seconds}" -le 0 ]]; then
    "$@"
    return $?
  fi

  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=15 "${timeout_seconds}" "$@"
    return $?
  fi

  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout --kill-after=15 "${timeout_seconds}" "$@"
    return $?
  fi

  python3 - "${timeout_seconds}" "$@" <<'PY'
import subprocess
import sys

timeout_seconds = int(sys.argv[1])
command = sys.argv[2:]

process = subprocess.Popen(command)

try:
    raise SystemExit(process.wait(timeout=timeout_seconds))
except subprocess.TimeoutExpired:
    try:
        process.terminate()
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    raise SystemExit(124)
PY
}

nightly_wait_for_http_endpoint() {
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

nightly_capture_compose_diagnostics() {
  local compose_dir="$1"

  pushd "${compose_dir}" >/dev/null
  docker compose ps -a > "${RAW_DIR}/ozone/compose-ps.log" 2>&1 || \
    docker-compose ps -a > "${RAW_DIR}/ozone/compose-ps.log" 2>&1 || true
  docker compose logs --no-color > "${RAW_DIR}/ozone/compose.log" 2>&1 || \
    docker-compose logs --no-color > "${RAW_DIR}/ozone/compose.log" 2>&1 || true
  popd >/dev/null
}

nightly_stop_cluster_impl() {
  nightly_load_state

  if [[ -z "${OZONE_COMPOSE_DIR:-}" || ! -d "${OZONE_COMPOSE_DIR}" ]]; then
    nightly_save_state OZONE_COMPOSE_RUNNING false
    return 0
  fi

  pushd "${OZONE_COMPOSE_DIR}" >/dev/null || return 0
  if [[ -n "${OZONE_DIST_DIR:-}" && -f "${OZONE_DIST_DIR}/compose/testlib.sh" ]]; then
    export RESULT_DIR="${RAW_DIR}/ozone/compose"
    mkdir -p "${RESULT_DIR}"
    # shellcheck disable=SC1091
    source "${OZONE_DIST_DIR}/compose/testlib.sh"
    KEEP_RUNNING=false stop_docker_env || true
  else
    docker compose down -v --remove-orphans >/dev/null 2>&1 || \
      docker-compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  popd >/dev/null || true

  nightly_save_state OZONE_COMPOSE_RUNNING false
}

nightly_build_mint_image() {
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
        nightly_log "Invalid Mint build target: ${target}"
        return 1
      fi
      if [[ ! -x "${context_dir}/build/${target}/install.sh" ]]; then
        nightly_log "Unknown Mint build target: ${target}"
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
