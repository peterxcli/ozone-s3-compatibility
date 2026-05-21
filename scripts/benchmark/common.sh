#!/usr/bin/env bash

set -euo pipefail

benchmark_log() {
  printf '[benchmark] %s\n' "$*" >&2
}

provider_container_name() {
  local provider="$1"
  printf 'warp-benchmark-%s' "${provider}"
}

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

resolve_image() {
  local image="$1"
  docker pull "${image}" >/dev/null
  local digest
  digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "${image}" 2>/dev/null || true)"
  if [[ -z "${digest}" || "${digest}" == "<no value>" ]]; then
    digest="${image}"
  fi
  printf '%s\n' "${digest}"
}

wait_for_http() {
  local url="$1"
  local timeout_seconds="${2:-180}"
  local started
  started="$(date +%s)"
  while true; do
    if curl -fsS --max-time 3 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    if (( $(date +%s) - started >= timeout_seconds )); then
      benchmark_log "Timed out waiting for ${url}"
      return 1
    fi
    sleep 2
  done
}

wait_for_tcp() {
  local address="$1"
  local timeout_seconds="${2:-180}"
  local host="${address%:*}"
  local port="${address##*:}"
  local started
  started="$(date +%s)"
  while true; do
    if (echo >"/dev/tcp/${host}/${port}") >/dev/null 2>&1; then
      return 0
    fi
    if (( $(date +%s) - started >= timeout_seconds )); then
      benchmark_log "Timed out waiting for TCP ${address}"
      return 1
    fi
    sleep 2
  done
}

wait_for_warp_s3() {
  local address="$1"
  local access_key="$2"
  local secret_key="$3"
  local bucket="$4"
  local timeout_seconds="${5:-300}"
  local started
  local probe_dir
  local probe_log
  local benchdata
  local exit_code
  local command_timeout
  local -a timeout_prefix
  if [[ ! -x "${WARP_BINARY}" ]]; then
    benchmark_log "Warp binary is not executable: ${WARP_BINARY}"
    return 1
  fi
  started="$(date +%s)"
  command_timeout="${WARP_S3_PROBE_COMMAND_TIMEOUT:-30s}"
  timeout_prefix=()
  if command -v timeout >/dev/null 2>&1; then
    timeout_prefix=(timeout "${command_timeout}")
  fi
  probe_dir="${RUNNER_TEMP:-/tmp}/warp-s3-readiness"
  mkdir -p "${probe_dir}"
  probe_log="${probe_dir}/${bucket}.log"
  benchdata="${probe_dir}/${bucket}.csv.zst"
  while true; do
    rm -f "${probe_log}" "${benchdata}"
    set +e
    "${timeout_prefix[@]}" "${WARP_BINARY}" put \
      --host="${address}" \
      --access-key="${access_key}" \
      --secret-key="${secret_key}" \
      --bucket="${bucket}" \
      --duration=1s \
      --concurrent=1 \
      --obj.size=1KiB \
      --benchdata="${benchdata}" \
      --autoterm >"${probe_log}" 2>&1
    exit_code="$?"
    set -e
    if [[ "${exit_code}" -eq 0 ]]; then
      rm -f "${probe_log}" "${benchdata}"
      return 0
    fi
    if (( $(date +%s) - started >= timeout_seconds )); then
      benchmark_log "Timed out waiting for S3 readiness at ${address}"
      if [[ -s "${probe_log}" ]]; then
        tail -n 20 "${probe_log}" >&2 || true
      fi
      return 1
    fi
    sleep 5
  done
}

wait_for_container_log() {
  local container="$1"
  local pattern="$2"
  local timeout_seconds="${3:-180}"
  local started
  started="$(date +%s)"
  while true; do
    if docker logs "${container}" 2>&1 | grep -qE "${pattern}"; then
      return 0
    fi
    if (( $(date +%s) - started >= timeout_seconds )); then
      benchmark_log "Timed out waiting for ${container} log pattern ${pattern}"
      return 1
    fi
    sleep 2
  done
}

remove_container() {
  local container="$1"
  docker rm -f "${container}" >/dev/null 2>&1 || true
}

write_runner_json() {
  python3 - <<'PY'
import json
import os
import platform
import shutil

runner = {
    "os": platform.platform(),
    "machine": platform.machine(),
    "python": platform.python_version(),
    "cpu_count": os.cpu_count() or 0,
}
disk = shutil.disk_usage(os.getcwd())
runner["disk_total_bytes"] = disk.total
runner["disk_free_bytes"] = disk.free
print(json.dumps(runner, sort_keys=True))
PY
}
