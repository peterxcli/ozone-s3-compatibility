#!/usr/bin/env bash

provider_label() {
  printf 'RustFS\n'
}

provider_image() {
  printf '%s\n' "${RUSTFS_IMAGE:-rustfs/rustfs:latest}"
}

provider_start() {
  local image="$1"
  local container
  container="$(provider_container_name rustfs)"
  export WARP_HOST="${RUSTFS_HOST:-127.0.0.1:9000}"
  export WARP_ACCESS_KEY="${RUSTFS_ACCESS_KEY:-warpbenchadmin}"
  export WARP_SECRET_KEY="${RUSTFS_SECRET_KEY:-warpbenchadmin123456}"
  remove_container "${container}"
  docker run -d \
    --name "${container}" \
    -p "${WARP_HOST#*:}:9000" \
    -e RUSTFS_ACCESS_KEY="${WARP_ACCESS_KEY}" \
    -e RUSTFS_SECRET_KEY="${WARP_SECRET_KEY}" \
    "${image}" \
    --address :9000 \
    --access-key "${WARP_ACCESS_KEY}" \
    --secret-key "${WARP_SECRET_KEY}" \
    /data >/dev/null || return 1
  wait_for_tcp "${WARP_HOST}" 180 || return 1
  [[ "$(docker inspect -f '{{.State.Running}}' "${container}")" == "true" ]] || return 1
  wait_for_warp_s3 "${WARP_HOST}" "${WARP_ACCESS_KEY}" "${WARP_SECRET_KEY}" "${WARP_BUCKET}" "${RUSTFS_READY_TIMEOUT:-180}" || return 1
}

provider_stop() {
  remove_container "$(provider_container_name rustfs)"
}

provider_logs() {
  docker logs "$(provider_container_name rustfs)"
}
