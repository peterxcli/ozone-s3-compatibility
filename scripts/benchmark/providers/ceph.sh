#!/usr/bin/env bash

provider_label() {
  printf 'Ceph\n'
}

provider_image() {
  printf '%s\n' "${CEPH_IMAGE:-quay.io/ceph/demo:latest}"
}

wait_for_ceph_user() {
  local timeout_seconds="${1:-300}"
  local started
  local container
  started="$(date +%s)"
  container="$(provider_container_name ceph)"
  while true; do
    if docker exec "${container}" radosgw-admin user info --uid=warp-benchmark >/dev/null 2>&1; then
      return 0
    fi
    if docker exec "${container}" \
      radosgw-admin user create \
        --uid=warp-benchmark \
        --display-name="Warp Benchmark" \
        --access-key="${WARP_ACCESS_KEY}" \
        --secret="${WARP_SECRET_KEY}" >/dev/null 2>&1; then
      return 0
    fi
    if (( $(date +%s) - started >= timeout_seconds )); then
      benchmark_log "Timed out creating Ceph RGW user warp-benchmark"
      return 1
    fi
    sleep 5
  done
}

provider_start() {
  local image="$1"
  local compose_dir="${OUTPUT_ROOT}/ceph-compose"
  mkdir -p "${compose_dir}"
  export WARP_HOST="${CEPH_HOST:-127.0.0.1:8080}"
  export WARP_ACCESS_KEY="${CEPH_ACCESS_KEY:-test}"
  export WARP_SECRET_KEY="${CEPH_SECRET_KEY:-test}"
  cat > "${compose_dir}/docker-compose.yml" <<EOF
services:
  ceph-demo:
    image: ${image}
    container_name: $(provider_container_name ceph)
    privileged: true
    network_mode: host
    environment:
      MON_IP: 127.0.0.1
      CEPH_PUBLIC_NETWORK: 0.0.0.0/0
      DEMO_DAEMONS: osd,mds,rgw
volumes:
  ceph_etc:
  ceph_lib:
EOF
  docker_compose -f "${compose_dir}/docker-compose.yml" up -d || return 1
  wait_for_tcp "${WARP_HOST}" 300 || return 1
  wait_for_ceph_user "${CEPH_READY_TIMEOUT:-300}" || return 1
  wait_for_warp_s3 "${WARP_HOST}" "${WARP_ACCESS_KEY}" "${WARP_SECRET_KEY}" "${WARP_BUCKET}" "${CEPH_READY_TIMEOUT:-300}" || return 1
}

provider_stop() {
  remove_container "$(provider_container_name ceph)"
}

provider_logs() {
  docker logs "$(provider_container_name ceph)"
}
