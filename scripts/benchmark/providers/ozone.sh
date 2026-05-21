#!/usr/bin/env bash

provider_label() {
  printf 'Apache Ozone\n'
}

provider_image() {
  if [[ -n "${OZONE_IMAGE:-}" ]]; then
    printf '%s\n' "${OZONE_IMAGE}"
    return 0
  fi
  curl -fsSL "https://raw.githubusercontent.com/apache/ozone-docker/refs/heads/latest/docker-compose.yaml" \
    | awk '/image:/ {print $2; exit}'
}

provider_start() {
  local _image="$1"
  local compose_dir="${OUTPUT_ROOT}/ozone-compose"
  mkdir -p "${compose_dir}"
  export WARP_HOST="${OZONE_HOST:-127.0.0.1:9878}"
  export WARP_ACCESS_KEY="${OZONE_ACCESS_KEY:-testuser}"
  export WARP_SECRET_KEY="${OZONE_SECRET_KEY:-testuser-secret}"
  curl -fsSL "https://raw.githubusercontent.com/apache/ozone-docker/refs/heads/latest/docker-compose.yaml" \
    -o "${compose_dir}/docker-compose.yaml"
  docker_compose -f "${compose_dir}/docker-compose.yaml" up -d --scale datanode="${OZONE_DATANODES:-3}"
  wait_for_tcp "${WARP_HOST}" 300
}

provider_stop() {
  local compose_file="${OUTPUT_ROOT}/ozone-compose/docker-compose.yaml"
  if [[ -f "${compose_file}" ]]; then
    docker_compose -f "${compose_file}" down -v || true
  fi
}

provider_logs() {
  local compose_file="${OUTPUT_ROOT}/ozone-compose/docker-compose.yaml"
  if [[ -f "${compose_file}" ]]; then
    docker_compose -f "${compose_file}" logs
  fi
}
