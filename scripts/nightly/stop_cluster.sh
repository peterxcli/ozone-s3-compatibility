#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/common.sh"

nightly_log "Stopping Ozone cluster"
nightly_stop_cluster_impl
