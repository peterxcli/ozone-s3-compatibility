#!/usr/bin/env bash

provider_label() {
  printf 'Ceph\n'
}

provider_image() {
  printf '%s\n' "${CEPH_IMAGE:-quay.io/ceph/demo:latest}"
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
  docker_compose -f "${compose_dir}/docker-compose.yml" up -d
  wait_for_tcp "${WARP_HOST}" 300
  docker exec "$(provider_container_name ceph)" \
    radosgw-admin user create \
      --uid=warp-benchmark \
      --display-name="Warp Benchmark" \
      --access-key="${WARP_ACCESS_KEY}" \
      --secret="${WARP_SECRET_KEY}" >/dev/null 2>&1 || true
}

provider_stop() {
  remove_container "$(provider_container_name ceph)"
}

provider_logs() {
  docker logs "$(provider_container_name ceph)"
}
