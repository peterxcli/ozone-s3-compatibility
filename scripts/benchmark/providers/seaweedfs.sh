#!/usr/bin/env bash

provider_label() {
  printf 'SeaweedFS\n'
}

provider_image() {
  printf '%s\n' "${SEAWEEDFS_IMAGE:-chrislusf/seaweedfs:latest}"
}

provider_start() {
  local image="$1"
  local container
  container="$(provider_container_name seaweedfs)"
  export WARP_HOST="${SEAWEEDFS_HOST:-127.0.0.1:8333}"
  export WARP_ACCESS_KEY="${SEAWEEDFS_ACCESS_KEY:-s3admin}"
  export WARP_SECRET_KEY="${SEAWEEDFS_SECRET_KEY:-s3secret}"
  remove_container "${container}"
  docker run -d \
    --name "${container}" \
    -p "${WARP_HOST#*:}:8333" \
    -e AWS_ACCESS_KEY_ID="${WARP_ACCESS_KEY}" \
    -e AWS_SECRET_ACCESS_KEY="${WARP_SECRET_KEY}" \
    -e S3_BUCKET="${WARP_BUCKET}" \
    "${image}" >/dev/null || return 1
  wait_for_tcp "${WARP_HOST}" 180 || return 1
  wait_for_warp_s3 "${WARP_HOST}" "${WARP_ACCESS_KEY}" "${WARP_SECRET_KEY}" "${WARP_BUCKET}" "${SEAWEEDFS_READY_TIMEOUT:-180}" || return 1
}

provider_stop() {
  remove_container "$(provider_container_name seaweedfs)"
}

provider_logs() {
  docker logs "$(provider_container_name seaweedfs)"
}
