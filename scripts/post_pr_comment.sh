#!/usr/bin/env bash
set -euo pipefail

COMMENT_MARKDOWN="${PR_COMMENT_MARKDOWN:-out/pr-run/pr-comment.md}"
COMMENT_BODY_PATH="${COMMENT_BODY_PATH:-out/pr-run/comment-body.md}"
COMMENT_PAYLOAD_PATH="${COMMENT_PAYLOAD_PATH:-out/pr-run/comment-payload.json}"

post_comment="${POST_COMMENT_INPUT:-true}"
if [ "${post_comment}" = "false" ]; then
  echo "post_comment is false; leaving markdown in the workflow artifact."
  exit 0
fi

if [ ! -f "${COMMENT_MARKDOWN}" ]; then
  echo "::warning::Missing PR comment markdown at ${COMMENT_MARKDOWN}; skipping PR comment."
  exit 0
fi

missing=()
if [ -z "${OZONE_OWNER:-}" ]; then
  missing+=("OZONE_OWNER")
fi
if [ -z "${OZONE_REPO_NAME:-}" ]; then
  missing+=("OZONE_REPO_NAME")
fi
if [ -z "${OZONE_PR_NUMBER:-}" ]; then
  missing+=("OZONE_PR_NUMBER")
fi
if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::Missing required PR comment environment: ${missing[*]}"
  exit 1
fi

target_repo="${OZONE_OWNER}/${OZONE_REPO_NAME}"
current_repo="${GITHUB_REPOSITORY:-}"
comment_token=""
token_source=""

if [ -n "${OZONE_PR_COMMENT_TOKEN:-}" ]; then
  comment_token="${OZONE_PR_COMMENT_TOKEN}"
  token_source="OZONE_PR_COMMENT_TOKEN"
elif [ -n "${GITHUB_TOKEN:-}" ] && [ "${target_repo}" = "${current_repo}" ]; then
  comment_token="${GITHUB_TOKEN}"
  token_source="GITHUB_TOKEN"
fi

if [ -z "${comment_token}" ]; then
  if [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${current_repo}" ] && [ "${target_repo}" != "${current_repo}" ]; then
    echo "::warning::Missing OZONE_PR_COMMENT_TOKEN for ${target_repo}; not using GITHUB_TOKEN from ${current_repo} because it cannot comment across repositories."
  else
    echo "::warning::Missing OZONE_PR_COMMENT_TOKEN or GITHUB_TOKEN; leaving markdown in the workflow artifact."
  fi
  cat "${COMMENT_MARKDOWN}"
  exit 0
fi

export GH_TOKEN="${comment_token}"
echo "Posting PR comment to ${target_repo}#${OZONE_PR_NUMBER} using ${token_source}."

mkdir -p "$(dirname "${COMMENT_BODY_PATH}")" "$(dirname "${COMMENT_PAYLOAD_PATH}")"
{
  echo "<!-- ozone-s3-compatibility-bot -->"
  echo "<details>"
  echo "<summary>Apache Ozone S3 compatibility result</summary>"
  echo
  sed '/^<!-- ozone-s3-compatibility-bot -->$/d' "${COMMENT_MARKDOWN}"
  echo
  echo "</details>"
} > "${COMMENT_BODY_PATH}"

jq -n --rawfile body "${COMMENT_BODY_PATH}" '{body: $body}' > "${COMMENT_PAYLOAD_PATH}"
if ! gh api \
  --method POST \
  "repos/${OZONE_OWNER}/${OZONE_REPO_NAME}/issues/${OZONE_PR_NUMBER}/comments" \
  --input "${COMMENT_PAYLOAD_PATH}"; then
  echo "::warning::Failed to post PR comment to ${target_repo}#${OZONE_PR_NUMBER}; leaving markdown in the workflow artifact."
  cat "${COMMENT_BODY_PATH}"
  exit 0
fi
