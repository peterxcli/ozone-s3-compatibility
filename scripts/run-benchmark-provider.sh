#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"
PROVIDER="${1:-${PROVIDER:-}}"
if [[ -z "${PROVIDER}" ]]; then
  echo "Usage: $0 <provider>" >&2
  exit 2
fi

PROFILE_FILE="${PROFILE_FILE:-${ROOT_DIR}/benchmark/profiles/extended.json}"
OUTPUT_ROOT="${OUTPUT_ROOT:-${ROOT_DIR}/out/benchmark/${PROVIDER}}"
WARP_BINARY="${WARP_BINARY:-${ROOT_DIR}/warp/warp}"
WARP_BUCKET="${WARP_BUCKET:-warp-benchmark-${PROVIDER}}"

source "${ROOT_DIR}/scripts/benchmark/common.sh"
source "${ROOT_DIR}/scripts/benchmark/providers/${PROVIDER}.sh"

mkdir -p "${OUTPUT_ROOT}"
COMMANDS_FILE="${OUTPUT_ROOT}/profile-commands.tsv"
METADATA_FILE="${OUTPUT_ROOT}/metadata.json"

PROVIDER_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PROVIDER_IMAGE="$(provider_image)"
PROVIDER_IMAGE_DIGEST="$(resolve_image "${PROVIDER_IMAGE}")"
PROVIDER_LABEL="$(provider_label)"
STARTUP_SECONDS=0
ADAPTER_STATUS="completed"
export PROVIDER PROVIDER_STARTED_AT PROVIDER_IMAGE PROVIDER_IMAGE_DIGEST PROVIDER_LABEL STARTUP_SECONDS ADAPTER_STATUS

cleanup() {
  provider_stop || true
}
trap cleanup EXIT HUP INT TERM

start_epoch="$(date +%s)"
if ! provider_start "${PROVIDER_IMAGE}"; then
  ADAPTER_STATUS="failed"
fi
STARTUP_SECONDS="$(( $(date +%s) - start_epoch ))"

if [[ "${ADAPTER_STATUS}" != "completed" ]]; then
  benchmark_log "Provider ${PROVIDER} failed to start; metadata will record adapter failure"
fi
export WARP_HOST="${WARP_HOST:-}" WARP_ACCESS_KEY="${WARP_ACCESS_KEY:-}" WARP_SECRET_KEY="${WARP_SECRET_KEY:-}" STARTUP_SECONDS ADAPTER_STATUS

python3 - "${PROFILE_FILE}" "${WARP_BINARY}" "${WARP_HOST:-}" "${WARP_ACCESS_KEY:-}" "${WARP_SECRET_KEY:-}" "${WARP_BUCKET}" "${OUTPUT_ROOT}" "${METADATA_FILE}" "${COMMANDS_FILE}" <<'PY'
import json
import shlex
import sys
from pathlib import Path

from scripts.benchmark_profiles import load_profiles, render_warp_command

profile_file = Path(sys.argv[1])
warp_binary, host, access_key, secret_key, bucket = sys.argv[2:7]
output_root = Path(sys.argv[7])
metadata_file = Path(sys.argv[8])
commands_file = Path(sys.argv[9])

profile_rows = []
command_lines = []
for profile in load_profiles(profile_file):
    benchdata = f"{profile.profile_id}.csv.zst"
    analyze_out = f"{profile.profile_id}-timeseries.csv"
    analyze_text = f"{profile.profile_id}-analyze.txt"
    command = render_warp_command(
        warp_binary=warp_binary,
        profile=profile,
        host=host,
        access_key=access_key,
        secret_key=secret_key,
        bucket=bucket,
        benchdata_path=str(output_root / benchdata),
        analyze_out_path=str(output_root / analyze_out),
    )
    record = profile.to_record()
    record.update({
        "command": command,
        "exit_code": None,
        "benchdata": benchdata,
        "analyze_out": analyze_out,
        "analyze_text": analyze_text,
    })
    profile_rows.append(record)
    command_lines.append((profile.profile_id, analyze_text, shlex.join(command)))

metadata_file.write_text(json.dumps({"profiles": profile_rows}, indent=2) + "\n", encoding="utf-8")
commands_file.write_text(
    "".join(f"{profile_id}\t{analyze_text}\t{command}\n" for profile_id, analyze_text, command in command_lines),
    encoding="utf-8",
)
PY

python3 - "${METADATA_FILE}" <<PY
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = json.loads(path.read_text(encoding="utf-8"))
payload.update({
    "provider": os.environ["PROVIDER"],
    "label": os.environ["PROVIDER_LABEL"],
    "image": os.environ["PROVIDER_IMAGE"],
    "image_tag": os.environ["PROVIDER_IMAGE"].split(":", 1)[1] if ":" in os.environ["PROVIDER_IMAGE"] else "",
    "image_digest": os.environ["PROVIDER_IMAGE_DIGEST"],
    "endpoint": os.environ.get("WARP_HOST", ""),
    "adapter_status": os.environ["ADAPTER_STATUS"],
    "startup_seconds": int(os.environ["STARTUP_SECONDS"]),
    "started_at": os.environ["PROVIDER_STARTED_AT"],
    "log_file": "provider.log",
})
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

if [[ "${ADAPTER_STATUS}" == "completed" ]]; then
  while IFS=$'\t' read -r profile_id analyze_text command_line; do
    benchmark_log "Running ${PROVIDER} ${profile_id}"
    set +e
    eval "${command_line}" >"${OUTPUT_ROOT}/${analyze_text}" 2>&1
    exit_code="$?"
    set -e
    python3 - "${METADATA_FILE}" "${profile_id}" "${exit_code}" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
profile_id = sys.argv[2]
exit_code = int(sys.argv[3])
payload = json.loads(path.read_text(encoding="utf-8"))
for profile in payload["profiles"]:
    if profile["profile_id"] == profile_id:
        profile["exit_code"] = exit_code
        break
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
  done < "${COMMANDS_FILE}"
fi

provider_logs > "${OUTPUT_ROOT}/provider.log" 2>&1 || true
benchmark_log "Provider artifact written to ${OUTPUT_ROOT}"
