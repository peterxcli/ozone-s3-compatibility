#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/common.sh"
nightly_load_state

suite_exit=0
venv_dir="${WORK_DIR}/venv"

nightly_log "Preparing s3-tests environment"
if ! python3 -m venv "${venv_dir}"; then
  suite_exit=1
else
  # shellcheck disable=SC1091
  source "${venv_dir}/bin/activate"
  if ! python -m pip install --upgrade pip setuptools wheel; then
    suite_exit=1
  elif ! python -m pip install -r "${WORK_DIR}/s3-tests/requirements.txt"; then
    suite_exit=1
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

if [[ ${suite_exit} -eq 0 ]]; then
  export S3TEST_CONF="${RAW_DIR}/s3-tests/s3tests.conf"
  pushd "${WORK_DIR}/s3-tests" >/dev/null
  nightly_log "Running s3-tests selection: ${S3_TESTS_ARGS}"
  set +e
  python -m pytest --junitxml "${RAW_DIR}/s3-tests/junit.xml" ${S3_TESTS_ARGS} \
    2>&1 | tee "${RAW_DIR}/s3-tests/pytest.log"
  suite_exit=${PIPESTATUS[0]}
  set -e
  popd >/dev/null
fi

if [[ -n "${VIRTUAL_ENV:-}" ]]; then
  deactivate || true
fi

nightly_save_state S3_TESTS_EXIT "${suite_exit}"
nightly_log "s3-tests finished with exit code ${suite_exit}"
